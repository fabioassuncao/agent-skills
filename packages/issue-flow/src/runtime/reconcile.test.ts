import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentSession, listSessions, saveSession } from '../agents/session/store.js';
import type { AgentSession } from '../agents/session/types.js';
import {
  listAuditEntries,
  listWorktrees,
  type PlanRepositoryContext,
  resetPlanRepositories,
  type StoredWorktree,
  saveWorktree,
} from '../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { writeFileAtomic } from '../utils/fs.js';
import {
  buildOpenSessionsSnapshot,
  computeOpenBranches,
  createReconciler,
  decideRecovery,
  openSessionsSnapshotPath,
  type ReconcileDependencies,
  readOpenSessionsSnapshot,
  saveOpenSessionsSnapshot,
} from './reconcile.js';
import { buildProjectSessionName, buildWorktreeWindowName } from './tmux/names.js';
import type { WorktreeStatus } from './worktree/git.js';
import type { ManagedWorktree } from './worktree/lifecycle.js';
import { ensureWorktreeStorageDirs } from './worktree/paths.js';

/**
 * The recovery matrix of §30, row by row.
 *
 * Every scenario in that table is a claim about *who wins* when the database
 * and the outside world disagree, so each case here sets up a disagreement and
 * asserts the direction it resolves in. Reconciliation against a real tmux
 * server — and the O(1) measurement ADR-13 demands — lives in
 * `reconcile.integration.test.ts`.
 */

const PROJECT_ID = 'proj-a1b2c3';
const SESSION_NAME = buildProjectSessionName(PROJECT_ID);

function window(branch: string, paneCount = 2, sessionName = SESSION_NAME) {
  return { sessionName, windowName: buildWorktreeWindowName(branch), paneCount };
}

function binding(overrides: Partial<StoredWorktree> = {}): StoredWorktree {
  return {
    worktreeId: 'wt-1',
    branch: 'feature/search',
    path: '/repo/worktrees/feature/search',
    baseBranch: 'main',
    label: null,
    profile: 'default',
    agent: 'claude',
    runtime: 'host',
    startupEnvValues: {},
    allocatedPorts: { FRONTEND_PORT: 3010 },
    source: 'cli',
    conversationId: null,
    createdAt: '2026-09-06T10:00:00.000Z',
    updatedAt: '2026-09-06T10:00:00.000Z',
    ...overrides,
  };
}

function managed(overrides: Partial<ManagedWorktree> = {}): ManagedWorktree {
  const branch = overrides.branch ?? 'feature/search';
  return {
    branch,
    path: `/repo/worktrees/${branch}`,
    entry: {
      path: `/repo/worktrees/${branch}`,
      branch,
      head: 'bbb222',
      detached: false,
      bare: false,
    },
    binding: binding({ branch }),
    state: 'managed',
    ...overrides,
  };
}

interface FakeTmux {
  listWindows: () => Promise<ReturnType<typeof window>[]>;
  calls: number;
}

function fakeTmux(windows: ReturnType<typeof window>[], failure?: Error): FakeTmux {
  const fake: FakeTmux = {
    calls: 0,
    listWindows: async () => {
      fake.calls += 1;
      if (failure !== undefined) throw failure;
      return windows;
    },
  };
  return fake;
}

function fakeGit(status: Partial<WorktreeStatus> = {}) {
  const paths: string[] = [];
  return {
    paths,
    readWorktreeStatus: async (cwd: string): Promise<WorktreeStatus> => {
      paths.push(cwd);
      return { dirty: false, aheadCount: 0, currentCommit: 'bbb222', ...status };
    },
  };
}

