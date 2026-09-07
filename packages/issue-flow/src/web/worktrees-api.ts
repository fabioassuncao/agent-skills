import { basename } from 'node:path';
import { z } from 'zod';
import {
  findRegisteredAgent,
  listAgentSummaries,
  type RegisteredAgent,
} from '../agents/custom-registry.js';
import { runnerFor } from '../agents/registry.js';
import { resolveAgentFor } from '../agents/resolve.js';
import type { ResolvedAgentSessionContext } from '../agents/session/context.js';
import {
  AgentSessionError,
  listAgentSessions,
  openAgentSession,
  sendToAgentSession,
} from '../agents/session/open.js';
import {
  AgentTabError,
  createAgentTab,
  deleteAgentTab,
  projectAgentSessionTabs,
  reconcileAgentTabPanes,
  refreshActiveAgentTab,
  selectAgentTab,
} from '../agents/session/tabs.js';
import { type AgentSession, isLiveSession } from '../agents/session/types.js';
import {
  mergeManagedWorktree,
  openManagedWorktrees,
  removeManagedWorktree,
  setManagedWorktreeArchived,
  setManagedWorktreeLabel,
  setManagedWorktreeProfile,
  stopLiveSessions,
} from '../agents/session/worktree-control.js';
import { loadCustomAgentsConfig } from '../config/custom-agents.js';
import { loadAgentConfig, loadAutoNameConfig, loadGitHubConfig } from '../config.js';
import { autoNameBranch, type BranchNameGenerator } from '../conventions/git/auto-name.js';
import type { PullRequestEntry } from '../issues/github/index.js';
import { createPortProbe, type PortProbe, probeServices } from '../runtime/services.js';
import {
  listAvailableWorktreeBranches,
  listWorktreeBaseBranches,
} from '../runtime/worktree/branches.js';
import { pullMainBranch } from '../runtime/worktree/gc.js';
import { readGitWorktreeStatus } from '../runtime/worktree/git.js';
import { WorktreeError } from '../runtime/worktree/lifecycle.js';
import type { StoredWorktree } from '../storage/db/repository.js';
import { resolvedIntegrationSettings } from './integrations-api.js';
import type { ApiResponse } from './projects-api.js';
import type { SessionsApiDeps, SessionsApiProject } from './sessions-api.js';

/**
 * `GET /api/worktrees` — the sidebar's second group, and the tab a Task uses to
 * list its own workspaces.
 *
 * **This is a projection of `agent_sessions`, not a second worktree registry.**
 * §25 asks for one implementation per responsibility: the worktree belongs to
 * `runtime/worktree/`, the intent to use it belongs to `agent_sessions`
 * (ADR-08/ADR-16), and this module only joins the two into the wire shape the
 * ported sidebar already knows how to render. Building a parallel list here is
 * precisely how the two would start disagreeing about which branch is open.
 *
 * `executionId` is the row's `runId`, and the run id **is** the dashboard's
 * `sessionId` (`web/session-directory.ts` passes one as the other). That single
 * equality is what makes §50.5's rule true without a second screen: a Task
 * lists its own sessions and worktrees by filtering this list on its own id,
 * and a free session that was later linked to an issue starts carrying an
 * `executionId` and therefore starts showing the workflow — no promotion event,
 * no second component, just the field becoming non-null (I1, I4).
 *
 * Read-only on purpose. Creating a worktree here is opening a session
 * (`POST /api/sessions`), which is the same act in the unified model: a session
 * *contains* its worktree, so a second creation route would be a worktree
 * nobody is working in.
 */

export interface WorktreesApiDeps extends Pick<SessionsApiDeps, 'resolveProject'> {
  /** Mutations are process control and are enabled only by a loopback server. */
  writable?: boolean;
  /** Environment used by optional integrations. Injected in tests. */
  env?: NodeJS.ProcessEnv;
  /** Provider adapter for canonical auto-name. Injected by tests. */
  generateBranchName?: BranchNameGenerator;
  /** Canonical runtime wiring, optionally resolved for a requested profile. */
  resolveRuntime?: (
    projectId: string | null,
    profile?: string,
  ) => Promise<ResolvedAgentSessionContext | null>;
  /**
   * Pull Requests the display sync of §20 has seen for a branch.
   *
   * A dependency, not a query made here: `issues/github/monitor.ts` is the one
   * implementation of that pass, its cost is a rate limit and its policy is the
   * activity gate. What reaches the row is what was **observed** — a monitor
   * with no sync behind it answers nothing rather than an invented state.
   */
  pullRequestsFor?: (projectId: string, branch: string) => readonly PullRequestEntry[];
  /**
   * Force one synchronisation pass now, outside the activity gate.
   *
   * The manual "sync" of §20: the gate exists so an unwatched dashboard spends
   * no rate limit, and a person clicking is the one case where the gate has
   * nothing to decide.
   */
  syncPullRequests?: (projectId: string) => Promise<void>;
  /** Read the failed steps of a CI run (`gh run view --log-failed`). */
  ciLog?: (projectId: string, runId: number) => Promise<string>;
  /** Port probe for service health. Injected so tests never touch a socket. */
  probe?: PortProbe;
  /** Clock, for `elapsed`. */
  now?: () => number;
}

