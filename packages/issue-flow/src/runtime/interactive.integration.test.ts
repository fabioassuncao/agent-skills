import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSessionDeps } from '../agents/session/open.js';
import { listSessions } from '../agents/session/store.js';
import type { AgentInvocation, ResolvedAgentSettings } from '../agents/types.js';
import { type PlanRepositoryContext, resetPlanRepositories } from '../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { localBranchExists } from '../utils/git.js';
import { createInteractiveRuntime, type PaneRuntimeDeps } from './interactive.js';
import { DEFAULT_PANES } from './profiles.js';
import { createTmuxGateway } from './tmux/gateway.js';
import { buildProjectSessionName, buildWorktreeWindowName } from './tmux/names.js';
import { createGitWorktreeGateway } from './worktree/git.js';
import { createWorktreeManager } from './worktree/lifecycle.js';

/**
 * The `interactive` runtime against a real `git worktree add` and a real tmux
 * server.
 *
 * The unit suite asserts the decisions; this asserts that they survive contact
 * with the two tools that carry them out — a worktree git really creates, a
 * window tmux really opens, a `prepare` that runs twice and reattaches rather
 * than rebuilding, and a `dispose` that leaves the branch alone when asked to.
 *
 * The agent binary is not assumed to exist: the pane's shell stays, and the
 * agent command typed into it may well answer "command not found". What is
 * verified here is the *layout* — the part tmux owns — and the worktree, which
 * is the part git owns.
 *
 * Everything runs on a throwaway socket. A test that killed windows on the
 * `issue-flow` socket would kill a real agent somebody is working with.
 */

// Probed at module load, synchronously: `it.runIf` is evaluated while the file
// is collected, so a flag assigned in `beforeAll` would always still be false
// and every case would skip in silence.
const gitAvailable = spawnSync('git', ['--version']).status === 0;
const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;
const ready = gitAvailable && tmuxAvailable;

const socketName = `issue-flow-test-${randomUUID().slice(0, 8)}`;

const SETTINGS: ResolvedAgentSettings = {
  provider: 'claude',
  model: null,
  claude: {},
  codex: {},
  cursor: {},
  antigravity: {},
  opencode: {},
  origin: { provider: 'default', model: 'default' },
};

const INVOCATION: AgentInvocation = {
  prompt: 'look at the parser',
  phase: 'execute',
  timeout: 0,
  permission: 'workspace',
};

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

