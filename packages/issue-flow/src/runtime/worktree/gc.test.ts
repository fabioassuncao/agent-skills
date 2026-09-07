import { describe, expect, it } from 'vitest';
import { type BranchPullRequestStates, pullMainBranch, runAutoRemove } from './gc.js';
import type { GitWorktreeGateway, WorktreeStatus } from './git.js';
import type { ManagedWorktree, WorktreeManager } from './lifecycle.js';

/**
 * Adapted from WebMux `backend/src/services/auto-remove-service.ts` and
 * `auto-pull-service.ts` @ d8c9d5f. Both run headless on a timer upstream, and
 * that is the property worth keeping: a machine left running for a week should
 * not accumulate forty merged checkouts because nobody opened a dashboard.
 */

function managed(branch: string): ManagedWorktree {
  return {
    branch,
    path: `/wt/${branch}`,
    entry: { path: `/wt/${branch}`, branch, head: 'abc', detached: false, bare: false },
    binding: { branch, path: `/wt/${branch}`, worktreeId: `wt-${branch}` } as never,
    state: 'managed',
  };
}

function fakeManager(
  worktrees: ManagedWorktree[],
  removed: string[],
  failOn?: string,
): WorktreeManager {
  return {
    list: async () => worktrees,
    remove: async (branch: string) => {
      if (branch === failOn) throw new Error('busy');
      removed.push(branch);
    },
  } as unknown as WorktreeManager;
}

function fakeGit(status: Record<string, WorktreeStatus>): GitWorktreeGateway {
  return {
    readWorktreeStatus: async (path: string) =>
      status[path] ?? { dirty: false, aheadCount: 0, currentCommit: 'abc' },
  } as unknown as GitWorktreeGateway;
}

function states(entries: Record<string, string[]>): BranchPullRequestStates {
  return new Map(
    Object.entries(entries).map(([branch, values]) => [
      branch,
      values.map((state) => ({ state, headCommit: 'abc', currentRepository: true })),
    ]),
  );
}

function removeCandidate(
  removed: string[],
  status: Record<string, WorktreeStatus> = {},
  failOn?: string,
) {
  return async (worktree: ManagedWorktree) => {
    if (worktree.branch === failOn) throw new Error('busy');
    if (status[worktree.path]?.dirty) return 'dirty' as const;
    removed.push(worktree.branch);
    return 'removed' as const;
  };
}

