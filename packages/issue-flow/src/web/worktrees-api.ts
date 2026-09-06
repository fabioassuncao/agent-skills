import { listAgentSessions } from '../agents/session/open.js';
import { type AgentSession, isLiveSession } from '../agents/session/types.js';
import type { PullRequestEntry } from '../issues/github/index.js';
import { createPortProbe, type PortProbe, probeServices } from '../runtime/services.js';
import { readGitWorktreeStatus } from '../runtime/worktree/git.js';
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
  project: SessionsApiProject;
  deps: WorktreesApiDeps;
  probe: PortProbe;
  nowMs: number;
  binding: {
    path: string;
    label: string | null;
    baseBranch: string | null;
    profile: string;
    allocatedPorts: Record<string, number>;
    source: string | null;
  } | null;
}

async function buildRow({
  session,
  project,
  deps,
  probe,
  nowMs,
  binding,
}: RowInput): Promise<Record<string, unknown>> {
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
      : await probeServices(project.services, binding?.allocatedPorts ?? {}, probe);

  return {
    branch: session.branch,
    // The session's caption when it has one; the worktree's otherwise. A
    // workflow session is named by its issue and a free one by whatever the
    // person typed, and neither is the branch.
    label: session.label ?? binding?.label ?? null,
    ...(binding?.baseBranch == null ? {} : { baseBranch: binding.baseBranch }),
    path,
    dir: path,
    archived: false,
    profile: binding?.profile ?? null,
    agentName: session.provider,
    agentLabel: session.provider,
    agentTerminalStale: false,
    // A session with a pane is one the terminal can attach to. It is the same
    // question `canConnect` asks in the shell, so it is answered from the pane
    // target rather than re-derived from the status.
    mux: session.paneTarget !== null && isLiveSession(session),
    dirty: status.dirty,
    // `aheadCount` is "commits nobody else has"; the row only asks whether there
    // are any.
    unpushed: status.aheadCount > 0,
    paneCount: session.paneTarget === null ? 0 : 1,
    status: sessionStatusToWorktreeStatus(session),
    elapsed: formatElapsed(session.updatedAt, nowMs),
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
    // Multi-tab per worktree is a layout model of its own and phase 9B did not
    // port it; one session is one row, and the tab bar stays hidden.
    tabs: [],
    activeTabId: null,
    executionId: session.runId,
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

  const sessions = await listAgentSessions(project.deps.storage);
  // A stopped session's window is gone; the row would offer a terminal that
  // refuses the handshake.
  const live = sessions.filter(isLiveSession);
  if (live.length === 0) return EMPTY;

  const managed = await project.deps.worktrees.list().catch(() => []);
  const byBranch = new Map(managed.map((entry) => [entry.branch, entry]));
  const probe = deps.probe ?? createPortProbe();
  const nowMs = deps.now?.() ?? Date.now();

  const worktrees = await Promise.all(
    live.map((session) => {
      const entry = byBranch.get(session.branch);
      const stored = entry?.binding ?? null;
      return buildRow({
        session,
        project,
        deps,
        probe,
        nowMs,
        binding:
          entry === undefined
            ? null
            : {
                path: entry.path,
                label: stored?.label ?? null,
                baseBranch: stored?.baseBranch ?? null,
                profile: stored?.profile ?? '',
                allocatedPorts: stored?.allocatedPorts ?? {},
                source: stored?.source ?? null,
              },
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

  const session = (await listAgentSessions(project.deps.storage)).find(
    (candidate) => candidate.branch === branch && isLiveSession(candidate),
  );
  if (session === undefined) {
    return { status: 404, body: { error: `No live session on branch '${branch}'.` } };
  }

  const entry = (await project.deps.worktrees.list().catch(() => [])).find(
    (candidate) => candidate.branch === branch,
  );
  const stored = entry?.binding ?? null;
  const row = await buildRow({
    session,
    project,
    deps,
    probe: deps.probe ?? createPortProbe(),
    nowMs: deps.now?.() ?? Date.now(),
    binding:
      entry === undefined
        ? null
        : {
            path: entry.path,
            label: stored?.label ?? null,
            baseBranch: stored?.baseBranch ?? null,
            profile: stored?.profile ?? '',
            allocatedPorts: stored?.allocatedPorts ?? {},
            source: stored?.source ?? null,
          },
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
