import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PANES } from '../../runtime/profiles.js';
import { createTmuxGateway } from '../../runtime/tmux/gateway.js';
import { buildProjectSessionName, buildWorktreeWindowName } from '../../runtime/tmux/names.js';
import { createGitWorktreeGateway } from '../../runtime/worktree/git.js';
import { createWorktreeManager } from '../../runtime/worktree/lifecycle.js';
import { type PlanRepositoryContext, resetPlanRepositories } from '../../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../../storage/paths.js';
import { localBranchExists } from '../../utils/git.js';
import { type AgentSessionDeps, openAgentSession, stopAgentSession } from './open.js';
import { listSessions } from './store.js';
import { isFreeSession } from './types.js';

/**
 * S1, S2 and S3 of §49.5 against a **real** `git worktree add` and a **real**
 * tmux server, plus the §35 budget the path has to stay inside.
 *
 * The stubbed versions in `free-session.characterization.test.ts` assert the
 * decisions; these assert that the decisions survive contact with the two tools
 * that actually carry them out — a generated branch git will accept, a window
 * tmux will really create, and two projects that really do not collide.
 *
 * Everything runs on a throwaway tmux socket. A test that killed windows on the
 * `issue-flow` socket would kill a real agent someone is working with.
 */

// Probed at module load, synchronously: `it.runIf` is evaluated while the file
// is collected, so a flag assigned in `beforeAll` would always still be false
// and every case would skip in silence.
const gitAvailable = spawnSync('git', ['--version']).status === 0;
const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;
const ready = gitAvailable && tmuxAvailable;

const socketName = `issue-flow-test-${randomUUID().slice(0, 8)}`;

async function killTestServer(): Promise<void> {
  await execa('tmux', ['-L', socketName, 'kill-server'], { reject: false });
}

async function initRepository(root: string): Promise<void> {
  await execa('git', ['init', '--initial-branch=main'], { cwd: root });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: root });
  await writeFile(join(root, 'README.md'), '# fixture\n', 'utf-8');
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-m', 'initial'], { cwd: root });
}

