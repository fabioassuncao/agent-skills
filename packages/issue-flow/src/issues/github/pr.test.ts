import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../utils/shell.js';
import type { PullRequestEntry } from './types.js';

vi.mock('../../utils/shell.js', () => ({ run: vi.fn() }));

const { run } = await import('../../utils/shell.js');
const {
  fetchBranchPullRequestStates,
  fetchOpenPullRequests,
  fetchPullRequestStatus,
  listPullRequestsForBranch,
  parsePullRequestList,
  parsePullRequestStatus,
  refreshStalePullRequests,
  viewPullRequest,
} = await import('./pr.js');

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
    comments: [],
    ...over,
  };
}

function entry(over: Partial<PullRequestEntry> = {}): PullRequestEntry {
  return {
    repo: '',
    number: 42,
    state: 'open',
    isDraft: false,
    url: 'https://github.com/o/r/pull/42',
    updatedAt: '2026-07-23T09:00:00Z',
    ciStatus: 'none',
    ciChecks: [],
    comments: [],
    ...over,
  };
}

beforeEach(() => {
  mockRun.mockReset();
});

/* ── migrated from backend/src/__tests__/pr.test.ts ─────────────────────── */

describe('parsePullRequestList — draft state', () => {
  it('marks a draft PR as draft', () => {
    const prs = parsePullRequestList(JSON.stringify([ghPr({ isDraft: true })]));
    expect(prs.get('feature/x')?.isDraft).toBe(true);
  });

  it('marks a PR that is ready for review as not draft', () => {
    const prs = parsePullRequestList(JSON.stringify([ghPr()]));
    expect(prs.get('feature/x')?.isDraft).toBe(false);
  });

  it('treats a missing isDraft field as not draft', () => {
    const prs = parsePullRequestList(JSON.stringify([ghPr({ isDraft: undefined })]));
    expect(prs.get('feature/x')?.isDraft).toBe(false);
  });
});

describe('parsePullRequestStatus — stale-entry refresh', () => {
  it('re-reads the draft flag of a PR that is still open', () => {
    // A Pull Request absent from the open-PR list but still open (failed repo
    // fetch or limit truncation) must not keep a stale draft flag.
    expect(parsePullRequestStatus(JSON.stringify({ state: 'OPEN', isDraft: false }))).toEqual({
      state: 'open',
      isDraft: false,
    });
    expect(parsePullRequestStatus(JSON.stringify({ state: 'OPEN', isDraft: true }))).toEqual({
      state: 'open',
      isDraft: true,
    });
  });

  it('reports a merged PR as not draft', () => {
    expect(parsePullRequestStatus(JSON.stringify({ state: 'MERGED', isDraft: false }))).toEqual({
      state: 'merged',
      isDraft: false,
    });
  });

  it('returns null for unusable output', () => {
    expect(parsePullRequestStatus('not json')).toBeNull();
    expect(parsePullRequestStatus(JSON.stringify({ isDraft: true }))).toBeNull();
  });
});

/* ── Issue Flow additions ───────────────────────────────────────────────── */

describe('parsePullRequestList', () => {
  it('keeps the first Pull Request when two share a branch in one repository', () => {
    const prs = parsePullRequestList(JSON.stringify([ghPr({ number: 42 }), ghPr({ number: 41 })]));
    expect(prs.get('feature/x')?.number).toBe(42);
  });

  it('stamps the repository label and maps conversation comments', () => {
    const prs = parsePullRequestList(
      JSON.stringify([
        ghPr({
          comments: [{ author: { login: 'alice' }, body: 'hi', createdAt: '2026-01-01T00:00:00Z' }],
        }),
      ]),
      'api',
    );
    const parsed = prs.get('feature/x');
    expect(parsed?.repo).toBe('api');
    expect(parsed?.comments).toEqual([
      { type: 'comment', author: 'alice', body: 'hi', createdAt: '2026-01-01T00:00:00Z' },
    ]);
  });
});

describe('fetchOpenPullRequests', () => {
  it('queries the current repository through the gh chokepoint', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: JSON.stringify([ghPr()]) }));

    const outcome = await fetchOpenPullRequests();

    expect(outcome.ok).toBe(true);
    expect(mockRun).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'open',
        '--json',
        'number,headRefName,state,isDraft,updatedAt,statusCheckRollup,url,comments',
        '--limit',
        '50',
      ],
      expect.objectContaining({ retry: expect.any(Function), timeout: 15_000 }),
    );
  });

  it('addresses a linked repository with --repo and labels its entries', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: JSON.stringify([ghPr()]) }));

    const outcome = await fetchOpenPullRequests({
      repoSlug: 'acme/api',
      repoLabel: 'api',
      cwd: '/tmp/repo',
    });

    expect(mockRun).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--repo', 'acme/api']),
      expect.objectContaining({ cwd: '/tmp/repo' }),
    );
    expect(outcome.ok && outcome.data.get('feature/x')?.repo).toBe('api');
  });

  it('reports a failed query as an error, never as an empty list', async () => {
    mockRun.mockResolvedValueOnce(result({ exitCode: 1, stderr: 'not authenticated\n' }));

    await expect(fetchOpenPullRequests({ repoSlug: 'acme/api' })).resolves.toEqual({
      ok: false,
      error: 'gh pr list failed for acme/api (exit 1): not authenticated',
    });
  });

  it('reports a timeout apart from a plain non-zero exit', async () => {
    mockRun.mockResolvedValueOnce(
      result({
        exitCode: 1,
        failure: {
          kind: 'timeout',
          message: 'timed out',
          retryable: true,
          source: 'github',
        },
      }),
    );

    await expect(fetchOpenPullRequests()).resolves.toEqual({
      ok: false,
      error: 'gh pr list timed out for current',
    });
  });

  it('reports unparsable output as an error', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'not json' }));

    const outcome = await fetchOpenPullRequests();
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toContain('failed to parse gh output for current');
  });
});

