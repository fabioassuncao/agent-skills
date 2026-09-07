import { networkInterfaces as getNetworkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import {
  type ResolvedAgentSessionContext,
  resolveAgentSessionDeps,
} from '../agents/session/context.js';
import { listAgentSessions } from '../agents/session/open.js';
import { projectAgentSessionTabs } from '../agents/session/tabs.js';
import { type AgentSession, isLiveSession } from '../agents/session/types.js';
import { autoRemoveManagedWorktree } from '../agents/session/worktree-control.js';
import { loadGlobalConfig } from '../config/sources.js';
import {
  linearApiKey,
  loadAgentConfig,
  loadGitHubConfig,
  loadLinearConfig,
  loadWebConfig,
} from '../config.js';
import { holdForHuman } from '../core/human-hold.js';
import {
  DEFAULT_SYNC_INTERVAL_MS,
  fetchBranchPullRequestStates,
  fetchFailedRunLog,
  type PullRequestEntry,
  startPullRequestMonitor,
  syncPullRequests,
} from '../issues/github/index.js';
import {
  createLinearClient,
  LINEAR_AUTO_CREATE_INTERVAL_MS,
  redactLinearError,
  redactLinearPayload,
  runLinearAutoCreateOnce,
} from '../issues/linear/index.js';
import {
  defaultProjectInitDeps,
  ProjectInitTracker,
  runProjectInit,
} from '../runtime/project-init.js';
import { ProjectManager } from '../runtime/project-manager.js';
import type { ProjectRuntimeLike } from '../runtime/project-runtime.js';
import { createTmuxGateway } from '../runtime/tmux/gateway.js';
import {
  buildProjectSessionName,
  buildWorktreeParkingWindowName,
  buildWorktreeWindowName,
} from '../runtime/tmux/names.js';
import { runAutoRemove } from '../runtime/worktree/gc.js';
import type { WebConfig } from '../schemas.js';
import { createProjectRegistry } from '../storage/projects/registry.js';
import { resolveProjectPaths } from '../storage/resolve.js';
import { printError, printInfo, printSubsystem, printWarning } from '../ui/logger.js';
import { startSerializedInterval } from '../utils/async.js';
import { getProjectRootOf, isGitRepository } from '../utils/git.js';
import type { AgentsApiDeps } from '../web/agents-api.js';
import type { IntegrationsApiDeps } from '../web/integrations-api.js';
import { ensureSingleWebServer } from '../web/lock.js';
import { type ProjectsApiDeps, repositoryNeedsSetup } from '../web/projects-api.js';
import type { WebServerHandle } from '../web/server.js';
import {
  DEFAULT_POLL_INTERVAL_MS,
  type SessionDirectoryHandle,
  watchSessionDirectory,
} from '../web/session-directory.js';
import type { SessionsApiDeps, SessionsApiProject } from '../web/sessions-api.js';
import type { WorktreesApiDeps } from '../web/worktrees-api.js';

/**
 * `issue-flow serve` — one permanent monitor for every curated project (§47.4).
 *
 * It is the same process `issue-flow web serve` already was, and it still owns
 * the same `web.lock`: one server per machine, claimed after a successful bind.
 * What is new is what it serves — the curated project list rather than only
 * whatever happened to be executing.
 *
 * The boot order is the upstream's, and each step is where it is for a reason:
 *
 * 1. bind first, so the dashboard answers while the projects are still loading;
 * 2. load the curated projects, skipping (never aborting on) the ones that fail;
 * 3. auto-add the current repository *ephemerally* — served now, not written,
 *    so no other server on this machine inherits it on its next restart;
 * 4. light loops for every project, heavy loops only for the active one.
 *
 * Linear pickup and merged-worktree GC are headless maintenance loops: they
 * run even with no dashboard open, through the canonical lifecycle services.
 */

/** Extra project roots for a service unit, which has no useful cwd. */
export const PROJECT_DIR_ENV = 'ISSUE_FLOW_PROJECT_DIR';

/** One serialized cadence for both optional headless maintenance passes. */
export const SERVE_MAINTENANCE_INTERVAL_MS = LINEAR_AUTO_CREATE_INTERVAL_MS;

export interface ProjectMaintenanceDeps {
  context: ResolvedAgentSessionContext;
  env: NodeJS.ProcessEnv;
  linearProcessed: Set<string>;
  createLinear?: typeof createLinearClient;
  pullRequestStates?: typeof fetchBranchPullRequestStates;
  autoRemove?: typeof runAutoRemove;
  signal?: AbortSignal;
}

/** Run one project's enabled headless integrations without opening a second lifecycle path. */
export async function runProjectMaintenance(deps: ProjectMaintenanceDeps): Promise<void> {
  const [linear, github, agent] = await Promise.all([
    loadLinearConfig({ projectRoot: deps.context.projectRoot, env: deps.env }),
    loadGitHubConfig({ projectRoot: deps.context.projectRoot, env: deps.env }),
    loadAgentConfig({ projectRoot: deps.context.projectRoot, env: deps.env }),
  ]);

  if (deps.signal?.aborted) return;

  if (!linear.enabled || !linear.autoCreateWorktrees) {
    // A later false → true transition is a fresh pickup epoch. Tickets whose
    // prior attempt failed must not remain suppressed across re-enablement.
    deps.linearProcessed.clear();
  } else {
    const key = linearApiKey(deps.env);
    if (key !== null) {
      try {
        const upstreamClient = (deps.createLinear ?? createLinearClient)({ apiKey: key });
        await runLinearAutoCreateOnce({
          context: deps.context,
          client: {
            fetchAssignedIssues: async (options) =>
              redactLinearPayload(await upstreamClient.fetchAssignedIssues(options), key),
            postConversation: async (target, input) =>
              redactLinearPayload(await upstreamClient.postConversation(target, input), key),
          },
          agentId: agent.provider,
          watchTeams: linear.watchTeams,
          processed: deps.linearProcessed,
          signal: deps.signal,
          onInfo: (message) => printSubsystem('linear', message),
          onError: (message) => printWarning(redactLinearError(message, key)),
        });
      } catch (error) {
        if (deps.signal?.aborted) return;
        // Linear availability is independent of GitHub GC. One upstream must
        // not suppress the other maintenance pass for this cadence.
        printWarning(`Linear maintenance failed: ${redactLinearError(error, key)}`);
      }
    }
  }

  if (deps.signal?.aborted) return;
  if (github.autoRemoveOnMerge) {
    const pullRequestEvidence = () =>
      (deps.pullRequestStates ?? fetchBranchPullRequestStates)(github.linkedRepos, {
        cwd: deps.context.projectRoot,
      });
    await (deps.autoRemove ?? runAutoRemove)({
      worktrees: deps.context.worktrees,
      git: deps.context.git,
      projectRoot: deps.context.projectRoot,
      branchPullRequestStates: pullRequestEvidence,
      removeCandidate: async (worktree) => {
        if (worktree.binding === null) return 'identity-changed';
        return autoRemoveManagedWorktree(deps.context, worktree.branch, {
          expected: { path: worktree.path, worktreeId: worktree.binding.worktreeId },
          pullRequestEvidence,
        });
      },
      onInfo: (message) => printSubsystem('worktree-gc', message),
      onError: (message) => printWarning(message),
    });
  }
}

export interface RunServeOptions {
  port?: number;
  host?: string;
  refresh?: number;
  /** Additional repositories to serve for this process only. Repeatable. */
  project?: string[];
  /** Environment source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Working directory considered for the auto-add. Defaults to process.cwd(). */
  cwd?: string;
  /** Network inventory seam. The pure formatter receives its result. */
  networkInterfaces?: typeof getNetworkInterfaces;
}

export function listNetworkUrls(
  port: number,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal || seen.has(address.address)) continue;
      seen.add(address.address);
      urls.push(`http://${address.address}:${port}`);
    }
  }
  return urls;
}

