import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../utils/shell.js';

vi.mock('../../utils/shell.js', () => ({ run: vi.fn() }));

const { run } = await import('../../utils/shell.js');
const {
  evictReviewCommentCache,
  fetchReviewComments,
  hasCachedReviewComments,
  parseReviewComments,
  resetReviewCommentCache,
  reviewCommentApiPath,
  splitHttpMessage,
} = await import('./comments.js');

const mockRun = vi.mocked(run);

function result(overrides?: Partial<ExecResult>): ExecResult {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides };
}

/** A `gh api --include` response: header block, blank line, JSON body. */
function ghApiResponse(status: string, headers: string, body: unknown): string {
  return `HTTP/2.0 ${status}\r\n${headers}\r\n\r\n${JSON.stringify(body)}`;
}

const reviewComment = {
  body: 'Looks good',
  path: 'src/main.ts',
  line: 42,
  diff_hunk: '@@ -40,3 +40,5 @@',
  user: { login: 'alice' },
  created_at: '2026-01-15T10:00:00Z',
};

beforeEach(() => {
  mockRun.mockReset();
  resetReviewCommentCache();
});

/* ── migrated from backend/src/__tests__/pr.test.ts ─────────────────────── */

describe('parseReviewComments', () => {
  it('parses normal review comments', () => {
    const json = JSON.stringify([
      {
        body: 'Looks good',
        path: 'src/main.ts',
        line: 42,
        diff_hunk: '@@ -40,3 +40,5 @@\n code here',
        user: { login: 'alice' },
        created_at: '2026-01-15T10:00:00Z',
      },
      {
        body: 'Needs fix',
        path: 'src/utils.ts',
        line: 10,
        diff_hunk: '@@ -8,3 +8,5 @@',
        user: { login: 'bob' },
        created_at: '2026-01-16T12:00:00Z',
        in_reply_to_id: 123,
      },
    ]);

    const parsed = parseReviewComments(json);
    expect(parsed).toHaveLength(2);
    // Sorted by most recent first.
    expect(parsed[0]?.type).toBe('inline');
    expect(parsed[0]?.author).toBe('bob');
    expect(parsed[0]?.path).toBe('src/utils.ts');
    expect(parsed[0]?.line).toBe(10);
    expect(parsed[0]?.isReply).toBe(true);
    expect(parsed[0]?.diffHunk).toBe('@@ -8,3 +8,5 @@');

    expect(parsed[1]?.type).toBe('inline');
    expect(parsed[1]?.author).toBe('alice');
    expect(parsed[1]?.line).toBe(42);
    expect(parsed[1]?.isReply).toBe(false);
    expect(parsed[1]?.diffHunk).toContain('code here');
  });

  it('returns empty array for empty input', () => {
    expect(parseReviewComments('[]')).toEqual([]);
  });

  it('handles missing/null fields gracefully', () => {
    const json = JSON.stringify([
      { body: null, path: null, line: null, diff_hunk: null, user: null, created_at: null },
    ]);

    const parsed = parseReviewComments(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      type: 'inline',
      author: 'unknown',
      body: '',
      createdAt: '',
      path: '',
      line: null,
      diffHunk: '',
      isReply: false,
    });
  });

  it('truncates to 50 comments', () => {
    const comments = Array.from({ length: 60 }, (_, index) => ({
      body: `comment ${index}`,
      path: 'file.ts',
      line: index,
      diff_hunk: '',
      user: { login: 'user' },
      created_at: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    expect(parseReviewComments(JSON.stringify(comments))).toHaveLength(50);
  });
});

/* ── Issue Flow additions: the ETag cache ───────────────────────────────── */

describe('splitHttpMessage', () => {
  it('splits on CRLF CRLF and on LF LF', () => {
    expect(splitHttpMessage('a: 1\r\n\r\n[]')).toEqual({ headers: 'a: 1', body: '[]' });
    expect(splitHttpMessage('a: 1\n\n[]')).toEqual({ headers: 'a: 1', body: '[]' });
  });

  it('returns null when there is no header block', () => {
    expect(splitHttpMessage('[]')).toBeNull();
  });
});

describe('reviewCommentApiPath', () => {
  it("uses gh's own repository placeholder for the current repository", () => {
    expect(reviewCommentApiPath(42)).toBe('repos/{owner}/{repo}/pulls/42/comments?per_page=100');
  });

  it('addresses a linked repository by slug', () => {
    expect(reviewCommentApiPath(7, 'acme/api')).toBe(
      'repos/acme/api/pulls/7/comments?per_page=100',
    );
  });
});

describe('fetchReviewComments', () => {
  it('reads comments and remembers the ETag for the next request', async () => {
    mockRun.mockResolvedValueOnce(
      result({ stdout: ghApiResponse('200 OK', 'etag: W/"abc"', [reviewComment]) }),
    );

    const comments = await fetchReviewComments(42);

    expect(comments).toHaveLength(1);
    expect(comments[0]?.author).toBe('alice');
    expect(mockRun).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/{owner}/{repo}/pulls/42/comments?per_page=100', '--include'],
      expect.objectContaining({ retry: expect.any(Function), timeout: 15_000 }),
    );
    expect(hasCachedReviewComments(reviewCommentApiPath(42))).toBe(true);
  });

  it('sends If-None-Match on the second request and serves a 304 from cache', async () => {
    mockRun.mockResolvedValueOnce(
      result({ stdout: ghApiResponse('200 OK', 'ETag: W/"abc"', [reviewComment]) }),
    );
    await fetchReviewComments(42);

    mockRun.mockResolvedValueOnce(
      result({ stdout: 'HTTP/2.0 304 Not Modified\r\netag: W/"abc"\r\n\r\n' }),
    );
    const comments = await fetchReviewComments(42);

    expect(mockRun).toHaveBeenLastCalledWith(
      'gh',
      [
        'api',
        'repos/{owner}/{repo}/pulls/42/comments?per_page=100',
        '--include',
        '--header',
        'If-None-Match: W/"abc"',
      ],
      expect.anything(),
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.author).toBe('alice');
  });

  it('keeps the cached comments when the call fails', async () => {
    mockRun.mockResolvedValueOnce(
      result({ stdout: ghApiResponse('200 OK', 'etag: W/"abc"', [reviewComment]) }),
    );
    await fetchReviewComments(42);

    mockRun.mockResolvedValueOnce(result({ exitCode: 1, stderr: 'network is unreachable' }));

    // A transient failure blanks nothing on screen.
    await expect(fetchReviewComments(42)).resolves.toHaveLength(1);
  });

  it('returns an empty list when a failure has no cached value to fall back to', async () => {
    mockRun.mockResolvedValueOnce(result({ exitCode: 1, stderr: 'boom' }));
    await expect(fetchReviewComments(99)).resolves.toEqual([]);
  });

  it('parses an undecorated body when --include produced no headers', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: JSON.stringify([reviewComment]) }));
    await expect(fetchReviewComments(42)).resolves.toHaveLength(1);
  });

  it('does not cache an ETag whose body is unparsable', async () => {
    mockRun.mockResolvedValueOnce(
      result({ stdout: 'HTTP/2.0 200 OK\r\netag: W/"abc"\r\n\r\nnot json' }),
    );

    await expect(fetchReviewComments(42)).resolves.toEqual([]);
    expect(hasCachedReviewComments(reviewCommentApiPath(42))).toBe(false);
  });

  it('addresses a linked repository and runs in the given directory', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: ghApiResponse('200 OK', 'etag: W/"x"', []) }));

    await fetchReviewComments(7, { repoSlug: 'acme/api', cwd: '/tmp/repo' });

    expect(mockRun).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/acme/api/pulls/7/comments?per_page=100', '--include'],
      expect.objectContaining({ cwd: '/tmp/repo' }),
    );
  });
});

describe('evictReviewCommentCache', () => {
  it('drops every path that is no longer active', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: ghApiResponse('200 OK', 'etag: W/"a"', []) }));
    await fetchReviewComments(1);
    mockRun.mockResolvedValueOnce(result({ stdout: ghApiResponse('200 OK', 'etag: W/"b"', []) }));
    await fetchReviewComments(2);

    evictReviewCommentCache(new Set([reviewCommentApiPath(2)]));

    expect(hasCachedReviewComments(reviewCommentApiPath(1))).toBe(false);
    expect(hasCachedReviewComments(reviewCommentApiPath(2))).toBe(true);
  });
});
