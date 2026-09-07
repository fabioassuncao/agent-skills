import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listSessions, updateSessionStatus } from '../agents/session/store.js';
import { type AgentSession, isLiveSession } from '../agents/session/types.js';
import { appendAuditEntry, type PlanRepositoryContext } from '../storage/db/repository.js';
import { mapWithConcurrency } from '../utils/async.js';
import { writeFileAtomic } from '../utils/fs.js';
import { containerNamePrefix, selectBranchContainers } from './sandbox/docker.js';
import type { TmuxGateway } from './tmux/gateway.js';
import {
  buildProjectSessionName,
  buildWorktreeWindowName,
  type TmuxWindowSummary,
} from './tmux/names.js';
import type { GitWorktreeGateway, WorktreeStatus } from './worktree/git.js';
import type { ManagedWorktree } from './worktree/lifecycle.js';
import { getWorktreeStoragePaths } from './worktree/paths.js';

/** Everything a caller may inject; every port is aggregated on purpose (ADR-13). */
export interface ReconcileDependencies {
  /** Issue Flow's project id — what the tmux session is named after. */
  projectId: string;
  /**
   * The git ⋈ database join.
   *
   * `createWorktreeManager().list()` already answers this correctly, including
   * the `orphaned` state, and reimplementing the join here would be the second
   * implementation invariant 13 forbids.
   */
  worktrees: { list(): Promise<ManagedWorktree[]> };
  /** One `list-windows -a` per pass, and never more (ADR-13). */
  tmux: Pick<TmuxGateway, 'listWindows'>;
  /** Per-worktree status. Absent means "do not probe git", which tests use. */
  git?: Pick<GitWorktreeGateway, 'readWorktreeStatus'>;
  /** Where the bindings live. Absent means "no database", used by dry runs. */
  storage?: PlanRepositoryContext;
  /** Aggregated container listing. Absent means docker was not consulted. */
  containers?: ContainerSource;
  /** Aggregated conversation listing. Absent means the stored id is not contradicted. */
  conversations?: ConversationSource;
}

/**
 * Every running container, in one call.
 *
 * Deliberately not `DockerGateway`: that interface answers `findContainer(branch)`,
 * which is one `docker ps` per branch. Reconciliation asks for the whole list
 * once and filters it in memory (ADR-13).
 */
export interface ContainerSource {
  listRunningContainerNames(): Promise<string[]>;
}

export interface ConversationSource {
  listConversationIds(): Promise<Iterable<string>>;
}

export interface ReconcileOptions {
  freshnessMs?: number;
  now?: () => number;
  concurrency?: number;
}

export interface ReconcilePassOptions {
  /** Run even inside the freshness window. Never skips an in-flight pass. */
  force?: boolean;
}

export type RecoveryAction = 'reattach' | 'resume' | 'fresh';

export interface ReconciledAgentSession {
  id: string;
  runId: string | null;
  storyId: string | null;
  provider: string;
  conversationId: string | null;
  /** Status after reconciliation. Only ever demoted here, never promoted. */
  status: AgentSession['status'];
  paneTarget: string | null;

  recovery: RecoveryAction;
}

export interface ReconciledWorktree {
  branch: string;
  path: string;
  /** `null` for a worktree git lists but the database never bound. */
  worktreeId: string | null;
  /** As `createWorktreeManager().list()` reports it: git ⋈ database. */
  state: ManagedWorktree['state'];
  git: {
    /** Whether git still lists this worktree. */
    exists: boolean;
    dirty: boolean;
    aheadCount: number;
    currentCommit: string | null;
  };
  session: {
    exists: boolean;
    sessionName: string | null;
    windowName: string;
    paneCount: number;
  };
  /** `null` when no container source was supplied — unknown, not absent. */
  container: { name: string | null; running: boolean } | null;
  /** Ports the database allocated. SQLite is the authority; never re-derived. */
  allocatedPorts: Record<string, number>;
  agentSessions: ReconciledAgentSession[];
}

export interface ReconcileResult {
  reconciledAt: number;
  worktrees: ReconciledWorktree[];
  /** Sessions this pass demoted to `orphaned`, by id. */
  orphanedSessionIds: string[];
  /** Branches dropped from the projection this pass. Their rows are untouched. */
  prunedBranches: string[];
  /** Whether the pass actually ran, or returned the projection as it stood. */
  ran: boolean;
}