describe('viewPullRequest / fetchPullRequestStatus', () => {
  it('is the only gh pr view invocation, and returns the parsed payload', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: JSON.stringify({ title: 'A change' }) }));

    await expect(viewPullRequest<{ title: string }>('128', 'title')).resolves.toEqual({
      title: 'A change',
    });
    expect(mockRun).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', '128', '--json', 'title'],
      expect.objectContaining({ retry: expect.any(Function) }),
    );
  });

  it('returns null for a failed call and for non-object output', async () => {
    mockRun.mockResolvedValueOnce(result({ exitCode: 1 }));
    await expect(viewPullRequest('128', 'title')).resolves.toBeNull();

    mockRun.mockResolvedValueOnce(result({ stdout: '"a string"' }));
    await expect(viewPullRequest('128', 'title')).resolves.toBeNull();
  });

  it('reads state and isDraft for one Pull Request', async () => {
    mockRun.mockResolvedValueOnce(
      result({ stdout: JSON.stringify({ state: 'MERGED', isDraft: false }) }),
    );

    await expect(fetchPullRequestStatus('https://github.com/o/r/pull/42')).resolves.toEqual({
      state: 'merged',
      isDraft: false,
    });
  });
});

describe('refreshStalePullRequests', () => {
  it('does not call gh when no entry is open', async () => {
    const entries = [entry({ state: 'merged' })];
    await expect(refreshStalePullRequests(entries)).resolves.toEqual(entries);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('re-reads state and draft flag of the open entries', async () => {
    mockRun.mockResolvedValueOnce(
      result({ stdout: JSON.stringify({ state: 'MERGED', isDraft: false }) }),
    );

    const [refreshed] = await refreshStalePullRequests([entry({ isDraft: true })]);
    expect(refreshed?.state).toBe('merged');
    expect(refreshed?.isDraft).toBe(false);
  });

  it('leaves an entry untouched when its status cannot be read', async () => {
    mockRun.mockResolvedValueOnce(result({ exitCode: 1 }));

    const [refreshed] = await refreshStalePullRequests([entry()]);
    expect(refreshed?.state).toBe('open');
  });
});

describe('listPullRequestsForBranch', () => {
  it('projects number, url and title for the branch', async () => {
    mockRun.mockResolvedValueOnce(
      result({
        stdout: JSON.stringify([{ number: 7, url: 'https://x/pull/7', title: 'T' }, { bad: true }]),
      }),
    );

    await expect(listPullRequestsForBranch('issue/42-x')).resolves.toEqual([
      { number: 7, url: 'https://x/pull/7', title: 'T' },
    ]);
    expect(mockRun).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'list',
        '--head',
        'issue/42-x',
        '--state',
        'all',
        '--json',
        'number,url,title',
        '--limit',
        '10',
      ],
      expect.anything(),
    );
  });

  it('returns [] for an empty branch, a failed call and bad JSON', async () => {
    await expect(listPullRequestsForBranch('')).resolves.toEqual([]);
    expect(mockRun).not.toHaveBeenCalled();

    mockRun.mockResolvedValueOnce(result({ exitCode: 1 }));
    await expect(listPullRequestsForBranch('b')).resolves.toEqual([]);

    mockRun.mockResolvedValueOnce(result({ stdout: 'not json' }));
    await expect(listPullRequestsForBranch('b')).resolves.toEqual([]);
  });
});

describe('fetchBranchPullRequestStates', () => {
  it('aggregates the states of every repository, current one first', async () => {
    mockRun
      .mockResolvedValueOnce(
        result({
          stdout: JSON.stringify([{ headRefName: 'b', state: 'MERGED', headRefOid: 'a1' }]),
        }),
      )
      .mockResolvedValueOnce(
        result({ stdout: JSON.stringify([{ headRefName: 'b', state: 'OPEN', headRefOid: 'b2' }]) }),
      );

    const states = await fetchBranchPullRequestStates([{ repo: 'acme/api', alias: 'api' }]);

    expect(states?.get('b')).toEqual([
      { state: 'merged', headCommit: 'a1', currentRepository: true },
      { state: 'open', headCommit: 'b2', currentRepository: false },
    ]);
    expect(mockRun).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['pr', 'list', '--state', 'all', '--json', 'headRefName,state,headRefOid', '--limit', '50'],
      expect.anything(),
    );
    expect(mockRun).toHaveBeenNthCalledWith(
      2,
      'gh',
      expect.arrayContaining(['--repo', 'acme/api']),
      expect.anything(),
    );
  });

  it('returns null when any repository query fails, so a sweep skips the pass', async () => {
    mockRun
      .mockResolvedValueOnce(result({ stdout: '[]' }))
      .mockResolvedValueOnce(result({ exitCode: 1 }));

    await expect(
      fetchBranchPullRequestStates([{ repo: 'acme/api', alias: 'api' }]),
    ).resolves.toBeNull();
  });

  it('returns null when a repository answers with unparsable output', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'not json' }));
    await expect(fetchBranchPullRequestStates()).resolves.toBeNull();
  });
});