interface ObservedRun {
  status: string;
  phase: string | null;
  description: string;
}

/**
 * Report only lifecycle changes a person follows in an all-day serve window.
 * Snapshot writes happen far more often; filtering to open/status/phase/close
 * is what keeps this from becoming an agent-event firehose.
 */
export function startServeActivityLogging(
  sessions: Pick<SessionDirectoryHandle, 'sessions' | 'getSession' | 'subscribe'>,
  log: (subsystem: string, message: string) => void = printSubsystem,
): () => void {
  const observed = new Map<string, ObservedRun>();

  const describe = (sessionId: string): ObservedRun | null => {
    const session = sessions.getSession(sessionId);
    if (session === undefined) return null;
    const snapshot = session.snapshot;
    const branch = snapshot.repository.branch ?? snapshot.git.branch ?? 'unknown';
    return {
      status: snapshot.status,
      phase: snapshot.currentPhase,
      description: `project=${session.projectId} run=${sessionId} branch=${branch}`,
    };
  };

  for (const session of sessions.sessions()) {
    const id = session.snapshot.sessionId;
    if (id === null) continue;
    const state = describe(id);
    if (state !== null) observed.set(id, state);
  }

  return sessions.subscribe((change) => {
    for (const id of change.added) {
      const state = describe(id);
      if (state === null) continue;
      observed.set(id, state);
      log('run:open', state.description);
    }
    for (const id of change.updated) {
      const state = describe(id);
      if (state === null) continue;
      const previous = observed.get(id);
      observed.set(id, state);
      if (previous === undefined) {
        log('run:open', state.description);
      } else if (previous.status !== state.status || previous.phase !== state.phase) {
        log(
          'run:state',
          `${state.description} status=${state.status} phase=${state.phase ?? 'none'}`,
        );
      }
    }
    for (const id of change.removed) {
      const previous = observed.get(id);
      observed.delete(id);
      log('run:close', previous?.description ?? `run=${id}`);
    }
  });
}

