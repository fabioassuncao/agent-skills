import { ghBounded } from './client.js';
import type { GhReviewComment, PullRequestComment } from './types.js';

/**
 * Inline review comments of a Pull Request, with the ETag cache.
 *
 * `MERGE` per §20: the Issue Flow already publishes conversation comments
 * (`core/pr-review/publisher.ts`), but had no way to *read* the inline review
 * comments and no conditional-request cache. Both come from WebMux
 * `backend/src/services/pr-service.ts` @ d8c9d5f.
 *
 * The cache is the point: a `304 Not Modified` answer to an `If-None-Match`
 * request does not count against the GitHub rate limit, so a monitor polling
 * every ten seconds costs almost nothing while a Pull Request is idle.
 */

/** How many comments a single Pull Request contributes, most recent first. */
export const REVIEW_COMMENT_LIMIT = 50;

/** ETag cache for `gh api` review-comment responses, keyed by API path. */
const etagCache = new Map<string, { etag: string; comments: PullRequestComment[] }>();

/**
 * The API path for a Pull Request's review comments.
 *
 * `{owner}/{repo}` is `gh`'s own placeholder for the repository of the working
 * directory, so the current repo needs no slug lookup — and, because the path
 * is also the cache key, the placeholder keys the current repo consistently.
 */
export function reviewCommentApiPath(prNumber: number, repoSlug?: string): string {
  return `repos/${repoSlug ?? '{owner}/{repo}'}/pulls/${prNumber}/comments?per_page=100`;
}

/**
 * Split a raw `gh api --include` response into its header block and body.
 *
 * `--include` prefixes the JSON with the HTTP headers, separated by a blank
 * line. Both separators are accepted because the CRLF form is what GitHub
 * sends and the LF form is what a proxy or a fixture may produce. Returns null
 * when there is no header block at all — an error or an empty response.
 */
export function splitHttpMessage(raw: string): { headers: string; body: string } | null {
  let index = raw.indexOf('\r\n\r\n');
  let separatorLength = 4;
  if (index === -1) {
    index = raw.indexOf('\n\n');
    separatorLength = 2;
  }
  if (index === -1) return null;
  return { headers: raw.slice(0, index), body: raw.slice(index + separatorLength) };
}

/**
 * Parse raw `gh api` review comments JSON into the typed array, most recent
 * first and capped at {@link REVIEW_COMMENT_LIMIT}. Throws on invalid JSON —
 * the caller decides whether that means "keep the cached value".
 */
export function parseReviewComments(json: string): PullRequestComment[] {
  const raw = JSON.parse(json) as GhReviewComment[];
  const sorted = [...raw].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  return sorted.slice(0, REVIEW_COMMENT_LIMIT).map((comment) => ({
    type: 'inline' as const,
    author: comment.user?.login ?? 'unknown',
    body: comment.body ?? '',
    createdAt: comment.created_at ?? '',
    path: comment.path ?? '',
    line: comment.line ?? null,
    diffHunk: comment.diff_hunk ?? '',
    isReply: comment.in_reply_to_id !== undefined,
  }));
}

export interface FetchReviewCommentsOptions {
  /** `owner/repo` of a linked repository; omitted uses `gh`'s `{owner}/{repo}`. */
  repoSlug?: string;
  cwd?: string;
}

/**
 * Fetch the inline review comments of one Pull Request, using a conditional
 * request when the previous response carried an ETag.
 *
 * Never throws and never reports an empty list for a failure it cannot
 * distinguish from an empty Pull Request: a timeout, a non-zero exit and
 * unparsable JSON all fall back to the cached comments, so a transient failure
 * blanks nothing on screen.
 */
export async function fetchReviewComments(
  prNumber: number,
  options: FetchReviewCommentsOptions = {},
): Promise<PullRequestComment[]> {
  const apiPath = reviewCommentApiPath(prNumber, options.repoSlug);
  const args = ['api', apiPath, '--include'];

  const cached = etagCache.get(apiPath);
  if (cached) args.push('--header', `If-None-Match: ${cached.etag}`);

  const result = await ghBounded(args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  const raw = result.stdout;

  const message = splitHttpMessage(raw);
  if (message === null) {
    // No headers found — an error, or a response `--include` did not decorate.
    if (result.exitCode !== 0) return cached?.comments ?? [];
    try {
      return parseReviewComments(raw);
    } catch {
      return cached?.comments ?? [];
    }
  }

  // 304 Not Modified: the cached body is still current, and the request did not
  // consume rate limit.
  if (message.headers.includes('304 Not Modified')) return cached?.comments ?? [];

  if (result.exitCode !== 0) return cached?.comments ?? [];

  const etagMatch = message.headers.match(/^etag:\s*(.+)$/im);

  try {
    const comments = parseReviewComments(message.body);
    if (etagMatch?.[1] !== undefined) {
      etagCache.set(apiPath, { etag: etagMatch[1].trim(), comments });
    }
    return comments;
  } catch {
    return cached?.comments ?? [];
  }
}

/**
 * Drop every cached entry whose API path is not in `activePaths`.
 *
 * Without this the cache grows one entry per Pull Request ever seen; a merged
 * Pull Request is never requested again, so its ETag is dead weight.
 */
export function evictReviewCommentCache(activePaths: ReadonlySet<string>): void {
  for (const key of etagCache.keys()) {
    if (!activePaths.has(key)) etagCache.delete(key);
  }
}

/** Whether a path currently has a cached ETag. Exposed for tests and diagnostics. */
export function hasCachedReviewComments(apiPath: string): boolean {
  return etagCache.has(apiPath);
}

/** Empty the cache. Test seam — the module state is otherwise process-wide. */
export function resetReviewCommentCache(): void {
  etagCache.clear();
}