describe('runtime reconciliation', () => {
  let home: string;
  let storage: PlanRepositoryContext;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-reconcile-'));
    storage = {
      tasksPath: join(home, 'projects', PROJECT_ID, 'issues', '1', 'tasks.json'),
      projectId: PROJECT_ID,
      issueId: '1',
      projectRoot: '/repo',
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
  });

  afterEach(async () => {
    resetPlanRepositories();
    await rm(home, { recursive: true, force: true });
  });

  async function storeSession(overrides: Partial<AgentSession> = {}): Promise<AgentSession> {
    const session: AgentSession = {
      ...createAgentSession({
        branch: 'feature/search',
        provider: 'claude',
        runId: 'run-1',
        phase: 'execute',
        worktreeId: 'wt-1',
        paneTarget: `${SESSION_NAME}:${buildWorktreeWindowName('feature/search')}.0`,
        status: 'running',
        now: () => new Date('2026-09-06T10:00:00.000Z'),
      }),
      ...overrides,
    };
    await saveSession(storage, session);
    return session;
  }

  function reconciler(overrides: Partial<ReconcileDependencies> = {}, options = {}) {
    const deps: ReconcileDependencies = {
      projectId: PROJECT_ID,
      worktrees: { list: async () => [managed()] },
      tmux: fakeTmux([]),
      storage,
      ...overrides,
    };
    return createReconciler(deps, { now: () => 0, ...options });
  }

  /* ── authority by kind of data (§30, first table) ─────────────────────── */

  describe('authority by kind of data', () => {
    it('takes the set of worktrees from git, including the ones nothing bound', async () => {
      const result = await reconciler({
        worktrees: {
          list: async () => [
            managed(),
            managed({ branch: 'feature/manual', binding: null, state: 'unmanaged' }),
          ],
        },
      }).reconcile();

      expect(result.worktrees.map((entry) => [entry.branch, entry.state])).toEqual([
        ['feature/search', 'managed'],
        ['feature/manual', 'unmanaged'],
      ]);
    });

    it('reads dirty and ahead from git rather than from the stored row', async () => {
      const git = fakeGit({ dirty: true, aheadCount: 2, currentCommit: 'ccc333' });
      const result = await reconciler({ git }).reconcile();

      expect(git.paths).toEqual(['/repo/worktrees/feature/search']);
      expect(result.worktrees[0]?.git).toEqual({
        exists: true,
        dirty: true,
        aheadCount: 2,
        currentCommit: 'ccc333',
      });
    });

    it('takes window liveness and pane count from tmux', async () => {
      const result = await reconciler({
        tmux: fakeTmux([window('feature/search', 3)]),
      }).reconcile();

      expect(result.worktrees[0]?.session).toEqual({
        exists: true,
        sessionName: SESSION_NAME,
        windowName: buildWorktreeWindowName('feature/search'),
        paneCount: 3,
      });
    });

    it('ignores a window of the same name in somebody else’s tmux session', async () => {
      const result = await reconciler({
        tmux: fakeTmux([window('feature/search', 3, 'someone-elses-session')]),
      }).reconcile();

      expect(result.worktrees[0]?.session.exists).toBe(false);
    });

    it('takes container liveness from docker and reports it dead when it is gone', async () => {
      const alive = await reconciler({
        containers: {
          // Deliberately out of order and with a shorter timestamp first: the
          // newest is decided by the numeric suffix, not by list order.
          listRunningContainerNames: async () => [
            'if-feature-search-999999999999',
            'if-feature-search-1757155200000',
          ],
        },
      }).reconcile();
      expect(alive.worktrees[0]?.container).toEqual({
        name: 'if-feature-search-1757155200000',
        running: true,
      });

      const gone = await reconciler({
        containers: { listRunningContainerNames: async () => [] },
      }).reconcile();
      expect(gone.worktrees[0]?.container).toEqual({ name: null, running: false });
    });

    it('reports the container as unknown, not absent, when docker cannot answer', async () => {
      const unknown = await reconciler({
        containers: {
          listRunningContainerNames: async () => {
            throw new Error('Cannot connect to the Docker daemon');
          },
        },
      }).reconcile();

      expect(unknown.worktrees[0]?.container).toBeNull();
    });

    it('lets the provider decide whether a conversation still exists', async () => {
      await storeSession({ conversationId: 'conv-1', status: 'stopped' });

      const known = await reconciler({
        conversations: { listConversationIds: async () => ['conv-1'] },
      }).reconcile();
      expect(known.worktrees[0]?.agentSessions[0]?.recovery).toBe('resume');

      const forgotten = await reconciler({
        conversations: { listConversationIds: async () => [] },
      }).reconcile();
      expect(forgotten.worktrees[0]?.agentSessions[0]?.recovery).toBe('fresh');
    });

    it('never rewrites the live status a hook reported', async () => {
      // `idle` means the agent asked for input and is waiting; `running` means
      // it is working. Both come from hooks (ADR-05) and a live window is not
      // evidence for either, so reconciliation leaves them alone.
      await storeSession({ status: 'idle' });
      const result = await reconciler({ tmux: fakeTmux([window('feature/search')]) }).reconcile();

      expect(result.worktrees[0]?.agentSessions[0]?.status).toBe('idle');
      expect(result.orphanedSessionIds).toEqual([]);
      expect((await listSessions(storage))[0]?.status).toBe('idle');
    });

    it('keeps the binding to run, phase and story even when nothing outside exists', async () => {
      const session = await storeSession();
      const result = await reconciler({
        worktrees: { list: async () => [managed({ entry: null, state: 'orphaned' })] },
      }).reconcile();

      const reconciledSession = result.worktrees[0]?.agentSessions[0];
      expect(reconciledSession?.id).toBe(session.id);
      expect(reconciledSession?.runId).toBe('run-1');
      expect((await listSessions(storage))[0]?.runId).toBe('run-1');
    });

    it('keeps the allocated ports the database owns', async () => {
      const result = await reconciler({
        worktrees: {
          list: async () => [
            managed({
              binding: binding({ allocatedPorts: { FRONTEND_PORT: 3010, API_PORT: 3011 } }),
            }),
          ],
        },
      }).reconcile();

      expect(result.worktrees[0]?.allocatedPorts).toEqual({ FRONTEND_PORT: 3010, API_PORT: 3011 });
    });
  });

  /* ── the recovery scenarios (§30, second table) ───────────────────────── */

  describe('recovery scenarios', () => {
    it('reattaches when the process restarted and tmux is still alive', async () => {
      await storeSession({ conversationId: 'conv-1' });
      const result = await reconciler({ tmux: fakeTmux([window('feature/search')]) }).reconcile();

      expect(result.worktrees[0]?.agentSessions[0]?.recovery).toBe('reattach');
      expect(result.worktrees[0]?.agentSessions[0]?.status).toBe('running');
      expect(result.orphanedSessionIds).toEqual([]);
    });

    it('resumes when tmux died but the conversation survived', async () => {
      const session = await storeSession({ conversationId: 'conv-1' });
      const result = await reconciler({ tmux: fakeTmux([]) }).reconcile();

      expect(result.worktrees[0]?.agentSessions[0]?.recovery).toBe('resume');
      expect(result.orphanedSessionIds).toEqual([session.id]);
    });

    it('starts fresh when the window died and there is no conversation to continue', async () => {
      await storeSession({ conversationId: null });
      const result = await reconciler({ tmux: fakeTmux([]) }).reconcile();

      expect(result.worktrees[0]?.agentSessions[0]?.recovery).toBe('fresh');
    });

    it('survives a machine reboot: worktree and conversation live, sessions orphaned, rows kept', async () => {
      const session = await storeSession({ conversationId: 'conv-1' });
      const result = await reconciler({
        // After a reboot the worktree is still on disk and the conversation is
        // still a file; tmux and docker are empty because nothing was restarted.
        tmux: fakeTmux([]),
        containers: { listRunningContainerNames: async () => [] },
      }).reconcile();

      expect(result.worktrees[0]?.agentSessions[0]?.recovery).toBe('resume');
      expect(result.orphanedSessionIds).toEqual([session.id]);

      const rows = await listSessions(storage);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('orphaned');
      expect(rows[0]?.conversationId).toBe('conv-1');
    });

    it('reuses a container that came back under the same name and never recreates one', async () => {
      const names = ['if-feature-search-1757155200000'];
      const reconcile = reconciler({
        containers: { listRunningContainerNames: async () => names },
      });

      const before = await reconcile.reconcile();
      expect(before.worktrees[0]?.container?.name).toBe('if-feature-search-1757155200000');

      names.length = 0;
      const after = await reconcile.reconcile({ force: true });
      // Reported dead. Nothing here launches a replacement: recreating a
      // container because a row mentions one is the optimistic recreation
      // ADR-08 forbids, and `launchContainer` is idempotent for exactly that.
      expect(after.worktrees[0]?.container).toEqual({ name: null, running: false });
    });

    it('does not depend on any transport being up', async () => {
      // A dropped WebSocket only costs observation. Reconciliation reads git,
      // tmux and the database directly, so a pass with no transport anywhere
      // produces the same projection.
      const result = await reconciler({ tmux: fakeTmux([window('feature/search')]) }).reconcile();
      expect(result.worktrees[0]?.session.exists).toBe(true);
      expect(result.ran).toBe(true);
    });

    it('leaves a silent but live session alone — stalls belong to the watchdog', async () => {
      await storeSession({
        status: 'running',
        updatedAt: '2020-01-01T00:00:00.000Z',
      });
      const result = await reconciler({ tmux: fakeTmux([window('feature/search')]) }).reconcile();

      expect(result.worktrees[0]?.agentSessions[0]?.status).toBe('running');
      expect(result.orphanedSessionIds).toEqual([]);
    });

    it('keeps a session that is awaiting input waiting', async () => {
      await storeSession({ status: 'idle', conversationId: 'conv-1' });
      const result = await reconciler({ tmux: fakeTmux([window('feature/search')]) }).reconcile();

      expect(result.worktrees[0]?.agentSessions[0]?.status).toBe('idle');
      expect(result.worktrees[0]?.agentSessions[0]?.recovery).toBe('reattach');
    });

    it('offers fresh or resume for a worktree that exists with no session', async () => {
      const withConversation = await reconciler({
        worktrees: {
          list: async () => [managed({ binding: binding({ conversationId: 'conv-1' }) })],
        },
      }).reconcile();
      expect(withConversation.worktrees[0]?.agentSessions).toEqual([]);
      expect(withConversation.worktrees[0]?.session.exists).toBe(false);

      await storeSession({ conversationId: 'conv-1', status: 'stopped' });
      const resumable = await reconciler().reconcile();
      expect(resumable.worktrees[0]?.agentSessions[0]?.recovery).toBe('resume');
    });

    it('closes an inconsistent session and records why in the audit log', async () => {
      const session = await storeSession({ conversationId: 'conv-1' });
      await reconciler({ tmux: fakeTmux([]) }).reconcile();

      const entries = await listAuditEntries(storage, {
        action: `agent_session_orphaned:${session.id}`,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.payload).toMatchObject({
        sessionId: session.id,
        branch: 'feature/search',
        runId: 'run-1',
        phase: 'execute',
        reason: 'tmux window no longer exists',
      });
    });

    it('never touches the worktree binding when git stops listing the directory', async () => {
      await saveWorktree(storage, binding());
      await reconciler({
        worktrees: { list: async () => [managed({ entry: null, state: 'orphaned' })] },
      }).reconcile();

      // Reported, never repaired and never deleted: the row is the record of
      // what was bound, and a missing directory does not unmake that history.
      const result = await reconciler({
        worktrees: { list: async () => [managed({ entry: null, state: 'orphaned' })] },
      }).reconcile();
      expect(result.worktrees[0]?.state).toBe('orphaned');
      expect(result.worktrees[0]?.git.exists).toBe(false);
      expect(result.worktrees[0]?.worktreeId).toBe('wt-1');
    });

    it('never probes git against a path git no longer lists', async () => {
      // The upstream's ENOENT crash: a stale registration points at a directory
      // that is gone, and probing it aborts the pass over one dead entry.
      const git = fakeGit();
      await reconciler({
        git,
        worktrees: {
          list: async () => [
            managed(),
            managed({ branch: 'feature/gone', entry: null, state: 'orphaned' }),
          ],
        },
      }).reconcile();

      expect(git.paths).toEqual(['/repo/worktrees/feature/search']);
    });
  });

  /* ── ADR-13: aggregated calls ─────────────────────────────────────────── */

  describe('aggregated calls', () => {
    it('asks tmux exactly once, whatever the number of worktrees', async () => {
      const few = fakeTmux([]);
      await reconciler({ tmux: few, worktrees: { list: async () => [managed()] } }).reconcile();
      expect(few.calls).toBe(1);

      const many = fakeTmux([]);
      await reconciler({
        tmux: many,
        worktrees: {
          list: async () =>
            Array.from({ length: 40 }, (_unused, index) => managed({ branch: `feature/${index}` })),
        },
      }).reconcile();
      expect(many.calls).toBe(1);
    });

    it('asks docker exactly once, whatever the number of worktrees', async () => {
      let calls = 0;
      await reconciler({
        containers: {
          listRunningContainerNames: async () => {
            calls += 1;
            return [];
          },
        },
        worktrees: {
          list: async () =>
            Array.from({ length: 25 }, (_unused, index) => managed({ branch: `feature/${index}` })),
        },
      }).reconcile();

      expect(calls).toBe(1);
    });

    it('treats a missing tmux as no windows instead of a failure', async () => {
      const result = await reconciler({
        tmux: fakeTmux([], new Error('tmux: command not found')),
      }).reconcile();

      expect(result.ran).toBe(true);
      expect(result.worktrees[0]?.session.exists).toBe(false);
    });
  });

  /* ── freshness and coalescing ─────────────────────────────────────────── */

  describe('freshness window and coalescing', () => {
    it('joins a pass already in flight instead of starting a second one', async () => {
      let calls = 0;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      const reconcile = reconciler({
        worktrees: {
          list: async () => {
            calls += 1;
            await gate;
            return [managed()];
          },
        },
      });

      const first = reconcile.reconcile();
      const second = reconcile.reconcile();
      release?.();
      const [left, right] = await Promise.all([first, second]);

      expect(calls).toBe(1);
      expect(left).toBe(right);
    });

    it('returns the standing projection inside the freshness window', async () => {
      let calls = 0;
      let clock = 10_000;
      const reconcile = reconciler(
        {
          worktrees: {
            list: async () => {
              calls += 1;
              return [managed()];
            },
          },
        },
        { freshnessMs: 500, now: () => clock },
      );

      await reconcile.reconcile();
      expect(calls).toBe(1);

      const fresh = await reconcile.reconcile();
      expect(calls).toBe(1);
      expect(fresh.ran).toBe(false);
      expect(fresh.worktrees.map((entry) => entry.branch)).toEqual(['feature/search']);

      clock += 501;
      const stale = await reconcile.reconcile();
      expect(calls).toBe(2);
      expect(stale.ran).toBe(true);
    });

    it('runs inside the freshness window when forced', async () => {
      let calls = 0;
      const reconcile = reconciler(
        {
          worktrees: {
            list: async () => {
              calls += 1;
              return [managed()];
            },
          },
        },
        { freshnessMs: 5_000, now: () => 10_000 },
      );

      await reconcile.reconcile();
      await reconcile.reconcile({ force: true });
      expect(calls).toBe(2);
    });
  });

  /* ── the projection never accumulates rubbish ─────────────────────────── */

  describe('projection', () => {
    it('drops what it did not see without deleting the binding', async () => {
      await saveWorktree(storage, binding());
      await saveWorktree(storage, binding({ branch: 'feature/gone', worktreeId: 'wt-gone' }));
      const branches = ['feature/search', 'feature/gone'];
      const reconcile = reconciler({
        worktrees: { list: async () => branches.map((branch) => managed({ branch })) },
      });

      await reconcile.reconcile();
      expect(reconcile.projection().map((entry) => entry.branch)).toEqual([
        'feature/search',
        'feature/gone',
      ]);

      branches.pop();
      const result = await reconcile.reconcile({ force: true });
      expect(result.prunedBranches).toEqual(['feature/gone']);
      expect(reconcile.projection().map((entry) => entry.branch)).toEqual(['feature/search']);

      // Only the projection was pruned. The binding is still there.
      expect((await listWorktrees(storage)).map((row) => row.branch)).toEqual([
        'feature/gone',
        'feature/search',
      ]);
    });

    it('reports no last pass before the first one', () => {
      expect(reconciler().lastReconciledAt()).toBeNull();
    });
  });

  /* ── recovery decision, on its own ────────────────────────────────────── */

  describe('decideRecovery', () => {
    it('prefers a live window over everything else', () => {
      expect(decideRecovery({ windowAlive: true, conversationAlive: false })).toBe('reattach');
      expect(decideRecovery({ windowAlive: true, conversationAlive: true })).toBe('reattach');
    });

    it('resumes a conversation when the window is gone', () => {
      expect(decideRecovery({ windowAlive: false, conversationAlive: true })).toBe('resume');
    });

    it('starts fresh when neither survived', () => {
      expect(decideRecovery({ windowAlive: false, conversationAlive: false })).toBe('fresh');
    });
  });
});

