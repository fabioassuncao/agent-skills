import { describe, expect, it, vi } from 'vitest';
import { type GitStateSources, publishGitState } from './session-git.js';
import { MemoryPublisher, NullPublisher } from './session-state.js';

function makeSources(overrides?: Partial<GitStateSources>): GitStateSources {
  return {
    currentBranch: async () => 'issue/22-test',
    baseBranch: async () => 'main',
    commitsSince: async () => [{ hash: 'abc1234', subject: 'feat: US-001' }],
    pullRequests: async () => [{ number: 30, url: 'https://example.com/30', title: 'PR' }],
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