describe('runAutoRemove', () => {
  it('removes a worktree whose pull requests are all merged', async () => {
    const removed: string[] = [];
    const result = await runAutoRemove({
      worktrees: fakeManager([managed('a'), managed('b')], removed),
      git: fakeGit({}),
      projectRoot: '/repo',
      branchPullRequestStates: async () => states({ a: ['merged'], b: ['open'] }),
      removeCandidate: removeCandidate(removed),
    });

    expect(removed).toEqual(['a']);
    expect(result.removed).toEqual(['a']);
    expect(result.skipped).toEqual([{ branch: 'b', reason: 'not-merged' }]);
  });

  // Removing on partial state could drop a worktree whose cross-repository pull
  // request is still open, so an inconclusive query means "do nothing at all".
  it('does nothing when the pull request query was inconclusive', async () => {
    const removed: string[] = [];
    const result = await runAutoRemove({
      worktrees: fakeManager([managed('a')], removed),
      git: fakeGit({}),
      projectRoot: '/repo',
      branchPullRequestStates: async () => null,
      removeCandidate: removeCandidate(removed),
    });

    expect(removed).toEqual([]);
    expect(result.inconclusive).toBe(true);
  });

  // A merged pull request does not make the checkout disposable: work committed
  // nowhere lives only there, and removing the worktree destroys it.
  it('never removes a dirty worktree, however merged its pull request is', async () => {
    const removed: string[] = [];
    const result = await runAutoRemove({
      worktrees: fakeManager([managed('a')], removed),
      git: fakeGit({ '/wt/a': { dirty: true, aheadCount: 0, currentCommit: 'abc' } }),
      projectRoot: '/repo',
      branchPullRequestStates: async () => states({ a: ['merged'] }),
      removeCandidate: removeCandidate(removed, {
        '/wt/a': { dirty: true, aheadCount: 0, currentCommit: 'abc' },
      }),
    });

    expect(removed).toEqual([]);
    expect(result.skipped).toEqual([{ branch: 'a', reason: 'dirty' }]);
  });

  it('requires every pull request of a branch to be merged, not just one', async () => {
    const removed: string[] = [];
    await runAutoRemove({
      worktrees: fakeManager([managed('a')], removed),
      git: fakeGit({}),
      projectRoot: '/repo',
      branchPullRequestStates: async () => states({ a: ['merged', 'open'] }),
      removeCandidate: removeCandidate(removed),
    });
    expect(removed).toEqual([]);
  });

  it('leaves a branch with no pull request alone', async () => {
    const removed: string[] = [];
    const result = await runAutoRemove({
      worktrees: fakeManager([managed('a')], removed),
      git: fakeGit({}),
      projectRoot: '/repo',
      branchPullRequestStates: async () => states({}),
      removeCandidate: removeCandidate(removed),
    });
    expect(removed).toEqual([]);
    expect(result.skipped).toEqual([{ branch: 'a', reason: 'no-pull-request' }]);
  });

  it('skips a branch a removal is already running for', async () => {
    const removed: string[] = [];
    const result = await runAutoRemove({
      worktrees: fakeManager([managed('a')], removed),
      git: fakeGit({}),
      projectRoot: '/repo',
      branchPullRequestStates: async () => states({ a: ['merged'] }),
      removeCandidate: removeCandidate(removed),
      isRemoving: (branch) => branch === 'a',
    });
    expect(result.skipped).toEqual([{ branch: 'a', reason: 'busy' }]);
  });

  // An orphaned binding has no directory to remove; acting on it would mean
  // acting on state the outside world has already contradicted (ADR-08).
  it('ignores orphaned bindings', async () => {
    const removed: string[] = [];
    const orphan: ManagedWorktree = { ...managed('a'), entry: null, state: 'orphaned' };
    await runAutoRemove({
      worktrees: fakeManager([orphan], removed),
      git: fakeGit({}),
      projectRoot: '/repo',
      branchPullRequestStates: async () => states({ a: ['merged'] }),
      removeCandidate: removeCandidate(removed),
    });
    expect(removed).toEqual([]);
  });

  it('reports a failed removal and keeps sweeping the rest', async () => {
    const removed: string[] = [];
    const errors: string[] = [];
    const result = await runAutoRemove({
      worktrees: fakeManager([managed('a'), managed('b')], removed, 'a'),
      git: fakeGit({}),
      projectRoot: '/repo',
      branchPullRequestStates: async () => states({ a: ['merged'], b: ['merged'] }),
      removeCandidate: removeCandidate(removed, {}, 'a'),
      onError: (message) => errors.push(message),
    });

    expect(removed).toEqual(['b']);
    expect(result.removed).toEqual(['b']);
    expect(errors.join('\n')).toContain('Failed to remove worktree a');
  });
});

describe('pullMainBranch', () => {
  function git(overrides: Partial<GitWorktreeGateway>, commits: string[]): GitWorktreeGateway {
    let index = 0;
    return {
      readWorktreeStatus: async () => ({
        dirty: false,
        aheadCount: 0,
        currentCommit: commits[Math.min(index++, commits.length - 1)] ?? null,
      }),
      fetchBranch: async () => ({ ok: true, stdout: '' }),
      fastForwardMerge: async () => ({ ok: true, stdout: '' }),
      ...overrides,
    } as unknown as GitWorktreeGateway;
  }

  it('reports the commits it moved between', async () => {
    await expect(
      pullMainBranch({ git: git({}, ['aaa', 'bbb']), projectRoot: '/repo', mainBranch: 'main' }),
    ).resolves.toEqual({ status: 'updated', from: 'aaa', to: 'bbb' });
  });

  it('reports no change when the commit did not move', async () => {
    await expect(
      pullMainBranch({ git: git({}, ['aaa']), projectRoot: '/repo', mainBranch: 'main' }),
    ).resolves.toEqual({ status: 'already_up_to_date' });
  });

  it('stops at a failed fetch without attempting a merge', async () => {
    let merged = false;
    const gateway = git(
      {
        fetchBranch: async () => ({ ok: false, stderr: 'offline' }),
        fastForwardMerge: async () => {
          merged = true;
          return { ok: true, stdout: '' };
        },
      },
      ['aaa'],
    );
    await expect(
      pullMainBranch({ git: gateway, projectRoot: '/repo', mainBranch: 'main' }),
    ).resolves.toEqual({ status: 'fetch_failed', error: 'offline' });
    expect(merged).toBe(false);
  });

  // Fast-forward only. A diverged branch reports and waits for a person rather
  // than being hard-reset onto the remote, which would discard local commits.
  it('reports a diverged branch instead of discarding it', async () => {
    const gateway = git(
      { fastForwardMerge: async () => ({ ok: false, stderr: 'not possible to fast-forward' }) },
      ['aaa'],
    );
    await expect(
      pullMainBranch({ git: gateway, projectRoot: '/repo', mainBranch: 'main' }),
    ).resolves.toEqual({ status: 'merge_failed', error: 'not possible to fast-forward' });
  });
});
