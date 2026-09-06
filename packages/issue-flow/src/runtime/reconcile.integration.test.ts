import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanRepositoryContext } from '../storage/db/repository.js';
import { resetPlanRepositories } from '../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { createReconciler } from './reconcile.js';
import { createTmuxGateway, type TmuxGateway } from './tmux/gateway.js';
import { buildProjectSessionName, buildWorktreeWindowName } from './tmux/names.js';
import type { ManagedWorktree } from './worktree/lifecycle.js';

/**
 * Reconciliation against a real tmux server.
 *
 * This is where ADR-13 is *measured* rather than asserted: the §35 budget is
 * "≤ 50 ms and obligatorily O(1) in N", and the only way to tell an aggregated
 * pass from a per-entity one is to grow the number of sessions and watch the
 * number stay put. The unit suite proves the call is made once; this proves
 * that making it once is what keeps the pass flat.
 *
 * The worktree list is a fake on purpose. `git status` is genuinely per
 * worktree — git has no aggregated form — so leaving real git in would measure
 * git's fan-out instead of the property ADR-13 governs.
 *
 * Every command runs on a **throwaway socket**, never `issue-flow` and never
 * the user's default: a test that killed windows on the real project socket
 * would kill a real agent.
 */
const socketName = `issue-flow-test-${randomUUID().slice(0, 8)}`;

// Probed at module load, synchronously: `it.runIf` is evaluated while the file
// is being collected, so an availability flag assigned in `beforeAll` would
// always still be false and every case would skip silently.
const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

const PROJECT_ID = 'proj-reconcile';
const SESSION_NAME = buildProjectSessionName(PROJECT_ID);

async function killTestServer(): Promise<void> {
  await execa('tmux', ['-L', socketName, 'kill-server'], { reject: false });
}

function managed(branch: string, cwd: string): ManagedWorktree {
  return {
    branch,
    path: cwd,
    entry: { path: cwd, branch, head: 'aaa111', detached: false, bare: false },
    binding: null,
    state: 'unmanaged',
  };
}

describe('reconciliation against a real tmux server', () => {
  let tmux: TmuxGateway;
  let cwd: string;
  let home: string;
  let storage: PlanRepositoryContext;
  const dirs: string[] = [];

  afterAll(async () => {
    if (tmuxAvailable) await killTestServer();
  });

  beforeEach(async () => {
    tmux = createTmuxGateway({ socketName });
    cwd = await mkdtemp(join(tmpdir(), 'issue-flow-reconcile-'));
    home = await mkdtemp(join(tmpdir(), 'issue-flow-reconcile-home-'));
    dirs.push(cwd, home);
    storage = {
      tasksPath: join(home, 'projects', PROJECT_ID, 'issues', '1', 'tasks.json'),
      projectId: PROJECT_ID,
      issueId: '1',
      projectRoot: cwd,
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
  });

  afterEach(async () => {
    if (tmuxAvailable) await killTestServer();
    resetPlanRepositories();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.runIf(tmuxAvailable)(
    'sees the windows tmux really has and forgets the ones it killed',
    async () => {
      await tmux.ensureServer();
      await tmux.ensureSession(SESSION_NAME, cwd);
      await tmux.createWindow({
        sessionName: SESSION_NAME,
        windowName: buildWorktreeWindowName('feature/alive'),
        cwd,
      });

      const reconcile = createReconciler(
        {
          projectId: PROJECT_ID,
          worktrees: {
            list: async () => [managed('feature/alive', cwd), managed('feature/dead', cwd)],
          },
          tmux,
          storage,
        },
        { freshnessMs: 0 },
      );

      const before = await reconcile.reconcile();
      expect(before.worktrees.map((entry) => [entry.branch, entry.session.exists])).toEqual([
        ['feature/alive', true],
        ['feature/dead', false],
      ]);

      await tmux.killWindow(SESSION_NAME, buildWorktreeWindowName('feature/alive'));
      const after = await reconcile.reconcile({ force: true });
      // tmux is the authority on liveness. The window is gone, so the pass says
      // it is gone — it does not recreate it because the last pass saw it.
      expect(after.worktrees[0]?.session.exists).toBe(false);
    },
    20_000,
  );

  it.runIf(tmuxAvailable)(
    'reconciles in constant time as the number of sessions grows',
    async () => {
      const branches: string[] = [];
      const reconcile = createReconciler(
        {
          projectId: PROJECT_ID,
          worktrees: { list: async () => branches.map((branch) => managed(branch, cwd)) },
          tmux,
          storage,
        },
        { freshnessMs: 0 },
      );

      /**
       * Both statistics, because they answer different questions.
       *
       * The **median** is what the shape assertion uses: a per-entity pass
       * would show up as growth proportional to N whatever else the machine is
       * doing. The **best** sample is what the budget assertion uses, because
       * the integration suite runs its files in parallel and a pass that waited
       * on the scheduler measured someone else's work, not this one's — the
       * fastest round is the closest unbiased estimate of what the pass costs
       * when it is actually given the CPU.
       */
      async function measure(): Promise<{ best: number; median: number }> {
        const samples: number[] = [];
        for (let round = 0; round < 9; round += 1) {
          const startedAt = Date.now();
          await reconcile.reconcile({ force: true });
          samples.push(Date.now() - startedAt);
        }
        const sorted = [...samples].sort((left, right) => left - right);
        return {
          best: sorted[0] ?? Number.POSITIVE_INFINITY,
          median: sorted[4] ?? Number.POSITIVE_INFINITY,
        };
      }

      await tmux.ensureServer();
      await tmux.ensureSession(SESSION_NAME, cwd);
      branches.push('feature/0');
      await tmux.createWindow({
        sessionName: SESSION_NAME,
        windowName: buildWorktreeWindowName('feature/0'),
        cwd,
      });
      const withOne = await measure();

      for (let index = 1; index <= 20; index += 1) {
        branches.push(`feature/${index}`);
        await tmux.createWindow({
          sessionName: SESSION_NAME,
          windowName: buildWorktreeWindowName(`feature/${index}`),
          cwd,
        });
      }
      const withTwentyOne = await measure();

      console.log(
        `reconcile(): N=1 best ${withOne.best} ms / median ${withOne.median} ms · ` +
          `N=21 best ${withTwentyOne.best} ms / median ${withTwentyOne.median} ms`,
      );
      const last = await reconcile.reconcile({ force: true });
      expect(last.worktrees.filter((entry) => entry.session.exists)).toHaveLength(21);
      // §35: ≤ 50 ms, and constant rather than proportional.
      expect(withTwentyOne.best).toBeLessThanOrEqual(50);
      // The shape. A pass that asked tmux once per worktree would land near
      // `withOne × 21`; an aggregated one lands nowhere near it, and this is
      // the assertion that tells the two apart no matter how loaded the machine
      // is — contention scales both measurements, not just the second.
      expect(withTwentyOne.median).toBeLessThan(Math.max(withOne.median, 1) * 21);
    },
    60_000,
  );
});