/** Empty rather than 404: one dashboard build serves monitors with and without. */
const EMPTY: ApiResponse = { status: 200, body: { worktrees: [] } };

const NOT_CONFIGURED: ApiResponse = {
  status: 501,
  body: { error: 'This monitor does not serve worktree operations.' },
};
const NOT_WRITABLE: ApiResponse = {
  status: 403,
  body: { error: 'Worktrees can only be changed from a monitor bound to loopback.' },
};

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

async function resolveRegisteredAgent(
  context: ResolvedAgentSessionContext,
  id: string,
): Promise<RegisteredAgent | null> {
  return findRegisteredAgent(
    await loadCustomAgentsConfig({ projectRoot: context.projectRoot }),
    id,
  );
}

function invalidBody(error: z.ZodError): ApiResponse {
  return {
    status: 400,
    body: { error: error.issues[0]?.message ?? 'Invalid request body.' },
  };
}

function apiError(error: unknown): ApiResponse {
  if (
    error instanceof WorktreeError ||
    error instanceof AgentSessionError ||
    error instanceof AgentTabError
  ) {
    return { status: error.status, body: { error: error.message } };
  }
  const status = (error as { status?: unknown })?.status;
  return {
    status: typeof status === 'number' ? status : 500,
    body: { error: error instanceof Error ? error.message : String(error) },
  };
}

async function runtime(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  profile?: string,
): Promise<ResolvedAgentSessionContext | ApiResponse> {
  const blocked = mutationGate(deps);
  if (blocked !== null) return blocked;
  return (await deps!.resolveRuntime!(projectId, profile)) ?? NOT_CONFIGURED;
}

function mutationGate(deps: WorktreesApiDeps | null): ApiResponse | null {
  if (deps === null) return NOT_CONFIGURED;
  if (deps.writable !== true) return NOT_WRITABLE;
  if (deps.resolveRuntime === undefined) return NOT_CONFIGURED;
  return null;
}

function isResponse(value: ResolvedAgentSessionContext | ApiResponse): value is ApiResponse {
  return 'status' in value && 'body' in value;
}

/** `starting`/`running`/`idle`/`stopped`/`orphaned` → the panel's vocabulary. */
export function sessionStatusToWorktreeStatus(session: AgentSession): string {
  switch (session.status) {
    case 'starting':
      return 'starting';
    case 'running':
      return 'running';
    case 'idle':
      return 'idle';
    case 'orphaned':
      return 'error';
    default:
      return 'stopped';
  }
}

/**
 * `elapsed` as the sidebar shows it: since the session was last touched.
 *
 * Coarse on purpose — the row is a caption, and a live seconds counter belongs
 * to the clock in `App.svelte`, not to a payload that would then have to be
 * refetched to advance.
 */
