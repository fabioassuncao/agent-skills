import { resolveAgentSessionDeps } from '../agents/session/context.js';
import { listAgentSessions } from '../agents/session/open.js';
import { type AgentSession, isLiveSession } from '../agents/session/types.js';
import { loadGlobalConfig } from '../config/sources.js';
import { loadWebConfig } from '../config.js';
import { holdForHuman } from '../core/human-hold.js';
import {
  fetchFailedRunLog,
  type PullRequestEntry,
  startPullRequestMonitor,
  syncPullRequests,
} from '../issues/github/index.js';
import {
  defaultProjectInitDeps,
  ProjectInitTracker,
  runProjectInit,
} from '../runtime/project-init.js';
import { ProjectManager } from '../runtime/project-manager.js';
import type { ProjectRuntimeLike } from '../runtime/project-runtime.js';
import { createTmuxGateway } from '../runtime/tmux/gateway.js';
import { buildProjectSessionName, buildWorktreeWindowName } from '../runtime/tmux/names.js';
import type { WebConfig } from '../schemas.js';
import { createProjectRegistry } from '../storage/projects/registry.js';
import { resolveProjectPaths } from '../storage/resolve.js';
import { printWarning } from '../ui/logger.js';
import { getProjectRootOf, isGitRepository } from '../utils/git.js';
import { ensureSingleWebServer } from '../web/lock.js';
import { type ProjectsApiDeps, repositoryNeedsSetup } from '../web/projects-api.js';
import { watchSessionDirectory } from '../web/session-directory.js';
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
 * Steps 4's loops are no-ops today: reconciliation, worktree GC and the PR/CI
 * poll arrive with later phases, and writing weaker versions of them here would
 * be the duplication the absorption exists to avoid.
 */

/** Extra project roots for a service unit, which has no useful cwd. */
export const PROJECT_DIR_ENV = 'ISSUE_FLOW_PROJECT_DIR';

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
  const sessionDepsCache = new Map<string, Promise<SessionsApiProject>>();
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
      const served =
        projectId === null
          ? manager.list().length === 1
            ? manager.list()[0]
            : null
          : manager.getById(projectId);
      if (served === undefined || served === null) return null;
      const cached = sessionDepsCache.get(served.entry.id);
      if (cached !== undefined) return cached;
      const built = resolveAgentSessionDeps({ projectRoot: served.entry.root }).then((context) => ({
        projectId: context.projectId,
        deps: context.deps,
        services: context.services,
      }));
      sessionDepsCache.set(served.entry.id, built);
      return built;
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
    sessionId: string | null;
    branch: string | null;
  }): Promise<{ project: SessionsApiProject; session: AgentSession } | null> {
    if (input.sessionId === null && input.branch === null) return null;
    for (const served of manager.list()) {
      const project = await agentSessions.resolveProject(served.entry.id).catch(() => null);
      if (project === null) continue;
      const found = (await listAgentSessions(project.deps.storage).catch(() => [])).find(
        (session) => matchesTerminalRequest(session, input),
      );
      if (found !== undefined) return { project, session: found };
    }
    return null;
  }

  const handle = await ensureSingleWebServer({
    sessions,
    projects,
    agentSessions,
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
    info: noop,
    warn: noop,
  });

  if (handle === null) {
    sessions.close();
    return 1;
  }

  if (handle.server === undefined) {
    // Another instance already owns the lock: nothing to serve here, so this
    // process exits instead of idling as a redundant detached server.
    sessions.close();
    return 0;
  }

  // Only now, with the socket bound: a slow project must not delay the moment
  // the dashboard starts answering.
  await loadProjects(manager, { cwd, env, projectDirs: options.project ?? [] });

  const originalClose = handle.close;
  handle.close = async () => {
    await originalClose();
    for (const stop of pullRequestMonitors.values()) stop();
    pullRequestMonitors.clear();
    sessions.close();
  };

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
