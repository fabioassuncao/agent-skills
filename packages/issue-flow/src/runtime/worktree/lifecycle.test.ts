import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isValidBranchName } from '../../conventions/git/slug.js';
import { acquireRunLock } from '../../storage/lock.js';
import type {
  CreateWorktreeOptions,
  GitCommandResult,
  GitWorktreeEntry,
  GitWorktreeGateway,
  RemoveWorktreeOptions,
  WorktreeStatus,
} from './git.js';
import { createWorktreeManager, WorktreeError, type WorktreeManagerOptions } from './lifecycle.js';
import { getWorktreeMutationLockPath } from './lock.js';

/**
 * The behaviour of `lifecycle-service.ts` that survives the narrowing, driven
 * against a gateway double so the assertions are about the decisions and not
 * about git. The cases that need a real repository — creation, removal, merge
 * with a conflict — are in `lifecycle.integration.test.ts`.
 */

interface FakeGitState {
  localBranches: string[];
  remoteBranches: string[];
  worktrees: GitWorktreeEntry[];
  liveWorktrees?: GitWorktreeEntry[];
  status?: WorktreeStatus;
  failCreate?: string;
  failRemove?: string;
}

interface FakeGit extends GitWorktreeGateway {
  calls: string[];
}

function fakeGit(state: FakeGitState): FakeGit {
  const calls: string[] = [];
  const ok: GitCommandResult = { ok: true, stdout: '' };
  return {
    calls,
    resolveRepoRoot: async () => '/repo',
    resolveWorktreeRoot: async (cwd) => cwd,
    resolveWorktreeGitDir: async (cwd) => join(cwd, '.git'),
    listWorktrees: async () => state.worktrees,
    listLiveWorktrees: async () => state.liveWorktrees ?? state.worktrees,
    listLocalBranches: async () => state.localBranches,
    listRemoteBranches: async () => state.remoteBranches,
    readWorktreeStatus: async () =>
      state.status ?? { dirty: false, aheadCount: 0, currentCommit: 'abc' },
    readStatus: async () => '',
    createWorktree: async (options: CreateWorktreeOptions) => {
      calls.push(`create:${options.branch}:${options.mode}`);
      if (state.failCreate !== undefined) throw new Error(state.failCreate);
    },
    removeWorktree: async (options: RemoveWorktreeOptions) => {
      calls.push(`remove:${options.worktreePath}`);
      if (state.failRemove !== undefined) throw new Error(state.failRemove);
    },
    deleteBranch: async (_root, branch, force) => {
      calls.push(`delete-branch:${branch}:${force === true}`);
    },
    mergeBranch: async (options) => {
      calls.push(`merge:${options.sourceBranch}->${options.targetBranch}`);
    },
    currentBranch: async () => 'main',
    readDiff: async () => '',
    listUnpushedCommits: async () => [],
    fetchBranch: async () => ok,
    fastForwardMerge: async () => ok,
  };
}

function entry(path: string, branch: string | null): GitWorktreeEntry {
  return { path, branch, head: 'abc', detached: false, bare: false };
}

// The validator lives in `src/conventions/git/slug.ts` — one opinion about what
// git accepts, for the whole project. These cases pin down what the worktree
// manager relies on it for.
describe('isValidBranchName, as the worktree manager needs it', () => {
  it('accepts the names this project actually generates', () => {
    expect(isValidBranchName('feat/63-execucao-autonoma')).toBe(true);
    expect(isValidBranchName('fix/72-timeout')).toBe(true);
    expect(isValidBranchName('main')).toBe(true);
  });

  // Refused before reaching a command line rather than quoted around, so a bad
  // name never becomes a confusing git error halfway through a creation.
  it('refuses what git refuses, and a leading dash', () => {
    expect(isValidBranchName('')).toBe(false);
    expect(isValidBranchName('-feature')).toBe(false);
    expect(isValidBranchName('/feature')).toBe(false);
    expect(isValidBranchName('feature/')).toBe(false);
    expect(isValidBranchName('feature.lock')).toBe(false);
    expect(isValidBranchName('feature.')).toBe(false);
    expect(isValidBranchName('a..b')).toBe(false);
    expect(isValidBranchName('a//b')).toBe(false);
    expect(isValidBranchName('a@{b')).toBe(false);
    expect(isValidBranchName('has space')).toBe(false);
    expect(isValidBranchName('has~tilde')).toBe(false);
    expect(isValidBranchName('has:colon')).toBe(false);
    expect(isValidBranchName('has?question')).toBe(false);
    expect(isValidBranchName('has*star')).toBe(false);
    expect(isValidBranchName('has[bracket')).toBe(false);
    expect(isValidBranchName('a'.repeat(256))).toBe(false);
  });
});