export function formatElapsed(fromIso: string, nowMs: number): string {
  const started = Date.parse(fromIso);
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.round((nowMs - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

interface RowInput {
  session: AgentSession;
  sessions: readonly AgentSession[];
  project: SessionsApiProject;
  deps: WorktreesApiDeps;
  probe: PortProbe;
  nowMs: number;
  binding: StoredWorktree | null;
}

async function buildRow({
  session,
  sessions,
  project,
  deps,
  probe,
  nowMs,
  binding,
}: RowInput): Promise<Record<string, unknown>> {
  const tabProjection = projectAgentSessionTabs(sessions, binding);
  const displayedSession = tabProjection.activeSession ?? session;
  const path = binding?.path ?? '';
  // A worktree whose checkout is gone answers "not dirty" instead of throwing:
  // the row still has to render, and `state: 'orphaned'` is what says so.
  const status =
    path === ''
      ? { dirty: false, aheadCount: 0 }
      : await readGitWorktreeStatus(path).catch(() => ({ dirty: false, aheadCount: 0 }));

  const services =
    project.services.length === 0
      ? []
      : await probeServices(project.services, binding?.allocatedPorts ?? {}, probe, {
          ...(binding?.startupEnvValues ?? {}),
          ...Object.fromEntries(
            Object.entries(binding?.allocatedPorts ?? {}).map(([name, port]) => [
              name,
              String(port),
            ]),
          ),
        });

  return {
    branch: session.branch,
    // The session's caption when it has one; the worktree's otherwise. A
    // workflow session is named by its issue and a free one by whatever the
    // person typed, and neither is the branch.
    label: binding?.label ?? session.label ?? null,
    ...(binding?.baseBranch == null ? {} : { baseBranch: binding.baseBranch }),
    path,
    dir: path,
    archived: binding?.archived ?? false,
    profile: binding?.profile ?? null,
    agentName: displayedSession.provider,
    agentLabel: displayedSession.provider,
    agentTerminalStale: !isLiveSession(displayedSession) || displayedSession.paneTarget === null,
    // A session with a pane is one the terminal can attach to. It is the same
    // question `canConnect` asks in the shell, so it is answered from the pane
    // target rather than re-derived from the status.
    mux: displayedSession.paneTarget !== null && isLiveSession(displayedSession),
    dirty: status.dirty,
    // `aheadCount` is "commits nobody else has"; the row only asks whether there
    // are any.
    unpushed: status.aheadCount > 0,
    paneCount: displayedSession.paneTarget === null ? 0 : 1,
    status: sessionStatusToWorktreeStatus(displayedSession),
    elapsed: formatElapsed(displayedSession.updatedAt, nowMs),
    services: services.map((service) => ({
      name: service.name,
      port: service.port,
      running: service.status === 'ready',
      url: service.url,
    })),
    prs: deps.pullRequestsFor?.(project.projectId, session.branch) ?? [],
    creation: null,
    // `WorktreeSource` is a closed pair: a worktree either came from a oneshot
    // or it came from the interface. There is no third value to invent.
    source: binding?.source === 'oneshot' ? 'oneshot' : 'ui',
    oneshot: null,
    tabs: tabProjection.tabs,
    activeTabId: tabProjection.activeTabId,
    supportsTabs:
      binding?.runtime === 'host' &&
      (displayedSession.provider === 'claude' || displayedSession.provider === 'codex') &&
      displayedSession.phase !== 'review' &&
      displayedSession.phase !== 'pr-review',
    executionId: displayedSession.runId,
    issueRef: null,
  };
}

export async function listWorktreesRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
): Promise<ApiResponse> {
  if (deps === null) return EMPTY;
  const project = await deps.resolveProject(projectId);
  if (project === null) return EMPTY;

  const loadedSessions = await listAgentSessions(project.deps.storage);
  const sessions = await reconcileAgentTabPanes(
    { projectId: project.projectId, storage: project.deps.storage, deps: project.deps },
    loadedSessions,
  ).catch(() => loadedSessions);
  const managed = await project.deps.worktrees.list().catch(() => []);
  const byBranch = new Map(managed.map((entry) => [entry.branch, entry]));
  // Closed work is absent from the active list, except when it was explicitly
  // archived: archive is a durable curation state and its section must remain
  // reachable after closing the window. Keep only the newest row per archived
  // branch, because one branch may have been reopened more than once.
  const bySessionBranch = new Map<string, AgentSession[]>();
  for (const session of sessions) {
    const bucket = bySessionBranch.get(session.branch);
    if (bucket === undefined) bySessionBranch.set(session.branch, [session]);
    else bucket.push(session);
  }
  const visible = [...bySessionBranch.entries()].flatMap(([branch, branchSessions]) => {
    const binding = byBranch.get(branch)?.binding ?? null;
    const scopedSessions =
      binding === null
        ? []
        : branchSessions.filter((session) => session.worktreeId === binding.worktreeId);
    const archived = binding?.archived === true;
    const projection = projectAgentSessionTabs(scopedSessions, binding);
    const rowSession = projection.activeSession ?? projection.rootSession ?? scopedSessions[0];
    return rowSession !== undefined && (scopedSessions.some(isLiveSession) || archived)
      ? [{ session: rowSession, sessions: scopedSessions }]
      : [];
  });
  if (visible.length === 0) return EMPTY;
  const probe = deps.probe ?? createPortProbe();
  const nowMs = deps.now?.() ?? Date.now();

  const worktrees = await Promise.all(
    visible.map(({ session, sessions: branchSessions }) => {
      const entry = byBranch.get(session.branch);
      const stored = entry?.binding ?? null;
      return buildRow({
        session,
        sessions: branchSessions,
        project,
        deps,
        probe,
        nowMs,
        binding: stored === null ? null : { ...stored, path: entry?.path ?? stored.path },
      });
    }),
  );

  return { status: 200, body: { worktrees } };
}

/**
 * `POST /api/worktrees/:name/sync-prs` — refresh this branch's Pull Requests.
 *
 * Answers the refreshed row, which is what the ported client expects: the
 * button that asks for a sync is the one that has to show its result.
 */
export async function syncWorktreePullRequestsRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
): Promise<ApiResponse> {
  if (deps === null)
    return { status: 501, body: { error: 'This monitor does not serve worktrees.' } };
  const project = await deps.resolveProject(projectId);
  if (project === null) {
    return { status: 501, body: { error: 'This monitor does not serve worktrees.' } };
  }

  await deps.syncPullRequests?.(project.projectId);

  const entry = (await project.deps.worktrees.list().catch(() => [])).find(
    (candidate) => candidate.branch === branch,
  );
  const stored = entry?.binding ?? null;
  const branchSessions = (await listAgentSessions(project.deps.storage)).filter(
    (candidate) =>
      candidate.branch === branch && stored !== null && candidate.worktreeId === stored.worktreeId,
  );
  const projection = projectAgentSessionTabs(branchSessions, stored);
  const session =
    projection.activeSession !== null && isLiveSession(projection.activeSession)
      ? projection.activeSession
      : undefined;
  if (session === undefined) {
    return { status: 404, body: { error: `No live session on branch '${branch}'.` } };
  }

  const row = await buildRow({
    session,
    sessions: branchSessions,
    project,
    deps,
    probe: deps.probe ?? createPortProbe(),
    nowMs: deps.now?.() ?? Date.now(),
    binding: stored === null ? null : { ...stored, path: entry?.path ?? stored.path },
  });
  return { status: 200, body: row };
}

/** Match `/api/worktrees/:name/sync-prs`. */
export function matchSyncPullRequests(pathname: string): string | null {
  const match = /^\/api\/worktrees\/([^/]+)\/sync-prs$/.exec(pathname);
  return match === null ? null : decodeURIComponent(match[1] as string);
}

/** Match `/api/ci-logs/:runId`, returning the run id. */
export function matchCiLogs(pathname: string): number | null {
  const match = /^\/api\/ci-logs\/(\d+)$/.exec(pathname);
  if (match === null) return null;
  const runId = Number.parseInt(match[1] as string, 10);
  return Number.isSafeInteger(runId) ? runId : null;
}

/**
 * `GET /api/ci-logs/:runId` — the failed steps of a run.
 *
 * A log that cannot be read answers as an error string in the body rather than
 * as an HTTP failure: the dialog has a place to show *why* there is no log, and
 * a 500 would only tell the user that something broke.
 */
export async function ciLogsRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  runId: number,
): Promise<ApiResponse> {
  if (deps === null || deps.ciLog === undefined) {
    return { status: 501, body: { error: 'This monitor does not serve CI logs.' } };
  }
  const project = await deps.resolveProject(projectId);
  if (project === null) {
    return { status: 501, body: { error: 'This monitor does not serve CI logs.' } };
  }
  return { status: 200, body: { logs: await deps.ciLog(project.projectId, runId) } };
}

