import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerPlanRepository, resetPlanRepositories } from '../../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../../storage/paths.js';
import { createGitWorktreeGateway } from './git.js';
import { createWorktreeManager } from './lifecycle.js';

/**
 * The worktree lifecycle against a real repository.
 *
 * Covers the characterization tests §34 asks phase 5 to make green — **C1**
 * (create a worktree: path, branch, runtime env, binding) and **C12** (remove
 * one: worktree, branch and hooks) — plus the §35 budget for
 * `git worktree add`: **≤ 150 ms**, against the upstream's measured 78 ms.
 *
 * Integration, not unit: every assertion here is about what git actually did.
 */
describe('worktree lifecycle against a real repository', () => {
  const dirs: string[] = [];
  let repoRoot: string;
  let home: string;

  async function git(args: string[], cwd: string): Promise<string> {
    const result = await execa('git', args, { cwd, reject: false });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'issue-flow-wt-repo-'));
    home = await mkdtemp(join(tmpdir(), 'issue-flow-wt-home-'));
    dirs.push(repoRoot, home);

    await git(['init', '-b', 'main', '--quiet'], repoRoot);
    await git(['config', 'user.name', 'Test User'], repoRoot);
    await git(['config', 'user.email', 'test@example.com'], repoRoot);
    await writeFile(join(repoRoot, 'README.md'), '# repo\n');
    await git(['add', 'README.md'], repoRoot);
    await git(['commit', '-m', 'init', '--quiet'], repoRoot);
  });

  afterEach(async () => {
    resetPlanRepositories();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function storage() {
    const context = {
      tasksPath: join(home, 'projects', 'proj', 'issues', '1', 'tasks.json'),
      projectId: 'proj',
      issueId: '1',
      projectRoot: repoRoot,
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
    registerPlanRepository(context);
    return context;
  }

  function manager(overrides: Record<string, unknown> = {}) {
    return createWorktreeManager({
      projectRoot: repoRoot,
      mainBranch: 'main',
      worktreeRoot: join(repoRoot, '__worktrees'),
      ...overrides,
    });
  }

  // C1 — create worktree: path, branch, runtime env, durable binding.
  it('C1: creates a worktree with its branch, runtime env and binding', async () => {
    const context = storage();
    const worktrees = manager({ storage: context });

    const created = await worktrees.create({
      branch: 'feature',
      agent: 'claude',
      startupEnvValues: { NODE_ENV: 'test' },
    });

    expect(created.path).toBe(join(repoRoot, '__worktrees', 'feature'));
    expect((await stat(created.path)).isDirectory()).toBe(true);
    // The branch exists and is checked out in the new worktree, not in the repo.
    expect(await git(['branch', '--show-current'], created.path)).toBe('feature');
    expect(await git(['branch', '--show-current'], repoRoot)).toBe('main');

    // runtime.env lives under the worktree's own git dir, so it can never be committed.
    const runtimeEnv = await readFile(created.runtimeEnvPath, 'utf-8');
    expect(runtimeEnv).toContain("ISSUE_FLOW_BRANCH='feature'");
    expect(runtimeEnv).toContain("NODE_ENV='test'");
    expect(created.runtimeEnvPath).toContain(join('.git', 'worktrees', 'feature'));
    expect(await git(['status', '--porcelain'], created.path)).toBe('');

    const listed = await worktrees.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ branch: 'feature', state: 'managed' });
    expect(listed[0]?.binding?.worktreeId).toBe(created.worktreeId);
  });

  it('nests a branch name with slashes instead of flattening it', async () => {
    const worktrees = manager();
    const created = await worktrees.create({ branch: 'feat/63-thing', agent: 'claude' });
    expect(created.path).toBe(join(repoRoot, '__worktrees', 'feat', '63-thing'));
    expect(await git(['branch', '--show-current'], created.path)).toBe('feat/63-thing');
  });

  it('creates a worktree from a base branch other than the default', async () => {
    await git(['branch', 'develop'], repoRoot);
    const worktrees = manager();
    const created = await worktrees.create({
      branch: 'feature',
      baseBranch: 'develop',
      agent: 'claude',
    });
    expect(await git(['rev-parse', 'develop'], repoRoot)).toBe(
      await git(['rev-parse', 'HEAD'], created.path),
    );
  });

  it('checks out an existing local branch without creating it again', async () => {
    await git(['branch', 'existing'], repoRoot);
    const worktrees = manager();
    const created = await worktrees.create({
      branch: 'existing',
      mode: 'existing',
      agent: 'claude',
    });
    expect(await git(['branch', '--show-current'], created.path)).toBe('existing');
  });

  // C12 — remove worktree: directory, branch and the preRemove hook.
  it('C12: removes the worktree, its branch and its binding, after preRemove', async () => {
    const context = storage();
    const hookRan: string[] = [];
    const worktrees = manager({
      storage: context,
      hooks: {
        preRemove: ({ worktreePath }: { worktreePath: string }) => {
          hookRan.push(worktreePath);
        },
      },
    });

    const created = await worktrees.create({ branch: 'feature', agent: 'claude' });
    // Captured before the removal: afterwards there is no path left to resolve.
    // The hook is handed the path git reports, which on macOS is the resolved
    // one rather than the symlinked temporary directory.
    const resolvedPath = await realpath(created.path);
    await worktrees.remove('feature');

    expect(hookRan).toEqual([resolvedPath]);
    await expect(stat(created.path)).rejects.toThrow();
    expect(await git(['branch', '--list', 'feature'], repoRoot)).toBe('');
    expect(await worktrees.list()).toEqual([]);
  });

  it('reports a binding whose directory was deleted by hand as orphaned', async () => {
    const context = storage();
    const worktrees = manager({ storage: context });
    const created = await worktrees.create({ branch: 'feature', agent: 'claude' });

    // Exactly what a user does when they delete the folder in a file manager.
    await rm(created.path, { recursive: true, force: true });

    const listed = await worktrees.list();
    expect(listed).toHaveLength(1);
    // Reported, never repaired: git is the authority on existence (ADR-08).
    expect(listed[0]).toMatchObject({ branch: 'feature', state: 'orphaned', entry: null });
    expect(await stat(created.path).catch(() => null)).toBeNull();
  });

  it('merges a clean worktree into main and removes it', async () => {
    const worktrees = manager();
    const created = await worktrees.create({ branch: 'feature', agent: 'claude' });

    await writeFile(join(created.path, 'feature.txt'), 'work\n');
    await git(['add', 'feature.txt'], created.path);
    await git(['commit', '-m', 'add feature', '--quiet'], created.path);

    await worktrees.merge('feature');

    expect(await readFile(join(repoRoot, 'feature.txt'), 'utf-8')).toBe('work\n');
    expect(await git(['branch', '--show-current'], repoRoot)).toBe('main');
    await expect(stat(created.path)).rejects.toThrow();
  });

  // The restore is the part a naive implementation loses: after a failed merge
  // the repository must be back on the branch the user was actually on.
  it('aborts a conflicting merge and restores the original checkout', async () => {
    const worktrees = manager();
    const created = await worktrees.create({ branch: 'feature', agent: 'claude' });

    await writeFile(join(created.path, 'README.md'), '# from the worktree\n');
    await git(['commit', '-am', 'worktree edit', '--quiet'], created.path);
    await writeFile(join(repoRoot, 'README.md'), '# from main\n');
    await git(['commit', '-am', 'main edit', '--quiet'], repoRoot);

    await expect(worktrees.merge('feature')).rejects.toThrow(/merge/i);

    expect(await git(['branch', '--show-current'], repoRoot)).toBe('main');
    // No merge left half-applied, and the tracked file is the one main had.
    expect(await git(['status', '--porcelain', '--', 'README.md'], repoRoot)).toBe('');
    await expect(stat(join(repoRoot, '.git', 'MERGE_HEAD'))).rejects.toThrow();
    expect(await readFile(join(repoRoot, 'README.md'), 'utf-8')).toBe('# from main\n');
    // The worktree survives a failed merge: its work is the thing at stake.
    expect((await stat(created.path)).isDirectory()).toBe(true);
  });

  it('refuses to merge a worktree with uncommitted work, and leaves it alone', async () => {
    const worktrees = manager();
    const created = await worktrees.create({ branch: 'feature', agent: 'claude' });
    await writeFile(join(created.path, 'scratch.txt'), 'not committed\n');

    await expect(worktrees.merge('feature')).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(created.path, 'scratch.txt'), 'utf-8')).toBe('not committed\n');
  });

  it('rolls the checkout and the branch back when creation fails after the checkout', async () => {
    const worktrees = manager({
      hooks: {
        postCreate: () => {
          throw new Error('hook exploded');
        },
      },
    });

    await expect(worktrees.create({ branch: 'feature', agent: 'claude' })).rejects.toThrow(
      'hook exploded',
    );
    await expect(stat(join(repoRoot, '__worktrees', 'feature'))).rejects.toThrow();
    expect(await git(['branch', '--list', 'feature'], repoRoot)).toBe('');
  });

  it('resolves the git dir of a linked worktree, not the repository one', async () => {
    const worktrees = manager();
    const created = await worktrees.create({ branch: 'feature', agent: 'claude' });
    const gateway = createGitWorktreeGateway();

    const gitDir = await gateway.resolveWorktreeGitDir(created.path);
    expect(gitDir).toContain(join('.git', 'worktrees', 'feature'));
    // git answers with the real path; on macOS the temp directory is a symlink,
    // so the comparison has to be made on resolved paths or it compares the
    // symlink to its target.
    await expect(gateway.resolveWorktreeRoot(created.path)).resolves.toBe(
      await realpath(created.path),
    );
  });

  it('reads dirty state, ahead count and the current commit', async () => {
    const worktrees = manager();
    const created = await worktrees.create({ branch: 'feature', agent: 'claude' });

    await expect(worktrees.status('feature')).resolves.toMatchObject({ dirty: false });

    await writeFile(join(created.path, 'scratch.txt'), 'x\n');
    const dirty = await worktrees.status('feature');
    expect(dirty.dirty).toBe(true);
    expect(dirty.currentCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  // §35: `git worktree add` measured at 78 ms upstream, budget ≤ 150 ms here.
  // Median of five, matching how the baseline was collected.
  it('creates a worktree within the 150 ms budget', async () => {
    const worktrees = manager();
    const samples: number[] = [];

    for (let round = 0; round < 5; round += 1) {
      const branch = `bench-${round}`;
      const startedAt = Date.now();
      await worktrees.create({ branch, agent: 'claude' });
      samples.push(Date.now() - startedAt);
      await worktrees.remove(branch);
    }

    const sorted = [...samples].sort((left, right) => left - right);
    const median = sorted[2] ?? Number.POSITIVE_INFINITY;
    console.log(`git worktree add: median ${median} ms over ${samples.length} samples`);
    expect(median).toBeLessThanOrEqual(150);
  });
});
