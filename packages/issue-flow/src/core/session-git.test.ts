import { describe, expect, it, vi } from 'vitest';
import { type GitStateSources, publishGitState } from './session-git.js';
import { MemoryPublisher, NullPublisher } from './session-state.js';

function makeSources(overrides?: Partial<GitStateSources>): GitStateSources {
  return {
    currentBranch: async () => 'issue/22-test',
    baseBranch: async () => 'main',
    commitsSince: async () => [{ hash: 'abc1234', subject: 'feat: US-001' }],
    pullRequests: async () => [{ number: 30, url: 'https://example.com/30', title: 'PR' }],
    remoteUrl: async () => 'git@github.com:acme/repo.git',
    headCommit: async () => 'c56b163',
    projectRoot: async () => '/repo/root',
    now: () => '2026-08-03T12:00:00Z',
    ...overrides,
  };
}

describe('publishGitState', () => {
  it('publishes a git:update event with branch, base, commits and PRs', async () => {
    const publisher = new MemoryPublisher({ onWarn: () => {} });
    await publishGitState(publisher, makeSources());

    const snap = publisher.snapshot();
    expect(publisher.version()).toBe(1);
    expect(snap.git.branch).toBe('issue/22-test');
    expect(snap.git.baseBranch).toBe('main');
    expect(snap.git.commits).toEqual([{ hash: 'abc1234', subject: 'feat: US-001' }]);
    expect(snap.pullRequests).toEqual([{ number: 30, url: 'https://example.com/30', title: 'PR' }]);
  });

  it('short-circuits with the NullPublisher before touching any source', async () => {
    const currentBranch = vi.fn(async () => 'issue/22-test');
    await publishGitState(new NullPublisher(), makeSources({ currentBranch }));
    expect(currentBranch).not.toHaveBeenCalled();
  });

  it('never throws and publishes nothing when a source fails', async () => {
    const publisher = new MemoryPublisher({ onWarn: () => {} });
    await expect(
      publishGitState(
        publisher,
        makeSources({
          baseBranch: async () => {
            throw new Error('git not available');
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(publisher.version()).toBe(0);
  });

  it('publishes the repository identity of a repository with a remote', async () => {
    const publisher = new MemoryPublisher({ onWarn: () => {} });
    await publishGitState(publisher, makeSources());

    expect(publisher.snapshot().repository).toEqual({
      // Derived from the remote, host dropped and lowercased.
      name: 'acme/repo',
      remoteUrl: 'git@github.com:acme/repo.git',
      // The same publication feeds git.branch and repository.branch.
      branch: 'issue/22-test',
      headCommit: 'c56b163',
      root: '/repo/root',
    });
  });

  it('never publishes credentials embedded in the origin remote', async () => {
    const publisher = new MemoryPublisher({ onWarn: () => {} });
    await publishGitState(
      publisher,
      makeSources({
        remoteUrl: async () => 'https://x-access-token:ghp_secret@github.com/acme/repo.git',
      }),
    );

    expect(publisher.snapshot().repository).toMatchObject({
      name: 'acme/repo',
      remoteUrl: 'https://github.com/acme/repo.git',
    });
    expect(JSON.stringify(publisher.snapshot())).not.toContain('ghp_secret');
  });

  it('reports a repository with no remote as name and remoteUrl null', async () => {
    const publisher = new MemoryPublisher({ onWarn: () => {} });
    await publishGitState(publisher, makeSources({ remoteUrl: async () => null }));

    expect(publisher.snapshot().repository).toMatchObject({
      name: null,
      remoteUrl: null,
      branch: 'issue/22-test',
      headCommit: 'c56b163',
      root: '/repo/root',
    });
  });

  it('reports an unavailable HEAD as null without dropping the other fields', async () => {
    const publisher = new MemoryPublisher({ onWarn: () => {} });
    await publishGitState(publisher, makeSources({ headCommit: async () => null }));

    expect(publisher.snapshot().repository).toMatchObject({
      name: 'acme/repo',
      headCommit: null,
      root: '/repo/root',
    });
  });

  it('keeps publishing when one of the repository sources throws', async () => {
    const publisher = new MemoryPublisher({ onWarn: () => {} });
    await expect(
      publishGitState(
        publisher,
        makeSources({
          headCommit: async () => {
            throw new Error('git rev-parse blew up');
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(publisher.version()).toBe(1);
    expect(publisher.snapshot().repository).toMatchObject({
      name: 'acme/repo',
      headCommit: null,
      root: '/repo/root',
    });
    expect(publisher.snapshot().git.branch).toBe('issue/22-test');
  });

  it('passes the resolved base branch to commitsSince', async () => {
    const publisher = new MemoryPublisher({ onWarn: () => {} });
    const commitsSince = vi.fn(async (_base: string) => []);
    await publishGitState(
      publisher,
      makeSources({ baseBranch: async () => 'develop', commitsSince }),
    );
    expect(commitsSince).toHaveBeenCalledWith('develop');
  });
});