const DIFF_LIMIT = 200 * 1024;

export function truncateUtf8(
  value: string,
  byteLimit = DIFF_LIMIT,
): {
  value: string;
  truncated: boolean;
} {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= byteLimit) return { value, truncated: false };
  let end = byteLimit;
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { value: encoded.subarray(0, end).toString('utf8'), truncated: true };
}

const createWorktreeBodySchema = z.object({
  mode: z.enum(['new', 'existing']).optional(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
  profile: z.string().optional(),
  agent: z.string().trim().min(1).optional(),
  agents: z.array(z.string().trim().min(1)).min(1).optional(),
  prompt: z.string().optional(),
  envOverrides: z.record(z.string(), z.string()).optional(),
  issueRef: z.string().trim().min(1).optional(),
  source: z.enum(['ui', 'oneshot']).optional(),
  oneshot: z.object({ autoCloseOnDone: z.boolean().optional() }).optional(),
});
const openWorktreeBodySchema = z.object({
  prompt: z.string().optional(),
  oneshot: z.object({ autoCloseOnDone: z.boolean().optional() }).optional(),
});
const archiveBodySchema = z.object({ archived: z.boolean() });
const labelBodySchema = z.object({ label: z.string().trim().max(80).nullable() });
const profileBodySchema = z.object({ profile: z.string().trim().min(1) });
const sendBodySchema = z.object({ text: z.string().min(1), preamble: z.string().optional() });
const pullMainBodySchema = z.object({ force: z.boolean().optional(), repo: z.string().optional() });

async function generateBranchNameWithConfiguredAgent(
  projectRoot: string,
  env: NodeJS.ProcessEnv | undefined,
  request: Parameters<BranchNameGenerator>[0],
): Promise<string> {
  const config = await loadAgentConfig({ projectRoot, env });
  const settings = await resolveAgentFor('generate', { config, cli: {} });
  const result = await runnerFor(settings.provider).run(
    {
      prompt: `${request.system}\n\n${request.user}`,
      phase: 'generate',
      workingDirectory: projectRoot,
      timeout: request.timeoutMs,
      permission: 'read-only',
      maxTurns: 1,
      allowedTools: [],
      forceProvider: settings.provider,
    },
    settings,
  );
  if (!result.success) throw new Error(result.error ?? 'Auto-name agent failed.');
  return result.result;
}

async function activeSession(
  context: ResolvedAgentSessionContext,
  branch: string,
  binding: StoredWorktree,
) {
  const sessions = (await listAgentSessions(context.storage, { branch })).filter(
    (session) => session.worktreeId === binding.worktreeId,
  );
  return projectAgentSessionTabs(sessions, binding).activeSession;
}

/** POST /api/worktrees — validate, then delegate worktree/session ownership. */
export async function createWorktreeRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  body: unknown,
): Promise<ApiResponse> {
  const blocked = mutationGate(deps);
  if (blocked !== null) return blocked;
  const parsed = createWorktreeBodySchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);
  const input = parsed.data;
  const profile = optionalString(input.profile);
  const resolved = await runtime(deps, projectId, profile);
  if (isResponse(resolved)) return resolved;
  if (input.oneshot !== undefined) {
    return { status: 501, body: { error: 'Oneshot worktree sessions are not configured.' } };
  }
  const [agentConfig, customConfig, autoNameConfig] = await Promise.all([
    loadAgentConfig({ projectRoot: resolved.projectRoot, env: deps?.env }),
    loadCustomAgentsConfig({ projectRoot: resolved.projectRoot }),
    loadAutoNameConfig({ projectRoot: resolved.projectRoot }),
  ]);
  const requested = input.agents ?? [input.agent ?? agentConfig.provider];
  const registered = requested.map((id) => findRegisteredAgent(customConfig, id));
  if (registered.some((agent) => agent === null)) {
    return { status: 400, body: { error: 'Every requested agent must be a known provider.' } };
  }
  const customAgents = Object.fromEntries(
    registered
      .filter(
        (agent): agent is Extract<RegisteredAgent, { kind: 'custom' }> => agent?.kind === 'custom',
      )
      .map((agent) => [agent.id, agent]),
  );
  try {
    let branch = optionalString(input.branch);
    if (
      branch === undefined &&
      (input.mode ?? 'new') === 'new' &&
      autoNameConfig !== null &&
      optionalString(input.prompt) !== undefined
    ) {
      branch = (
        await autoNameBranch(
          input.prompt as string,
          deps?.generateBranchName ??
            ((request) =>
              generateBranchNameWithConfiguredAgent(resolved.projectRoot, deps?.env, request)),
          autoNameConfig,
        )
      ).branch;
    }
    const result = await openManagedWorktrees(
      {
        initial: resolved,
        resolveContext: async () => (await deps?.resolveRuntime?.(projectId, profile)) ?? resolved,
      },
      {
        agents: requested,
        customAgents,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(branch === undefined ? {} : { branch }),
        ...(optionalString(input.baseBranch) === undefined
          ? {}
          : { baseBranch: optionalString(input.baseBranch) as string }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.envOverrides === undefined ? {} : { envOverrides: input.envOverrides }),
        ...(input.issueRef === undefined ? {} : { issueRef: input.issueRef }),
        source: input.source ?? 'ui',
      },
    );
    return { status: 201, body: result };
  } catch (error) {
    return apiError(error);
  }
}