export function installServeShutdown(
  handle: WebServerHandle,
  deps: {
    stopMaintenance: () => Promise<void>;
    stopActivityLogging: () => void;
    stopPullRequestMonitors: () => void;
    closeSessions: () => void;
  },
): void {
  const originalClose = handle.close;
  let closePromise: Promise<void> | null = null;
  handle.close = () => {
    closePromise ??= (async () => {
      await deps.stopMaintenance();
      deps.stopActivityLogging();
      deps.stopPullRequestMonitors();
      deps.closeSessions();
      await originalClose();
    })();
    return closePromise;
  };
}

/**
 * Read `ISSUE_FLOW_PROJECT_DIR`.
 *
 * ADAPT of `WEBMUX_PROJECT_DIR`. A `systemd` unit or a launch agent starts in
 * `/`, so "the repository I am standing in" is not a question it can answer —
 * this is how such a deployment names its projects. Several are accepted,
 * separated by the platform's path separator, because one variable per project
 * would not survive contact with a unit file.
 */
export function projectDirsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[PROJECT_DIR_ENV];
  if (raw === undefined) return [];
  return raw
    .split(/[:;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Whether a live session is the one a terminal connection is asking for.
 *
 * Two rules, and both are decisions. **A session id wins over a branch**: the
 * id names one session and the branch names a workspace, so a request that
 * carries both is asking for the session. And **only a live session matches**:
 * a stopped one has no window, so answering with it would hand the viewer an
 * attach that fails instead of a refusal it can explain.
 */
export function matchesTerminalRequest(
  session: AgentSession,
  input: { sessionId: string | null; branch: string | null },
): boolean {
  if (!isLiveSession(session)) return false;
  if (input.sessionId !== null) return session.id === input.sessionId;
  return input.branch !== null && session.branch === input.branch;
}

/** Resolve and authenticate the one active tab a terminal viewer may attach to. */
export async function resolveTerminalSessionForProject(
  project: SessionsApiProject,
  input: { sessionId: string | null; branch: string | null },
): Promise<AgentSession | null> {
  const sessions = await listAgentSessions(project.deps.storage).catch(() => []);
  const worktrees = await project.deps.worktrees.list().catch(() => []);
  const requested =
    input.sessionId !== null
      ? sessions.find((session) => matchesTerminalRequest(session, input))
      : input.branch !== null
        ? sessions.find((session) => session.branch === input.branch)
        : undefined;
  if (requested === undefined) return null;
  const binding = worktrees.find((worktree) => worktree.branch === requested.branch)?.binding;
  if (binding === null || binding === undefined) return null;
  const scoped = sessions.filter(
    (session) => session.branch === requested.branch && session.worktreeId === binding.worktreeId,
  );
  const active = projectAgentSessionTabs(scoped, binding).activeSession;
  if (
    active === null ||
    !isLiveSession(active) ||
    (input.sessionId !== null && active.id !== input.sessionId) ||
    active.paneTarget === null ||
    active.paneToken === null ||
    project.deps.tmux.hasPaneStrict === undefined ||
    project.deps.tmux.getPaneIdentity === undefined
  ) {
    return null;
  }
  try {
    if (!(await project.deps.tmux.hasPaneStrict(active.paneTarget))) return null;
    const identity = await project.deps.tmux.getPaneIdentity(active.paneTarget);
    const expectedSession = buildProjectSessionName(project.projectId);
    const expectedMain = buildWorktreeWindowName(active.branch);
    const expectedParking = buildWorktreeParkingWindowName(binding.worktreeId);
    return identity.paneId === active.paneTarget &&
      identity.sessionName === expectedSession &&
      (identity.windowName === expectedMain || identity.windowName === expectedParking) &&
      identity.ownerToken === active.paneToken
      ? active
      : null;
  } catch {
    // Unknown physical identity is a refusal at the attach boundary, never
    // permission to fall back to a row that may now name another process.
    return null;
  }
}

export async function runServe(options: RunServeOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  // Built conditionally, not `{ port: options.port, … }`: loadWebConfig()
  // spreads this over the lower-precedence layers, and an explicit `undefined`
  // would overwrite an env/.issue-flow.json setting instead of falling through.
  const cli: Partial<WebConfig> = {};
  if (options.port !== undefined) cli.port = options.port;
  if (options.host !== undefined) cli.host = options.host;
  if (options.refresh !== undefined) cli.refreshSeconds = options.refresh;
  const webConfig = await loadWebConfig({ cli });

  let storageDriver = (await loadGlobalConfig()).storage?.driver ?? 'sqlite';
  try {
    storageDriver = (await resolveProjectPaths()).storageDriver;
  } catch {
    // The machine-wide monitor stays usable outside a repository.
  }

  const registry = createProjectRegistry();
  const sessions = watchSessionDirectory({ storageDriver, registry });
  const tracker = new ProjectInitTracker();
  const manager = new ProjectManager({
    registry,
    port: webConfig.port,
    warn: printWarning,
  });

  const projects: ProjectsApiDeps = {
    manager,
    registry,
    tracker,
    // Adding a project reaches the filesystem, so it follows the same rule the
    // configuration writes do: loopback bindings only (ADR-10).
    writable: isLoopbackHost(webConfig.host),
    resolveRoot: getProjectRootOf,
    needsSetup: repositoryNeedsSetup,
    startSetup: (root) => {
      void runProjectInit(
        tracker,
        root,
        defaultProjectInitDeps(async (target) => {
          const project = await manager.add(target);
          return { prefix: project.prefix, name: project.entry.name };
        }),
        printWarning,
      );
    },
  };

  // The agent-session surface (§49). Its wiring is per project and expensive
  // to build — a worktree manager, a tmux gateway and a resolved profile map —
  // so it is built on first use and kept: a dashboard opening a session is not
  // a reason to re-read `.issue-flow.json` for every request.
  const runtimeCache = new Map<string, Promise<ResolvedAgentSessionContext>>();
  const resolveServedRuntime = async (
    projectId: string | null,
    profile?: string,
  ): Promise<ResolvedAgentSessionContext | null> => {
    const served =
      projectId === null
        ? manager.list().length === 1
          ? manager.list()[0]
          : null
        : manager.getById(projectId);
    if (served === undefined || served === null) return null;
    const key = `${served.entry.id}\0${profile ?? ''}`;
    const cached = runtimeCache.get(key);
    if (cached !== undefined) return cached;
    const built = resolveAgentSessionDeps({
      projectRoot: served.entry.root,
      ...(profile === undefined ? {} : { profile }),
    });
    runtimeCache.set(key, built);
    return built;
  };
  const agentSessions: SessionsApiDeps = {
    // Opening a session starts a process on this machine and typing into one is
    // a remote shell, so it follows the rule the configuration and project
    // writes already follow: loopback bindings only (ADR-10).
    writable: isLoopbackHost(webConfig.host),
    resolveProject: async (projectId) => {
      // An unprefixed request names no project. With exactly one served, that
      // is not ambiguous and answering it is what keeps a single-project user
      // from having to learn that prefixes exist — the same fallback
      // `GET /api/status` already makes. With several, it genuinely is
      // ambiguous, and guessing would open a session in the wrong repository.
      const context = await resolveServedRuntime(projectId);
      if (context === null) return null;
      return {
        projectId: context.projectId,
        deps: context.deps,
        services: context.services,
      };
    },
    // §49.4. Built through the same `resolveProject`, so the consolidated view
    // and the per-project one can never disagree about a project's wiring; a
    // project whose wiring fails is skipped rather than failing the whole view.
    listProjects: async () => {
      const resolved = await Promise.all(
        manager
          .list()
          .map((served) => agentSessions.resolveProject(served.entry.id).catch(() => null)),
      );
      return resolved.filter((project): project is SessionsApiProject => project !== null);
    },
  };
  const agents: AgentsApiDeps = {
    writable: isLoopbackHost(webConfig.host),
    resolveProject: async (projectId) => {
      const context = await resolveServedRuntime(projectId);
      return context === null ? null : { projectRoot: context.projectRoot };
    },
  };
  const integrations: IntegrationsApiDeps = {
    writable: isLoopbackHost(webConfig.host),
    env,
    resolveRuntime: resolveServedRuntime,
  };

  /* ------------------------------------------------------------------ *
   * Pull Requests and CI (§20).
   *
   * Phase 14 delivered the pass and left `isActive` as "the point where the
   * panel plugs in" — this is that point. The gate is the display-sync policy
   * verbatim: nobody has asked for the session list recently, so nothing is
   * queried and no rate limit is spent. `GET /api/worktrees` is the activity
   * signal because it is the request the open dashboard makes and the one whose
   * answer the Pull Requests decorate.
   * ------------------------------------------------------------------ */
  const noop = (): void => {};
  const DASHBOARD_ACTIVE_MS = 30_000;
  const pullRequestsByProject = new Map<string, Map<string, PullRequestEntry[]>>();
  const lastListedAt = new Map<string, number>();
  const pullRequestMonitors = new Map<string, () => void>();
  const projectRootById = new Map<string, string>();

  function ensurePullRequestMonitor(projectId: string, projectRoot: string): void {
    if (pullRequestMonitors.has(projectId)) return;
    pullRequestMonitors.set(
      projectId,
      startPullRequestMonitor({
        cwd: projectRoot,
        isActive: () => Date.now() - (lastListedAt.get(projectId) ?? 0) < DASHBOARD_ACTIVE_MS,
        onSync: (sync) => {
          pullRequestsByProject.set(projectId, sync.byBranch);
        },
        // A repository with no `gh`, no remote or no auth is not an error the
        // dashboard has to show: the rows simply carry no Pull Request.
        onError: noop,
        onFailure: noop,
      }),
    );
  }

  // The same resolution the session surface uses, so the sidebar's list and the
  // terminal it opens can never disagree about which session a branch is.
  const worktrees: WorktreesApiDeps = {
    writable: isLoopbackHost(webConfig.host),
    env,
    resolveRuntime: resolveServedRuntime,
    resolveProject: async (projectId) => {
      const project = await agentSessions.resolveProject(projectId);
      if (project === null) return null;
      // Recorded here rather than in the route: this is the one call the route
      // makes, and the gate has to see the request even when the list is empty.
      lastListedAt.set(project.projectId, Date.now());
      projectRootById.set(project.projectId, project.deps.projectRoot);
      ensurePullRequestMonitor(project.projectId, project.deps.projectRoot);
      return project;
    },
    pullRequestsFor: (projectId, branch) => pullRequestsByProject.get(projectId)?.get(branch) ?? [],
    syncPullRequests: async (projectId) => {
      const root = projectRootById.get(projectId);
      if (root === undefined) return;
      const sync = await syncPullRequests({ cwd: root, onError: noop }).catch(() => null);
      if (sync !== null) pullRequestsByProject.set(projectId, sync.byBranch);
    },
    ciLog: async (projectId, runId) => {
      const root = projectRootById.get(projectId);
      const result = await fetchFailedRunLog(runId, {
        ...(root === undefined ? {} : { cwd: root }),
      });
      return result.ok ? result.log : result.error;
    },
  };

  /**
   * Find the live session a terminal connection is asking for.
   *
   * Scans the served projects because a session id does not name its project —
   * and asking the client to send one would let a page pick the repository its
   * shell opens in, which is the one thing this lookup exists to decide.
   */
  async function findLiveSession(input: {
    projectPrefix: string | null;
    sessionId: string | null;
    branch: string | null;
  }): Promise<{ project: SessionsApiProject; session: AgentSession } | null> {
    if (input.sessionId === null && input.branch === null) return null;
    const servedProjects =
      input.projectPrefix === null
        ? manager.list()
        : (() => {
            const served = manager.getByPrefix(input.projectPrefix);
            return served === null ? [] : [served];
          })();
    for (const served of servedProjects) {
      const project = await agentSessions.resolveProject(served.entry.id).catch(() => null);
      if (project === null) continue;
      const found = await resolveTerminalSessionForProject(project, input);
      if (found !== null) return { project, session: found };
    }
    return null;
  }

  const handle = await ensureSingleWebServer({
    sessions,
    projects,
    agentSessions,
    agents,
    integrations,
    worktrees,
    // The transport of §15, refused outright off loopback by the module itself
    // (ADR-10). Until this phase nothing turned it on, so the ported terminal
    // had no window to attach to — which is what kept four of Roteiro A's nine
    // flows red however complete their modules were.
    terminal: {
      tmux: createTmuxGateway(),
      resolveTarget: async (input) => {
        const found = await findLiveSession(input);
        if (found === null) return null;
        return {
          ownerSessionName: buildProjectSessionName(found.project.projectId),
          windowName: buildWorktreeWindowName(found.session.branch),
          ...(found.session.paneTarget?.startsWith('%') === true
            ? { paneTarget: found.session.paneTarget }
            : {}),
        };
      },
      // §32, and the whole of the takeover mechanism: no confirmation and no
      // mode switch — a person typing **is** the signal. Only a session that
      // belongs to a run can be taken over; there is nothing automatic to stop
      // in a free session (§49.2).
      onHumanInput: (input) => {
        void findLiveSession(input).then(async (found) => {
          if (found === null || found.session.runId === null) return;
          await holdForHuman(found.project.deps.storage, {
            runId: found.session.runId,
            reason: 'takeover',
          }).catch(() => undefined);
        });
      },
    },
    port: webConfig.port,
    host: webConfig.host,
    refreshSeconds: webConfig.refreshSeconds,
    unref: false,
    // Not silenced. `web serve` could afford to say nothing because it is spawned
    // detached with `stdio: 'ignore'` and nobody is watching; `serve` is a command
    // a person types, and a foreground server that prints nothing is
    // indistinguishable from one that hung.
    info: printInfo,
    warn: printWarning,
  });

  if (handle === null) {
    printError(
      `Could not start the monitor on ${webConfig.host}:${webConfig.port}. The port may be held by an unrelated process, or the host may not be bindable.`,
    );
    sessions.close();
    return 1;
  }

  if (handle.server === undefined) {
    // Another instance already owns the lock: nothing to serve here, so this
    // process exits instead of idling as a redundant detached server. The URL
    // was already reported by `ensureSingleWebServer`; what is worth adding is
    // that *this* invocation is over, so the shell prompt coming back is the
    // expected outcome and not a crash.
    printInfo('This invocation has nothing to serve and is exiting; the monitor above stays up.');
    sessions.close();
    return 0;
  }

  if (!isLoopbackHost(handle.host)) {
    const interfaces = (options.networkInterfaces ?? getNetworkInterfaces)();
    for (const url of listNetworkUrls(handle.port, interfaces)) {
      printSubsystem('serve', `Network: ${url}`);
    }
  }

  printSubsystem(
    'session-directory',
    `monitor started (filesystem push; fallback interval: ${DEFAULT_POLL_INTERVAL_MS}ms)`,
  );
  printSubsystem(
    'pr-ci',
    `monitor ready (interval: ${DEFAULT_SYNC_INTERVAL_MS}ms; activity-gated; starts on first dashboard list)`,
  );
  printSubsystem('reconciliation', 'on demand (no periodic poll)');
  printSubsystem(
    'worktree-gc',
    `scheduled (interval: ${SERVE_MAINTENANCE_INTERVAL_MS}ms; enabled per project)`,
  );
  const stopActivityLogging = startServeActivityLogging(sessions);

  // The URL itself was already reported by the bind, so this only adds what a
  // foreground command still has to say: that it is not going to return.
  printInfo('The monitor stays in the foreground; press Ctrl+C to stop it.');

  // Only now, with the socket bound: a slow project must not delay the moment
  // the dashboard starts answering.
  await loadProjects(manager, { cwd, env, projectDirs: options.project ?? [] });

  const served = manager.list().length;
  printInfo(served === 1 ? 'Serving 1 project.' : `Serving ${served} projects.`);

  const linearProcessed = new Map<string, Set<string>>();
  const stopMaintenance = startSerializedInterval(async (signal) => {
    for (const project of manager.list()) {
      if (signal.aborted) return;
      const context = await resolveServedRuntime(project.entry.id).catch((error: unknown) => {
        if (signal.aborted) return null;
        printWarning(
          `Skipping maintenance for project ${project.entry.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
      if (context === null) continue;
      const processed = linearProcessed.get(project.entry.id) ?? new Set<string>();
      linearProcessed.set(project.entry.id, processed);
      await runProjectMaintenance({ context, env, linearProcessed: processed, signal }).catch(
        (error: unknown) => {
          if (signal.aborted) return;
          printWarning(
            `Project maintenance failed for ${project.entry.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    }
  }, SERVE_MAINTENANCE_INTERVAL_MS);

  installServeShutdown(handle, {
    stopMaintenance,
    stopActivityLogging,
    stopPullRequestMonitors: () => {
      for (const stop of pullRequestMonitors.values()) stop();
      pullRequestMonitors.clear();
    },
    closeSessions: () => sessions.close(),
  });

  return 0;
}

interface LoadProjectsInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  projectDirs: string[];
  /** Repository probe. Injected so the boot can be tested without real repos. */
  isRepository?: (path: string) => Promise<boolean>;
}

/** Steps 2 and 3 of the boot order, extracted so they can be tested alone. */
export async function loadProjects<R extends ProjectRuntimeLike>(
  manager: ProjectManager<R>,
  input: LoadProjectsInput,
): Promise<void> {
  await manager.loadPersisted();

  // `--project` and ISSUE_FLOW_PROJECT_DIR are served for this process only,
  // for the same reason the cwd is: naming a repository on one server's command
  // line must not enlist it into every other server on the machine.
  for (const dir of [...input.projectDirs, ...projectDirsFromEnv(input.env)]) {
    try {
      await manager.addEphemeral(dir);
    } catch (error: unknown) {
      printWarning(
        `Skipping project ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await autoAddCwd(manager, input.cwd, input.isRepository);
}

/**
 * Serve the repository the server was started in, if it is one.
 *
 * Ephemeral by construction (PORT of `autoAddCwd`): the project is served for
 * as long as this process lives and never enters the curated list, so no other
 * server on this machine reloads it. A repository that is already curated is
 * found by root and returned unchanged, so this never demotes anything.
 *
 * It does not follow that the database stays untouched: resolving the storage
 * of a repository has always adopted it (`storage/resolve.ts`), which is what
 * creates its `discovered` row. That row predates the registry and is the same
 * one a plain `issue-flow run` leaves behind — `ephemeral` is about curation,
 * not about whether the project has ever been seen.
 */
export async function autoAddCwd<R extends ProjectRuntimeLike>(
  manager: ProjectManager<R>,
  cwd: string,
  isRepository: (path: string) => Promise<boolean> = isGitRepository,
): Promise<void> {
  if (!(await isRepository(cwd))) return;
  try {
    await manager.addEphemeral(cwd);
  } catch (error: unknown) {
    printWarning(
      `Could not serve the current repository: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