describe('the interactive runtime against real git and tmux', () => {
  const dirs: string[] = [];
  let home: string;

  afterAll(async () => {
    if (tmuxAvailable) await killTestServer();
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-interactive-home-'));
    dirs.push(home);
  });

  afterEach(async () => {
    if (tmuxAvailable) await killTestServer();
    resetPlanRepositories();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture(projectId: string): Promise<{
    deps: PaneRuntimeDeps;
    storage: PlanRepositoryContext;
    root: string;
  }> {
    const workspace = await mkdtemp(join(tmpdir(), 'issue-flow-interactive-repo-'));
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
    const session: AgentSessionDeps = {
      projectId,
      projectRoot: root,
      storage,
      worktrees: createWorktreeManager({ projectRoot: root, storage, mainBranch: 'main', git }),
      tmux: createTmuxGateway({ socketName }),
      git,
      branchExists: (branch) => localBranchExists(branch, root),
      panes: DEFAULT_PANES,
      profileName: 'default',
      shellPath: '/bin/sh',
    };

    return {
      root,
      storage,
      deps: {
        session,
        provider: 'claude',
        // No hooks and no lifecycle rows: this file is about the layout, and
        // the outcome path has its own deterministic cases in the unit suite.
        startHooks: async () => null,
        lifecycle: { list: async () => [] },
        scheduler: { scheduleEvery: () => 1, cancelSchedule: () => {} },
      },
    };
  }

  it.runIf(ready)('prepares a worktree and the project session, then launches a pane', async () => {
    const { deps, storage, root } = await fixture('proj-int-1');
    const runtime = createInteractiveRuntime(deps);

    const prepared = await runtime.prepare({
      projectRoot: root,
      branch: 'feat/interactive',
      runId: 'run-1',
    });

    expect(prepared.isolation).toBe('worktree');
    expect(prepared.session?.createdWorktree).toBe(true);
    const worktrees = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: root });
    expect(worktrees.stdout).toContain('feat/interactive');

    await runtime.launch(prepared, INVOCATION, SETTINGS);

    const sessionName = buildProjectSessionName('proj-int-1');
    const windowName = buildWorktreeWindowName('feat/interactive');
    const windows = await execa(
      'tmux',
      ['-L', socketName, 'list-windows', '-a', '-F', '#{session_name}\t#{window_name}'],
      { reject: false },
    );
    expect(windows.stdout).toContain(`${sessionName}\t${windowName}`);

    const rows = await listSessions(storage, { branch: 'feat/interactive' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBe('run-1');
    expect(rows[0]?.paneTarget).toMatch(/^%\d+$/);
    await expect(deps.session.tmux.getPaneIdentity?.(rows[0]!.paneTarget)).resolves.toMatchObject({
      sessionName,
      windowName,
    });
  });

  it.runIf(ready)('reuses the worktree on a second prepare instead of recreating it', async () => {
    const { deps, root } = await fixture('proj-int-2');
    const runtime = createInteractiveRuntime(deps);

    const first = await runtime.prepare({
      projectRoot: root,
      branch: 'feat/reuse',
      runId: 'run-1',
    });
    const second = await runtime.prepare({
      projectRoot: root,
      branch: 'feat/reuse',
      runId: 'run-2',
    });

    expect(first.session?.createdWorktree).toBe(true);
    // The second one found it. This is what makes `dispose` able to say it did
    // not create what it is being asked to remove.
    expect(second.session?.createdWorktree).toBe(false);
    // Compared through `realpath` rather than by string: both prepares answer
    // with the path `git worktree list` reports, and on macOS the temporary
    // directory is a symlink, so nothing here should depend on which spelling
    // git happened to print.
    expect(await realpath(second.workdir)).toBe(await realpath(first.workdir));
  });

  it.runIf(ready)('removes the worktree it created while keeping the branch', async () => {
    const { deps, root } = await fixture('proj-int-3');
    const runtime = createInteractiveRuntime(deps);

    const prepared = await runtime.prepare({
      projectRoot: root,
      branch: 'feat/keep-branch',
      runId: 'run-1',
    });
    await runtime.launch(prepared, INVOCATION, SETTINGS);

    await runtime.dispose(prepared, { removeWorktree: true, keepBranch: true });

    const worktrees = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: root });
    expect(worktrees.stdout).not.toContain('feat/keep-branch');
    // The branch is the only thing still holding the work once the directory is
    // gone, so `keepBranch` has to actually keep it.
    expect(await localBranchExists('feat/keep-branch', root)).toBe(true);

    const windows = await execa('tmux', ['-L', socketName, 'list-windows', '-a'], {
      reject: false,
    });
    expect(windows.stdout).not.toContain(buildWorktreeWindowName('feat/keep-branch'));
  });

  /**
   * §35: T0→T4 — worktree ready and agent started — has a budget of 600 ms.
   *
   * `open.integration.test.ts` measures the same path from the session side;
   * this measures it as the pipeline reaches it, through `prepare` + `launch`,
   * which is the pair that adds the port allocation and the hook session on top.
   */
  it.runIf(ready)(
    'prepares and launches inside the 600 ms T0→T4 budget',
    async () => {
      const { deps, root } = await fixture('proj-int-5');
      const runtime = createInteractiveRuntime(deps);
      const samples: number[] = [];

      for (let index = 0; index < 3; index += 1) {
        const branch = `feat/budget-${index}`;
        const started = performance.now();
        const prepared = await runtime.prepare({
          projectRoot: root,
          branch,
          runId: `run-${index}`,
        });
        await runtime.launch(prepared, INVOCATION, SETTINGS);
        samples.push(performance.now() - started);
      }

      const median =
        [...samples].sort((left, right) => left - right)[1] ?? Number.POSITIVE_INFINITY;
      console.log(`prepare + launch: median ${Math.round(median)} ms over ${samples.length}`);
      expect(median).toBeLessThanOrEqual(600);
    },
    30_000,
  );

  it.runIf(ready)('refuses the mode rather than degrading when tmux is missing', async () => {
    const { deps, root } = await fixture('proj-int-4');
    const runtime = createInteractiveRuntime({
      ...deps,
      session: { ...deps.session, tmux: { ...deps.session.tmux, isAvailable: async () => false } },
    });

    await expect(
      runtime.prepare({ projectRoot: root, branch: 'feat/no-tmux', runId: 'run-1' }),
    ).rejects.toThrow(/needs tmux/);

    // Nothing was created: a refusal that left a worktree behind would be worse
    // than the fallback it is refusing to make.
    const worktrees = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: root });
    expect(worktrees.stdout).not.toContain('feat/no-tmux');
  });
});