export async function removeWorktreeRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
): Promise<ApiResponse> {
  const resolved = await runtime(deps, projectId);
  if (isResponse(resolved)) return resolved;
  try {
    await removeManagedWorktree(resolved, branch);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return apiError(error);
  }
}

export async function openWorktreeRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
  body: unknown,
): Promise<ApiResponse> {
  const blocked = mutationGate(deps);
  if (blocked !== null) return blocked;
  const parsed = openWorktreeBodySchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);
  if (parsed.data.oneshot !== undefined) {
    return { status: 501, body: { error: 'Oneshot worktree sessions are not configured.' } };
  }
  const initial = await runtime(deps, projectId);
  if (isResponse(initial)) return initial;
  const binding = (await initial.worktrees.list()).find(
    (entry) => entry.branch === branch,
  )?.binding;
  if (binding === undefined || binding === null) {
    return { status: 404, body: { error: `Worktree not found: ${branch}` } };
  }
  const resolved = (await deps?.resolveRuntime?.(projectId, binding.profile)) ?? initial;
  const agent = await resolveRegisteredAgent(resolved, binding.agent);
  if (agent === null) {
    return { status: 400, body: { error: `Unknown agent '${binding.agent}'.` } };
  }
  const previous = await activeSession(resolved, branch, binding);
  try {
    await openAgentSession(resolved.deps, {
      provider: agent.id,
      ...(agent.kind === 'custom' ? { customAgent: agent } : {}),
      permission: previous?.permission ?? 'workspace',
      branch,
      ...(previous?.runId == null ? {} : { runId: previous.runId }),
      ...(previous?.phase == null ? {} : { phase: previous.phase }),
      ...(previous?.storyId == null ? {} : { storyId: previous.storyId }),
      ...(parsed.data.prompt === undefined ? {} : { prompt: parsed.data.prompt }),
    });
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return apiError(error);
  }
}