/* ── open-session snapshot (session-restore-service) ──────────────────────── */

describe('open sessions snapshot', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe('computeOpenBranches', () => {
    it('returns only branches whose window is open in this project’s session', () => {
      expect(
        computeOpenBranches({
          worktrees: [
            { branch: 'feature-a', path: '/wt/a' },
            { branch: 'feature-b', path: '/wt/b' },
            { branch: 'feature-c', path: '/wt/c' },
          ],
          windows: [
            window('feature-a', 1),
            window('feature-c', 1),
            window('feature-b', 1, 'some-other-session'),
          ],
          sessionName: SESSION_NAME,
        }),
      ).toEqual(['feature-a', 'feature-c']);
    });

    it('returns nothing when no window is open', () => {
      expect(
        computeOpenBranches({
          worktrees: [{ branch: 'feature-a', path: '/wt/a' }],
          windows: [],
          sessionName: SESSION_NAME,
        }),
      ).toEqual([]);
    });
  });

  it('stamps the schema version and the time it was saved', () => {
    expect(buildOpenSessionsSnapshot(['a', 'b'], new Date('2026-09-06T12:00:00.000Z'))).toEqual({
      schemaVersion: 1,
      savedAt: '2026-09-06T12:00:00.000Z',
      branches: ['a', 'b'],
    });
  });

  it('writes the open branches when at least one session is open', async () => {
    const writes: Array<{ path: string; branches: string[] }> = [];
    const branches = await saveOpenSessionsSnapshot({
      gitDir: '/repo/.git',
      projectId: PROJECT_ID,
      worktrees: { list: async () => [managed({ branch: 'feature-a' })] },
      tmux: fakeTmux([window('feature-a', 1)]),
      now: () => new Date('2026-09-06T12:00:00.000Z'),
      writeSnapshot: async (path, snapshot) => {
        writes.push({ path, branches: snapshot.branches });
      },
    });

    expect(branches).toEqual(['feature-a']);
    expect(writes).toEqual([
      { path: openSessionsSnapshotPath('/repo/.git'), branches: ['feature-a'] },
    ]);
  });

  it('never overwrites the snapshot when nothing is open', async () => {
    const writes: string[] = [];
    const branches = await saveOpenSessionsSnapshot({
      gitDir: '/repo/.git',
      projectId: PROJECT_ID,
      worktrees: { list: async () => [managed({ branch: 'feature-a' })] },
      tmux: fakeTmux([]),
      writeSnapshot: async (path) => {
        writes.push(path);
      },
    });

    // The reboot rule: the process starts before any session is reopened, so an
    // empty write here would erase exactly what a restore needs.
    expect(branches).toBeNull();
    expect(writes).toEqual([]);
  });

  it('writes atomically and reads back what it wrote', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'issue-flow-snapshot-'));
    dirs.push(gitDir);
    await ensureWorktreeStorageDirs(gitDir);

    await saveOpenSessionsSnapshot({
      gitDir,
      projectId: PROJECT_ID,
      worktrees: { list: async () => [managed({ branch: 'feature-a' })] },
      tmux: fakeTmux([window('feature-a', 1)]),
      now: () => new Date('2026-09-06T12:00:00.000Z'),
    });

    expect(await readOpenSessionsSnapshot(gitDir)).toEqual({
      schemaVersion: 1,
      savedAt: '2026-09-06T12:00:00.000Z',
      branches: ['feature-a'],
    });
    expect(await readFile(openSessionsSnapshotPath(gitDir), 'utf-8')).toContain('"feature-a"');
  });

  it('reads an empty snapshot when the file is missing or malformed', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'issue-flow-snapshot-'));
    dirs.push(gitDir);

    expect(await readOpenSessionsSnapshot(gitDir)).toEqual({
      schemaVersion: 1,
      savedAt: '',
      branches: [],
    });

    await writeFileAtomic(openSessionsSnapshotPath(gitDir), 'not json');
    expect((await readOpenSessionsSnapshot(gitDir)).branches).toEqual([]);
  });
});