describe('worktree lifecycle', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'issue-flow-worktree-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  function manager(state: FakeGitState, overrides: Partial<WorktreeManagerOptions> = {}) {
    const git = fakeGit(state);
    return {
      git,
      worktrees: createWorktreeManager({
        projectRoot: repoRoot,
        mainBranch: 'main',
        worktreeRoot: join(repoRoot, '__worktrees'),
        git,
        ...overrides,
      }),
    };
  }

  const clean: FakeGitState = { localBranches: ['main'], remoteBranches: [], worktrees: [] };

  it('puts every manager mutation behind the durable branch lock', async () => {
    const lockDir = join(repoRoot, 'mutation-locks');
    const acquired = await acquireRunLock(getWorktreeMutationLockPath(lockDir, 'feature'), {
      target: 'worktree:feature',
      pid: process.ppid,
      heartbeat: false,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const { git, worktrees } = manager(clean, { mutationLockDir: lockDir });

    try {
      const operations = [
        () => worktrees.create({ branch: 'feature', agent: 'claude' }),
        () => worktrees.remove('feature'),
        () => worktrees.merge('feature'),
        () => worktrees.setArchived('feature', true),
        () => worktrees.setLabel('feature', 'label'),
        () => worktrees.setProfile('feature', 'default'),
      ];
      for (const operation of operations) {
        await expect(operation()).rejects.toThrow('is being changed by');
      }
      expect(git.calls).toEqual([]);
    } finally {
      await acquired.handle.release();
    }
  });

  it('creates a new worktree, writes runtime.env and reports every phase', async () => {
    const phases: string[] = [];
    const { git, worktrees } = manager(clean, {
      onProgress: (progress) => phases.push(progress.phase),
    });

    const created = await worktrees.create({ branch: 'feature', agent: 'claude' });

    expect(git.calls).toContain('create:feature:new');
    expect(created.branch).toBe('feature');
    expect(created.worktreeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.path).toBe(join(repoRoot, '__worktrees', 'feature'));
    expect(created.meta.baseBranch).toBe('main');
    expect(phases).toEqual(['creating_worktree', 'running_post_create_hook', 'preparing_runtime']);

    const runtimeEnv = await readFile(created.runtimeEnvPath, 'utf-8');
    expect(runtimeEnv).toContain(`ISSUE_FLOW_BRANCH='feature'`);
    expect(runtimeEnv).toContain(`ISSUE_FLOW_AGENT='claude'`);
    // Nothing is left in the creation tracker once it finished, successfully or not.
    expect(worktrees.creating()).toEqual([]);
  });

  it('refuses a base branch equal to the branch, and one on an existing worktree', async () => {
    const { worktrees } = manager(clean);
    await expect(
      worktrees.create({ branch: 'feature', baseBranch: 'feature', agent: 'claude' }),
    ).rejects.toThrow('Base branch must differ');
    await expect(
      worktrees.create({
        branch: 'feature',
        mode: 'existing',
        baseBranch: 'main',
        agent: 'claude',
      }),
    ).rejects.toThrow('only supported for new worktrees');
  });

  it('refuses to create a branch that already exists', async () => {
    const { worktrees } = manager({ ...clean, localBranches: ['main', 'feature'] });
    await expect(worktrees.create({ branch: 'feature', agent: 'claude' })).rejects.toMatchObject({
      status: 409,
      message: 'Branch already exists: feature',
    });
  });

  // A stale registration still holds its branch in git's view, so it must keep
  // blocking reuse — which is why availability reads the raw list, not the live one.
  it('refuses an existing branch that a stale worktree registration still holds', async () => {
    const { worktrees } = manager({
      localBranches: ['main', 'feature'],
      remoteBranches: [],
      worktrees: [entry('/gone', 'feature')],
      liveWorktrees: [],
    });
    await expect(
      worktrees.create({ branch: 'feature', mode: 'existing', agent: 'claude' }),
    ).rejects.toMatchObject({ status: 409, message: 'Branch already has a worktree: feature' });
  });

  it('creates a local branch from the remote when it only exists there', async () => {
    const { git, worktrees } = manager({
      localBranches: ['main'],
      remoteBranches: ['feature'],
      worktrees: [],
    });
    await worktrees.create({ branch: 'feature', mode: 'existing', agent: 'claude' });
    expect(git.calls).toContain('create:feature:existing');
  });

  it('answers 404 for a branch that exists nowhere', async () => {
    const { worktrees } = manager(clean);
    await expect(
      worktrees.create({ branch: 'nope', mode: 'existing', agent: 'claude' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an invalid branch name before touching git', async () => {
    const { git, worktrees } = manager(clean);
    await expect(worktrees.create({ branch: 'bad name', agent: 'claude' })).rejects.toThrow(
      'Invalid branch name',
    );
    expect(git.calls).toEqual([]);
  });

  // Two concurrent creations of the same branch race into a half-created
  // checkout that neither rollback owns.
  it('refuses a second creation of a branch already being created', async () => {
    const { worktrees } = manager(clean, {
      hooks: {
        postCreate: async () => {
          await expect(worktrees.create({ branch: 'feature', agent: 'claude' })).rejects.toThrow(
            'already being created',
          );
        },
      },
    });
    await worktrees.create({ branch: 'feature', agent: 'claude' });
  });

  describe('rollback', () => {
    it('removes the checkout and deletes the branch it created', async () => {
      const { git, worktrees } = manager(clean, {
        hooks: {
          postCreate: () => {
            throw new Error('hook exploded');
          },
        },
      });

      await expect(worktrees.create({ branch: 'feature', agent: 'claude' })).rejects.toThrow(
        'hook exploded',
      );
      expect(git.calls).toContain(`remove:${join(repoRoot, '__worktrees', 'feature')}`);
      expect(git.calls).toContain('delete-branch:feature:true');
    });

    // Only a branch this creation brought into existence is deleted. Deleting a
    // pre-existing local branch because a rollback ran would destroy work.
    it('keeps a pre-existing local branch that it did not create', async () => {
      const { git, worktrees } = manager(
        {
          localBranches: ['main', 'feature'],
          remoteBranches: [],
          worktrees: [],
        },
        {
          hooks: {
            postCreate: () => {
              throw new Error('hook exploded');
            },
          },
        },
      );

      await expect(
        worktrees.create({ branch: 'feature', mode: 'existing', agent: 'claude' }),
      ).rejects.toThrow('hook exploded');
      expect(git.calls.some((call) => call.startsWith('delete-branch:'))).toBe(false);
    });

    it('reports cleanup failures alongside the original cause, never instead of it', async () => {
      const { worktrees } = manager(
        { ...clean, failRemove: 'directory busy' },
        {
          hooks: {
            postCreate: () => {
              throw new Error('hook exploded');
            },
          },
        },
      );

      await expect(worktrees.create({ branch: 'feature', agent: 'claude' })).rejects.toThrow(
        /hook exploded; worktree cleanup failed: directory busy/,
      );
    });

    it('does not roll back a creation that never got as far as the checkout', async () => {
      const { git, worktrees } = manager({ ...clean, failCreate: 'no space left' });
      await expect(worktrees.create({ branch: 'feature', agent: 'claude' })).rejects.toThrow(
        'no space left',
      );
      expect(git.calls.some((call) => call.startsWith('remove:'))).toBe(false);
    });
  });

  describe('remove', () => {
    it('runs preRemove and the runtime teardown before git touches anything', async () => {
      const order: string[] = [];
      const { git, worktrees } = manager(
        { ...clean, worktrees: [entry(join(repoRoot, '__worktrees', 'feature'), 'feature')] },
        {
          hooks: {
            preRemove: () => {
              order.push('preRemove');
            },
            disposeRuntime: () => {
              order.push('disposeRuntime');
            },
          },
        },
      );

      await worktrees.remove('feature');
      expect(order).toEqual(['preRemove', 'disposeRuntime']);
      expect(git.calls).toEqual([
        `remove:${join(repoRoot, '__worktrees', 'feature')}`,
        'delete-branch:feature:true',
      ]);
    });

    it('answers 404 for a branch with no worktree', async () => {
      const { worktrees } = manager(clean);
      await expect(worktrees.remove('feature')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('merge', () => {
    // Built per test: repoRoot only exists after beforeEach has run.
    const withWorktree = (): FakeGitState => ({
      ...clean,
      worktrees: [entry(join(repoRoot, '__worktrees', 'feature'), 'feature')],
    });

    it('merges into the main branch and removes the worktree', async () => {
      const { git, worktrees } = manager(withWorktree());
      await worktrees.merge('feature');
      expect(git.calls).toContain('merge:feature->main');
      expect(git.calls).toContain('delete-branch:feature:true');
    });

    // Merging a branch whose worktree still holds uncommitted work would leave
    // it in a directory this method then deletes.
    it('refuses to merge a dirty worktree', async () => {
      const { git, worktrees } = manager({
        ...withWorktree(),
        status: { dirty: true, aheadCount: 1, currentCommit: 'abc' },
      });
      await expect(worktrees.merge('feature')).rejects.toMatchObject({
        status: 409,
        message: 'Worktree has uncommitted changes: feature',
      });
      expect(git.calls.some((call) => call.startsWith('merge:'))).toBe(false);
    });

    // A caller that reads a cleanup failure as "merge failed" would retry the
    // merge, so the message has to say the merge succeeded.
    it('says the merge succeeded when only the cleanup failed', async () => {
      const { worktrees } = manager({ ...withWorktree(), failRemove: 'directory busy' });
      await expect(worktrees.merge('feature')).rejects.toThrow(
        /Merged feature into main but cleanup failed/,
      );
    });
  });

  describe('list', () => {
    it('reports a checkout with no binding as unmanaged, and skips the repository itself', async () => {
      const { worktrees } = manager({
        ...clean,
        worktrees: [entry(repoRoot, 'main'), entry(join(repoRoot, '__worktrees', 'a'), 'a')],
      });

      const listed = await worktrees.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ branch: 'a', state: 'unmanaged', binding: null });
    });

    it('ignores a bare entry', async () => {
      const { worktrees } = manager({
        ...clean,
        worktrees: [{ ...entry('/repo.git', null), bare: true }],
      });
      await expect(worktrees.list()).resolves.toEqual([]);
    });
  });

  it('exposes WorktreeError with the upstream status codes', () => {
    const error = new WorktreeError('nope', 409);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(409);
    expect(error.name).toBe('WorktreeError');
  });
});
