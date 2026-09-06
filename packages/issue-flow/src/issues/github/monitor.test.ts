import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../utils/shell.js';

vi.mock('../../utils/shell.js', () => ({ run: vi.fn() }));

const { run } = await import('../../utils/shell.js');
const { hasCachedReviewComments, resetReviewCommentCache, reviewCommentApiPath } = await import(
  './comments.js'
);
const { resetPullRequestSyncCache, startPullRequestMonitor, syncPullRequests } = await import(
  './monitor.js'
);

const mockRun = vi.mocked(run);

function result(overrides?: Partial<ExecResult>): ExecResult {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides };
}

function ghPr(over: Record<string, unknown> = {}): unknown {
  return {
    number: 42,
    headRefName: 'feature/x',
    state: 'OPEN',
    isDraft: false,
    updatedAt: '2026-07-23T09:00:00Z',
    statusCheckRollup: null,
    url: 'https://github.com/o/r/pull/42',
    comments: [{ author: { login: 'alice' }, body: 'hi', createdAt: '2026-01-01T00:00:00Z' }],
    ...over,
  };
}

/** A `gh api --include` response carrying one inline review comment. */
function reviewResponse(createdAt = '2026-01-02T00:00:00Z'): string {
  return `HTTP/2.0 200 OK\r\netag: W/"abc"\r\n\r\n${JSON.stringify([
    {
      body: 'inline',
      path: 'src/a.ts',
      line: 1,
      diff_hunk: '',
      user: { login: 'bob' },
      created_at: createdAt,
    },
  ])}`;
}

beforeEach(() => {
  mockRun.mockReset();
  resetPullRequestSyncCache();
  resetReviewCommentCache();
});

describe('syncPullRequests', () => {
  it('merges conversation and inline comments in chronological order', async () => {
    mockRun
      .mockResolvedValueOnce(result({ stdout: JSON.stringify([ghPr()]) }))
      .mockResolvedValueOnce(result({ stdout: reviewResponse() }));

    const sync = await syncPullRequests();

    const entries = sync.byBranch.get('feature/x');
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.comments.map((comment) => comment.type)).toEqual(['comment', 'inline']);
    expect(sync.errors).toEqual([]);
  });

  it('queries the current repository and every linked one', async () => {
    mockRun
      .mockResolvedValueOnce(result({ stdout: '[]' }))
      .mockResolvedValueOnce(result({ stdout: '[]' }));

    await syncPullRequests({ linkedRepos: [{ repo: 'acme/api', alias: 'api' }] });

    expect(mockRun).toHaveBeenNthCalledWith(
      2,
      'gh',
      expect.arrayContaining(['--repo', 'acme/api']),
      expect.anything(),
    );
  });

  it('keeps the other repositories when one query fails', async () => {
    const onError = vi.fn();
    mockRun
      .mockResolvedValueOnce(result({ exitCode: 1, stderr: 'boom' }))
      .mockResolvedValueOnce(result({ stdout: JSON.stringify([ghPr()]) }))
      .mockResolvedValueOnce(result({ stdout: reviewResponse() }));

    const sync = await syncPullRequests({
      linkedRepos: [{ repo: 'acme/api', alias: 'api' }],
      onError,
    });

    expect(sync.byBranch.get('feature/x')).toHaveLength(1);
    expect(sync.errors).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('skips the review-comment read for a branch nobody is looking at', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: JSON.stringify([ghPr()]) }));

    await syncPullRequests({ activeBranches: new Set(['other']) });

    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('reuses cached comments while updatedAt has not moved', async () => {
    mockRun
      .mockResolvedValueOnce(result({ stdout: JSON.stringify([ghPr()]) }))
      .mockResolvedValueOnce(result({ stdout: reviewResponse() }));
    await syncPullRequests();

    mockRun.mockResolvedValueOnce(result({ stdout: JSON.stringify([ghPr()]) }));
    const sync = await syncPullRequests();

    // Second pass: the list call only — no `gh api` at all.
    expect(mockRun).toHaveBeenCalledTimes(3);
    expect(sync.byBranch.get('feature/x')?.[0]?.comments).toHaveLength(2);
  });

  it('re-reads comments once updatedAt moves', async () => {
    mockRun
      .mockResolvedValueOnce(result({ stdout: JSON.stringify([ghPr()]) }))
      .mockResolvedValueOnce(result({ stdout: reviewResponse() }));
    await syncPullRequests();

    mockRun
      .mockResolvedValueOnce(
        result({ stdout: JSON.stringify([ghPr({ updatedAt: '2026-07-24T09:00:00Z' })]) }),
      )
      .mockResolvedValueOnce(result({ stdout: reviewResponse('2026-01-03T00:00:00Z') }));

    await syncPullRequests();
    expect(mockRun).toHaveBeenCalledTimes(4);
  });

  it('evicts the caches of a Pull Request that is no longer open', async () => {
    mockRun
      .mockResolvedValueOnce(result({ stdout: JSON.stringify([ghPr()]) }))
      .mockResolvedValueOnce(result({ stdout: reviewResponse() }));
    await syncPullRequests();
    expect(hasCachedReviewComments(reviewCommentApiPath(42))).toBe(true);

    mockRun.mockResolvedValueOnce(result({ stdout: '[]' }));
    await syncPullRequests();

    expect(hasCachedReviewComments(reviewCommentApiPath(42))).toBe(false);
  });
});

describe('startPullRequestMonitor', () => {
  it('skips the pass entirely while the activity gate is closed', async () => {
    const onSync = vi.fn();

    const stop = startPullRequestMonitor({
      isActive: () => false,
      onSync,
      intervalMs: 10_000,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockRun).not.toHaveBeenCalled();
    expect(onSync).not.toHaveBeenCalled();
    stop();
  });

  it('runs the pass and reports it when the gate is open', async () => {
    mockRun.mockResolvedValue(result({ stdout: '[]' }));
    const onSync = vi.fn();

    const stop = startPullRequestMonitor({ isActive: () => true, onSync, intervalMs: 10_000 });
    for (let i = 0; i < 10 && onSync.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    stop();

    expect(onSync).toHaveBeenCalledTimes(1);
    expect(onSync.mock.calls[0]?.[0]).toMatchObject({ errors: [] });
  });

  it('reports a thrown pass instead of leaving an unhandled rejection', async () => {
    mockRun.mockRejectedValue(new Error('gh exploded'));
    const onFailure = vi.fn();

    const stop = startPullRequestMonitor({ onFailure, intervalMs: 10_000 });
    for (let i = 0; i < 10 && onFailure.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    stop();

    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