describe('opening a free session for real', () => {
  const dirs: string[] = [];
  let home: string;

  afterAll(async () => {
    if (tmuxAvailable) await killTestServer();
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-free-home-'));
    dirs.push(home);
  });

  afterEach(async () => {
    if (tmuxAvailable) await killTestServer();
    resetPlanRepositories();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** A repository with its worktree container, and the deps that drive it. */
  async function fixture(projectId: string): Promise<{
    deps: AgentSessionDeps;
    storage: PlanRepositoryContext;
    root: string;
  }> {
    const workspace = await mkdtemp(join(tmpdir(), 'issue-flow-free-repo-'));
    dirs.push(workspace);
    const root = join(workspace, 'repo');
    await mkdir(root, { recursive: true });
    await initRepository(root);

    const storage: PlanRepositoryContext = {
      tasksPath: '',
      projectId,
      issueId: '',
      projectRoot: root,
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
    const git = createGitWorktreeGateway();
    return {
      root,
      storage,
      deps: {
        projectId,
        projectRoot: root,
        storage,
        worktrees: createWorktreeManager({ projectRoot: root, storage, mainBranch: 'main', git }),
        // A throwaway socket, never `issue-flow`: killing windows on the real
        // one would kill an agent somebody is working with.
        tmux: createTmuxGateway({ socketName }),
        git,
        branchExists: (branch) => localBranchExists(branch, root),
        panes: DEFAULT_PANES,
        profileName: 'default',
        shellPath: '/bin/sh',
      },
    };
  }

  it.runIf(ready)(
    'S1 — creates the worktree, the window and the row, with run/phase/story empty',
    async () => {
      const { deps, storage, root } = await fixture('proj-real-1');

      const opened = await openAgentSession(deps, {
        provider: 'claude',
        permission: 'workspace',
        label: 'real session',
      });

      expect(isFreeSession(opened.session)).toBe(true);
      expect(opened.branch).toMatch(/^session\/real-session-[0-9a-f]{8}$/);

      // git really has the branch and the worktree.
      const worktrees = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: root });
      expect(worktrees.stdout).toContain(opened.worktreePath);
      expect(await localBranchExists(opened.branch, root)).toBe(true);

      // tmux really has the window, with both panes of the default profile.
      const windows = await deps.tmux.listWindows();
      expect(windows).toContainEqual({
        sessionName: buildProjectSessionName('proj-real-1'),
        windowName: buildWorktreeWindowName(opened.branch),
        paneCount: DEFAULT_PANES.length,
      });

      // And exactly one row, with the three columns empty.
      const rows = await listSessions(storage);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ runId: null, phase: null, storyId: null });
    },
    60_000,
  );

  it.runIf(ready)(
    'S2 — three free sessions and a workflow session live in four distinct windows',
    async () => {
      const { deps, storage } = await fixture('proj-real-2');

      const opened = [];
      for (const label of ['one', 'two', 'three']) {
        opened.push(
          await openAgentSession(deps, { provider: 'claude', permission: 'workspace', label }),
        );
      }
      opened.push(
        await openAgentSession(deps, {
          provider: 'claude',
          permission: 'workspace',
          branch: 'feat/42-thing',
          runId: 'run-42',
          phase: 'execute',
        }),
      );

      // `ensureSession` leaves tmux's own default window behind, named after
      // the shell; only the ones this project created carry the prefix.
      const windows = (await deps.tmux.listWindows()).filter(
        (window) =>
          window.sessionName === buildProjectSessionName('proj-real-2') &&
          window.windowName.startsWith('if-'),
      );
      expect(windows).toHaveLength(4);
      expect(new Set(opened.map((entry) => entry.paneTarget)).size).toBe(4);

      const rows = await listSessions(storage);
      expect(rows).toHaveLength(4);
      expect(rows.filter(isFreeSession)).toHaveLength(3);
    },
    120_000,
  );

  it.runIf(ready)(
    'S3 — the same branch name in two projects lands in two tmux sessions',
    async () => {
      const first = await fixture('proj-real-3a');
      const second = await fixture('proj-real-3b');

      const a = await openAgentSession(first.deps, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'session/same-name',
      });
      const b = await openAgentSession(second.deps, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'session/same-name',
      });

      expect(a.paneTarget).not.toBe(b.paneTarget);
      const sessionNames = new Set(
        (await first.deps.tmux.listWindows()).map((window) => window.sessionName),
      );
      expect(sessionNames.has(buildProjectSessionName('proj-real-3a'))).toBe(true);
      expect(sessionNames.has(buildProjectSessionName('proj-real-3b'))).toBe(true);

      expect(await listSessions(first.storage)).toHaveLength(1);
      expect(await listSessions(second.storage)).toHaveLength(1);
    },
    120_000,
  );

  it.runIf(ready)(
    'reopening a session whose agent is still running reattaches instead of rebuilding (§27)',
    async () => {
      const { deps } = await fixture('proj-real-4');

      const first = await openAgentSession(deps, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'session/keep-alive',
      });
      const second = await openAgentSession(deps, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'session/keep-alive',
      });

      expect(first.layout.mode).toBe('fresh');
      expect(second.layout.mode).toBe('reattach');
      // The same row, not a second one: the conversation was never restarted.
      expect(second.session.id).toBe(first.session.id);
    },
    60_000,
  );

  it.runIf(ready)(
    'stopping the last session on a branch kills its window and keeps the worktree',
    async () => {
      const { deps, root } = await fixture('proj-real-5');
      const opened = await openAgentSession(deps, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'session/stop-me',
      });

      await stopAgentSession(deps, opened.session);

      expect(
        (await deps.tmux.listWindows()).filter((window) => window.windowName.startsWith('if-')),
      ).toEqual([]);
      // The work survives: removing it is a separate, explicit request.
      const worktrees = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: root });
      expect(worktrees.stdout).toContain(opened.worktreePath);
    },
    60_000,
  );

  it.runIf(ready)(
    'stays inside the §35 T0→T4 budget of 600 ms for worktree + agent started',
    async () => {
      const { deps } = await fixture('proj-real-6');
      const samples: number[] = [];

      for (let index = 0; index < 3; index++) {
        const startedAt = performance.now();
        await openAgentSession(deps, {
          provider: 'claude',
          permission: 'workspace',
          branch: `session/budget-${index}`,
        });
        samples.push(performance.now() - startedAt);
      }

      const median = [...samples].sort((left, right) => left - right)[1] as number;
      // Reported either way: a budget nobody can read the number of is a
      // budget nobody notices drifting.
      console.log(`T0→T4 median over ${samples.length} runs: ${median.toFixed(0)} ms`);
      expect(median).toBeLessThanOrEqual(600);
    },
    120_000,
  );

  it.runIf(gitAvailable && !tmuxAvailable)(
    'refuses to open a session without tmux instead of pretending to (ADR-03)',
    async () => {
      const { deps } = await fixture('proj-real-7');
      await expect(
        openAgentSession(deps, { provider: 'claude', permission: 'workspace' }),
      ).rejects.toThrow('needs tmux');
    },
    60_000,
  );
});