export interface Reconciler {
  reconcile(options?: ReconcilePassOptions): Promise<ReconcileResult>;
  /** The projection as it stands, without triggering a pass. */
  projection(): ReconciledWorktree[];
  /** Epoch millis of the last completed pass, `null` before the first one. */
  lastReconciledAt(): number | null;
}

const DEFAULT_FRESHNESS_MS = 500;
const DEFAULT_CONCURRENCY = 4;

const UNKNOWN_STATUS: WorktreeStatus = { dirty: false, aheadCount: 0, currentCommit: null };

function findWindow(
  windows: readonly TmuxWindowSummary[],
  sessionName: string,
  windowName: string,
): TmuxWindowSummary | null {
  return (
    windows.find(
      (window) => window.sessionName === sessionName && window.windowName === windowName,
    ) ?? null
  );
}

export function decideRecovery(input: {
  windowAlive: boolean;
  conversationAlive: boolean;
}): RecoveryAction {
  if (input.windowAlive) return 'reattach';
  return input.conversationAlive ? 'resume' : 'fresh';
}

export function createReconciler(
  deps: ReconcileDependencies,
  options: ReconcileOptions = {},
): Reconciler {
  const freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const now = options.now ?? Date.now;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const sessionName = buildProjectSessionName(deps.projectId);

  let inFlight: Promise<ReconcileResult> | null = null;
  let lastReconciledAt: number | null = null;
  /** The projection, keyed by branch. Rebuilt every pass, never accumulated. */
  let projection = new Map<string, ReconciledWorktree>();

  async function readWindows(): Promise<TmuxWindowSummary[]> {
    try {
      return await deps.tmux.listWindows();
    } catch {
      // No tmux, no server, no permission — all of them mean "no windows",
      // which is a perfectly ordinary answer and the one this pass needs. A
      // throw here would make a repository without tmux unable to reconcile at
      // all, and `headless` must keep working without a multiplexer (ADR-03).
      return [];
    }
  }

  async function readContainerNames(): Promise<string[] | null> {
    if (deps.containers === undefined) return null;
    try {
      return await deps.containers.listRunningContainerNames();
    } catch {
      // A docker daemon that cannot answer is not evidence that containers are
      // gone. It is evidence of nothing, and `null` says exactly that — the
      // alternative would report every container dead on a daemon restart.
      return null;
    }
  }

  async function readConversationIds(): Promise<Set<string> | null> {
    if (deps.conversations === undefined) return null;
    try {
      return new Set(await deps.conversations.listConversationIds());
    } catch {
      return null;
    }
  }

  async function readStatus(worktree: ManagedWorktree): Promise<WorktreeStatus> {
    if (deps.git === undefined || worktree.entry === null) return UNKNOWN_STATUS;
    try {
      return await deps.git.readWorktreeStatus(worktree.path);
    } catch {
      return UNKNOWN_STATUS;
    }
  }

  function containerFor(
    branch: string,
    names: readonly string[] | null,
  ): ReconciledWorktree['container'] {
    if (names === null) return null;
    const prefix = containerNamePrefix(branch);
    const name =
      selectBranchContainers(names.join('\n'), prefix).sort(
        (left, right) => Number(right.slice(prefix.length)) - Number(left.slice(prefix.length)),
      )[0] ?? null;
    return { name, running: name !== null };
  }

  /**
   * Bring a session's row in line with what is alive, in the one direction
   * ADR-08 allows.
   *
   * A live row whose window is gone becomes `orphaned` and is written back,
   * with an `audit_log` entry so the closure is auditable rather than silent.
   * The reverse never happens: `starting`, `running` and `idle` are *reported*
   * by the agent's hooks (ADR-05), and a reconciler that promoted `idle` to
   * `running` because a pane exists would be inventing the state the hooks are
   * there to observe.
   */
  async function reconcileSession(
    session: AgentSession,
    windowAlive: boolean,
    conversationIds: Set<string> | null,
    orphaned: string[],
  ): Promise<ReconciledAgentSession> {
    let status = session.status;
    if (isLiveSession(session) && !windowAlive) {
      status = 'orphaned';
      orphaned.push(session.id);
      if (deps.storage !== undefined) {
        await updateSessionStatus(deps.storage, session, 'orphaned');
        await appendAuditEntry(deps.storage, `agent_session_orphaned:${session.id}`, {
          sessionId: session.id,
          branch: session.branch,
          runId: session.runId,
          phase: session.phase,
          reason: 'tmux window no longer exists',
        });
      }
    }

    const conversationAlive =
      session.conversationId !== null &&
      (conversationIds === null || conversationIds.has(session.conversationId));

    return {
      id: session.id,
      runId: session.runId,
      storyId: session.storyId,
      provider: session.provider,
      conversationId: session.conversationId,
      status,
      paneTarget: session.paneTarget,
      recovery: decideRecovery({ windowAlive, conversationAlive }),
    };
  }

  async function runPass(): Promise<ReconcileResult> {
    // Every aggregated read happens once, before the fan-out, so the number of
    // external calls does not depend on how many worktrees there are (ADR-13).
    const [managed, windows, containerNames, conversationIds, sessions] = await Promise.all([
      deps.worktrees.list(),
      readWindows(),
      readContainerNames(),
      readConversationIds(),
      deps.storage === undefined ? Promise.resolve([]) : listSessions(deps.storage),
    ]);

    const sessionsByBranch = new Map<string, AgentSession[]>();
    for (const session of sessions) {
      const bucket = sessionsByBranch.get(session.branch);
      if (bucket === undefined) sessionsByBranch.set(session.branch, [session]);
      else bucket.push(session);
    }

    const orphanedSessionIds: string[] = [];
    const reconciled = await mapWithConcurrency(managed, concurrency, async (worktree) => {
      const windowName = buildWorktreeWindowName(worktree.branch);
      const window = findWindow(windows, sessionName, windowName);
      const status = await readStatus(worktree);
      const agentSessions: ReconciledAgentSession[] = [];
      for (const session of sessionsByBranch.get(worktree.branch) ?? []) {
        agentSessions.push(
          await reconcileSession(session, window !== null, conversationIds, orphanedSessionIds),
        );
      }

      return {
        branch: worktree.branch,
        path: worktree.path,
        worktreeId: worktree.binding?.worktreeId ?? null,
        state: worktree.state,
        git: {
          exists: worktree.entry !== null,
          dirty: status.dirty,
          aheadCount: status.aheadCount,
          currentCommit: status.currentCommit,
        },
        session: {
          exists: window !== null,
          sessionName: window?.sessionName ?? null,
          windowName,
          paneCount: window?.paneCount ?? 0,
        },
        container: containerFor(worktree.branch, containerNames),
        allocatedPorts: worktree.binding?.allocatedPorts ?? {},
        agentSessions,
      } satisfies ReconciledWorktree;
    });

    // Whatever was not seen leaves the projection, so it never accumulates
    // rubbish. It leaves the *projection* only: the binding stays in SQLite,
    // because a worktree removed by hand is a fact about the filesystem, not a
    // reason to destroy the record of what was bound to it (ADR-08).
    const next = new Map(reconciled.map((entry) => [entry.branch, entry]));
    const prunedBranches = [...projection.keys()].filter((branch) => !next.has(branch));
    projection = next;

    const reconciledAt = now();
    lastReconciledAt = reconciledAt;
    return {
      reconciledAt,
      worktrees: [...next.values()],
      orphanedSessionIds,
      prunedBranches,
      ran: true,
    };
  }

  return {
    async reconcile(passOptions: ReconcilePassOptions = {}): Promise<ReconcileResult> {
      // A caller arriving mid-pass joins it. Starting a second pass would
      // double every external call and could interleave two writes of the same
      // session status.
      if (inFlight !== null) return inFlight;

      if (
        passOptions.force !== true &&
        lastReconciledAt !== null &&
        now() - lastReconciledAt < freshnessMs
      ) {
        return {
          reconciledAt: lastReconciledAt,
          worktrees: [...projection.values()],
          orphanedSessionIds: [],
          prunedBranches: [],
          ran: false,
        };
      }

      const pass = runPass();
      inFlight = pass.finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    projection: () => [...projection.values()],
    lastReconciledAt: () => lastReconciledAt,
  };
}

/* ── open-session snapshot ──────────────────────────────────────────────── */

export const OPEN_SESSIONS_SNAPSHOT_VERSION = 1;

export const OPEN_SESSIONS_SNAPSHOT_FILENAME = 'open-sessions.json';

export interface OpenSessionsSnapshot {
  schemaVersion: number;
  savedAt: string;
  branches: string[];
}

const EMPTY_SNAPSHOT: OpenSessionsSnapshot = {
  schemaVersion: OPEN_SESSIONS_SNAPSHOT_VERSION,
  savedAt: '',
  branches: [],
};

/**
 * Which branches currently have a window open in this project's session.
 *
 * Pure, so the rule can be tested without git or tmux anywhere. Windows
 * belonging to another tmux session are ignored on purpose: the user's own
 * sessions share the server, and a window called like ours in one of them is
 * not one of ours.
 */
export function computeOpenBranches(input: {
  worktrees: ReadonlyArray<{ branch: string; path: string }>;
  windows: readonly TmuxWindowSummary[];
  sessionName: string;
}): string[] {
  const openWindowNames = new Set(
    input.windows
      .filter((window) => window.sessionName === input.sessionName)
      .map((window) => window.windowName),
  );
  return input.worktrees
    .map((worktree) => worktree.branch)
    .filter((branch) => openWindowNames.has(buildWorktreeWindowName(branch)))
    .sort((left, right) => left.localeCompare(right));
}

export function buildOpenSessionsSnapshot(branches: string[], savedAt: Date): OpenSessionsSnapshot {
  return {
    schemaVersion: OPEN_SESSIONS_SNAPSHOT_VERSION,
    savedAt: savedAt.toISOString(),
    branches,
  };
}

export function openSessionsSnapshotPath(gitDir: string): string {
  return join(getWorktreeStoragePaths(gitDir).artifactsDir, OPEN_SESSIONS_SNAPSHOT_FILENAME);
}

export interface SessionSnapshotDependencies {
  gitDir: string;
  worktrees: { list(): Promise<ManagedWorktree[]> };
  tmux: Pick<TmuxGateway, 'listWindows'>;
  projectId: string;
  now?: () => Date;
  /** Seam for tests; the default writes the file atomically. */
  writeSnapshot?: (path: string, snapshot: OpenSessionsSnapshot) => Promise<void>;
}

/**
 * Persist the branches that currently have a window open.
 *
 * Returns the branches written, or `null` when nothing was written.
 *
 * **An empty open set never overwrites the snapshot.** After a reboot the
 * process starts before any session has been reopened, so writing the empty
 * list here would erase precisely the data a restore needs. Keeping the last
 * non-empty snapshot is what makes "reopen my last working set" possible at
 * all, and it is why this function returns `null` instead of writing.
 */
export async function saveOpenSessionsSnapshot(
  deps: SessionSnapshotDependencies,
): Promise<string[] | null> {
  let windows: TmuxWindowSummary[] = [];
  try {
    windows = await deps.tmux.listWindows();
  } catch {
    windows = [];
  }

  const branches = computeOpenBranches({
    worktrees: await deps.worktrees.list(),
    windows,
    sessionName: buildProjectSessionName(deps.projectId),
  });
  if (branches.length === 0) return null;

  const at = (deps.now ?? (() => new Date()))();
  const write =
    deps.writeSnapshot ??
    (async (path: string, snapshot: OpenSessionsSnapshot) => {
      await writeFileAtomic(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    });
  await write(openSessionsSnapshotPath(deps.gitDir), buildOpenSessionsSnapshot(branches, at));
  return branches;
}

/**
 * Read the snapshot back.
 *
 * A missing, unreadable or malformed file yields the empty snapshot: a restore
 * that finds nothing to reopen is an ordinary outcome, and a throw here would
 * make a corrupted hint file block startup.
 */
export async function readOpenSessionsSnapshot(gitDir: string): Promise<OpenSessionsSnapshot> {
  try {
    const parsed: unknown = JSON.parse(await readFile(openSessionsSnapshotPath(gitDir), 'utf-8'));
    if (parsed === null || typeof parsed !== 'object') return EMPTY_SNAPSHOT;
    const record = parsed as Partial<OpenSessionsSnapshot>;
    if (!Array.isArray(record.branches)) return EMPTY_SNAPSHOT;
    return {
      schemaVersion:
        typeof record.schemaVersion === 'number'
          ? record.schemaVersion
          : OPEN_SESSIONS_SNAPSHOT_VERSION,
      savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
      branches: record.branches.filter((branch): branch is string => typeof branch === 'string'),
    };
  } catch {
    return EMPTY_SNAPSHOT;
  }
}