export async function closeWorktreeRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
): Promise<ApiResponse> {
  const resolved = await runtime(deps, projectId);
  if (isResponse(resolved)) return resolved;
  try {
    const exists = (await resolved.worktrees.list()).some(
      (entry) => entry.branch === branch && entry.entry !== null,
    );
    if (!exists) return { status: 404, body: { error: `Worktree not found: ${branch}` } };
    await stopLiveSessions(resolved, branch);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return apiError(error);
  }
}

export async function mergeWorktreeRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
): Promise<ApiResponse> {
  const resolved = await runtime(deps, projectId);
  if (isResponse(resolved)) return resolved;
  try {
    await mergeManagedWorktree(resolved, branch);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return apiError(error);
  }
}

export async function archiveWorktreeRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
  body: unknown,
): Promise<ApiResponse> {
  const resolved = await runtime(deps, projectId);
  if (isResponse(resolved)) return resolved;
  const parsed = archiveBodySchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);
  const value = parsed.data.archived;
  try {
    await setManagedWorktreeArchived(resolved, branch, value);
    return { status: 200, body: { ok: true, archived: value } };
  } catch (error) {
    return apiError(error);
  }
}

export async function labelWorktreeRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
  body: unknown,
): Promise<ApiResponse> {
  const resolved = await runtime(deps, projectId);
  if (isResponse(resolved)) return resolved;
  const parsed = labelBodySchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);
  const label = parsed.data.label === '' ? null : parsed.data.label;
  try {
    await setManagedWorktreeLabel(resolved, branch, label);
    return { status: 200, body: { ok: true, label } };
  } catch (error) {
    return apiError(error);
  }
}

export async function profileWorktreeRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
  body: unknown,
): Promise<ApiResponse> {
  const initial = await runtime(deps, projectId);
  if (isResponse(initial)) return initial;
  const parsed = profileBodySchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);
  const profile = parsed.data.profile;
  if (!initial.profileNames.includes(profile)) {
    return { status: 400, body: { error: `Unknown profile '${profile}'.` } };
  }
  try {
    const binding = (await initial.worktrees.list()).find(
      (candidate) => candidate.branch === branch,
    )?.binding;
    if (binding == null) return { status: 404, body: { error: `Worktree not found: ${branch}` } };
    const sessions = (await listAgentSessions(initial.storage, { branch })).filter(
      (session) => session.worktreeId === binding.worktreeId,
    );
    const active = projectAgentSessionTabs(sessions, binding).activeSession;
    const live = active !== null && isLiveSession(active) ? active : null;
    const registered = live === null ? null : await resolveRegisteredAgent(initial, live.provider);
    if (live !== null && registered === null) {
      return { status: 400, body: { error: `Unknown agent '${live.provider}'.` } };
    }
    const result = await setManagedWorktreeProfile(
      initial,
      branch,
      profile,
      async () => (await deps?.resolveRuntime?.(projectId, profile)) ?? initial,
      registered?.kind === 'custom' ? registered : undefined,
    );
    return { status: 200, body: { ok: true, profile, restarted: result.restarted } };
  } catch (error) {
    return apiError(error);
  }
}

export async function sendWorktreeRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
  body: unknown,
): Promise<ApiResponse> {
  const resolved = await runtime(deps, projectId);
  if (isResponse(resolved)) return resolved;
  const parsed = sendBodySchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);
  const text = parsed.data.text;
  const binding = (await resolved.worktrees.list()).find(
    (candidate) => candidate.branch === branch,
  )?.binding;
  const candidates = (await listAgentSessions(resolved.storage, { branch })).filter(
    (session) =>
      binding !== null && binding !== undefined && session.worktreeId === binding.worktreeId,
  );
  const projection = projectAgentSessionTabs(candidates, binding ?? null);
  const session =
    projection.activeSession !== null && isLiveSession(projection.activeSession)
      ? projection.activeSession
      : undefined;
  if (session === undefined)
    return { status: 409, body: { error: `Worktree is not open: ${branch}` } };
  try {
    await sendToAgentSession(resolved.deps, session, text, {
      ...(parsed.data.preamble === undefined ? {} : { preamble: parsed.data.preamble }),
    });
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return apiError(error);
  }
}

async function tabRuntime(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
): Promise<ResolvedAgentSessionContext | ApiResponse> {
  const initial = await runtime(deps, projectId);
  if (isResponse(initial)) return initial;
  const binding = (await initial.worktrees.list()).find(
    (entry) => entry.branch === branch && entry.entry !== null,
  )?.binding;
  if (binding == null) return { status: 404, body: { error: `Worktree not found: ${branch}` } };
  return (await deps?.resolveRuntime?.(projectId, binding.profile)) ?? initial;
}

export async function createWorktreeTabRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
): Promise<ApiResponse> {
  const blocked = mutationGate(deps);
  if (blocked !== null) return blocked;
  const resolved = await tabRuntime(deps, projectId, branch);
  if (isResponse(resolved)) return resolved;
  try {
    return { status: 201, body: { tab: await createAgentTab(resolved, branch) } };
  } catch (error) {
    return apiError(error);
  }
}

export async function selectWorktreeTabRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
  tabId: string,
): Promise<ApiResponse> {
  const blocked = mutationGate(deps);
  if (blocked !== null) return blocked;
  const resolved = await tabRuntime(deps, projectId, branch);
  if (isResponse(resolved)) return resolved;
  try {
    await selectAgentTab(resolved, branch, tabId);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return apiError(error);
  }
}

export async function deleteWorktreeTabRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
  tabId: string,
): Promise<ApiResponse> {
  const blocked = mutationGate(deps);
  if (blocked !== null) return blocked;
  const resolved = await tabRuntime(deps, projectId, branch);
  if (isResponse(resolved)) return resolved;
  try {
    await deleteAgentTab(resolved, branch, tabId);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return apiError(error);
  }
}

export async function refreshWorktreeAgentTerminalRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
): Promise<ApiResponse> {
  const blocked = mutationGate(deps);
  if (blocked !== null) return blocked;
  const resolved = await tabRuntime(deps, projectId, branch);
  if (isResponse(resolved)) return resolved;
  try {
    const result = await refreshActiveAgentTab(resolved, branch);
    return { status: 200, body: { ok: true, ...result } };
  } catch (error) {
    return apiError(error);
  }
}

export async function worktreeDiffRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  branch: string,
): Promise<ApiResponse> {
  if (deps === null || deps.resolveRuntime === undefined) return NOT_CONFIGURED;
  const resolved = await deps.resolveRuntime(projectId);
  if (resolved === null) return NOT_CONFIGURED;
  try {
    const worktree = (await resolved.worktrees.list()).find(
      (entry) => entry.branch === branch && entry.entry !== null,
    );
    if (worktree === undefined)
      return { status: 404, body: { error: `Worktree not found: ${branch}` } };
    const uncommitted = await resolved.git.readDiff(worktree.path);
    const diff = truncateUtf8(uncommitted);
    return {
      status: 200,
      body: {
        uncommitted: diff.value,
        uncommittedTruncated: diff.truncated,
        gitStatus: await resolved.git.readStatus(worktree.path),
        unpushedCommits: await resolved.git.listUnpushedCommits(worktree.path),
      },
    };
  } catch (error) {
    return apiError(error);
  }
}

export async function pullMainRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  body: unknown,
): Promise<ApiResponse> {
  const blocked = mutationGate(deps);
  if (blocked !== null) return blocked;
  const parsed = pullMainBodySchema.safeParse(body);
  if (!parsed.success) return invalidBody(parsed.error);
  const resolved = await runtime(deps, projectId);
  if (isResponse(resolved)) return resolved;
  if (optionalString(parsed.data.repo) !== undefined) {
    return {
      status: 400,
      body: { error: 'Pulling a linked repository requires a configured local checkout.' },
    };
  }
  if (parsed.data.force === true) {
    return {
      status: 400,
      body: { error: 'Force pull is deliberately unsupported: it discards local commits.' },
    };
  }
  return { status: 200, body: await pullMainBranch(resolved) };
}

export async function listBranchesRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
  includeRemote: boolean,
): Promise<ApiResponse> {
  if (deps === null || deps.resolveRuntime === undefined) return NOT_CONFIGURED;
  const resolved = await deps.resolveRuntime(projectId);
  if (resolved === null) return NOT_CONFIGURED;
  const branches = (
    await listAvailableWorktreeBranches(resolved.git, resolved.projectRoot, includeRemote)
  ).map((name) => ({ name }));
  return { status: 200, body: { branches } };
}

export async function listBaseBranchesRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
): Promise<ApiResponse> {
  if (deps === null || deps.resolveRuntime === undefined) return NOT_CONFIGURED;
  const resolved = await deps.resolveRuntime(projectId);
  if (resolved === null) return NOT_CONFIGURED;
  const branches = (await listWorktreeBaseBranches(resolved.git, resolved.projectRoot)).map(
    (name) => ({ name }),
  );
  return { status: 200, body: { branches } };
}

/** Minimal project configuration needed to make Block A's create/profile UI usable. */
export async function projectWorktreeConfigRoute(
  deps: WorktreesApiDeps | null,
  projectId: string | null,
): Promise<ApiResponse> {
  if (deps === null || deps.resolveRuntime === undefined) return NOT_CONFIGURED;
  const resolved = await deps.resolveRuntime(projectId);
  if (resolved === null) return NOT_CONFIGURED;
  const [customAgents, integrations, agent, github, autoName] = await Promise.all([
    loadCustomAgentsConfig({ projectRoot: resolved.projectRoot }),
    resolvedIntegrationSettings(resolved.projectRoot, deps.env),
    loadAgentConfig({ projectRoot: resolved.projectRoot, env: deps.env }),
    loadGitHubConfig({ projectRoot: resolved.projectRoot, env: deps.env }),
    loadAutoNameConfig({ projectRoot: resolved.projectRoot }),
  ]);
  return {
    status: 200,
    body: {
      name: basename(resolved.projectRoot),
      services: resolved.services.map((service) => ({
        name: service.name,
        portEnv: service.portEnv,
      })),
      profiles: resolved.profileConfigs,
      agents: listAgentSummaries(customAgents),
      defaultProfileName: resolved.profileName,
      defaultAgentId: agent.provider,
      autoName: autoName !== null,
      startupEnvs: resolved.startupEnv,
      linkedRepos: github.linkedRepos,
      ...integrations,
      projectDir: resolved.projectRoot,
      mainBranch: resolved.mainBranch,
    },
  };
}

/** Match all `/api/worktrees/:name[/action]` routes, preserving slashy names. */
export function matchWorktreeRoute(
  pathname: string,
): { branch: string; action: string | null } | null {
  const match = /^\/api\/worktrees\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (match === null) return null;
  return { branch: decodeURIComponent(match[1] as string), action: match[2] ?? null };
}

export function matchWorktreeTabRoute(
  pathname: string,
): { branch: string; tabId: string | null; action: 'create' | 'select' | 'delete' } | null {
  const create = /^\/api\/worktrees\/([^/]+)\/tabs$/.exec(pathname);
  if (create !== null) {
    return { branch: decodeURIComponent(create[1] as string), tabId: null, action: 'create' };
  }
  const selected = /^\/api\/worktrees\/([^/]+)\/tabs\/([^/]+)\/select$/.exec(pathname);
  if (selected !== null) {
    return {
      branch: decodeURIComponent(selected[1] as string),
      tabId: decodeURIComponent(selected[2] as string),
      action: 'select',
    };
  }
  const deleted = /^\/api\/worktrees\/([^/]+)\/tabs\/([^/]+)$/.exec(pathname);
  if (deleted === null) return null;
  return {
    branch: decodeURIComponent(deleted[1] as string),
    tabId: decodeURIComponent(deleted[2] as string),
    action: 'delete',
  };
}

export function matchWorktreeAgentRefresh(pathname: string): string | null {
  const match = /^\/api\/worktrees\/([^/]+)\/agent-terminal\/refresh$/.exec(pathname);
  return match === null ? null : decodeURIComponent(match[1] as string);
}
