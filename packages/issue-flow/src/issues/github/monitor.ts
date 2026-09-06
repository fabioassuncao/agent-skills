import { mapWithConcurrency, startSerializedInterval } from '../../utils/async.js';
import { evictReviewCommentCache, fetchReviewComments, reviewCommentApiPath } from './comments.js';
import { type LinkedRepo, repoSlugForEntry, repoTargets } from './linked-repos.js';
import { fetchOpenPullRequests } from './pr.js';
import type { PullRequestComment, PullRequestEntry } from './types.js';

/**
 * The display sync: one pass over every repository, and the gated loop that
 * repeats it.
 *
 * `PORT` per §20 of `syncPrStatus` / `startPrMonitor` from WebMux
 * `backend/src/services/pr-service.ts` @ d8c9d5f, with one structural
 * adaptation: the upstream function writes the result into per-worktree
 * storage, which the Issue Flow does not have yet. Here the pass *returns* the
 * data and the caller decides where it goes — no second state store beside the
 * SQLite database (invariant 22).
 *
 * Two caches make a ten-second loop affordable: `updatedAt` skips a Pull
 * Request whose conversation cannot have changed, and the ETag cache in
 * `comments.ts` turns the requests that survive into conditional ones.
 */

/** WebMux's display-sync interval. */
export const DEFAULT_SYNC_INTERVAL_MS = 10_000;
/** How many review-comment reads run at once. */
export const REVIEW_COMMENT_CONCURRENCY = 5;

/** Last-seen `updatedAt` per Pull Request URL — skips unchanged conversations. */
const prUpdatedAtCache = new Map<string, string>();
/** Cached review comments per Pull Request URL, reused while `updatedAt` holds. */
const prCommentsCache = new Map<string, PullRequestComment[]>();

/** Empty the sync caches. Test seam — the module state is otherwise process-wide. */
export function resetPullRequestSyncCache(): void {
  prUpdatedAtCache.clear();
  prCommentsCache.clear();
}

function byCreatedAt(a: PullRequestComment, b: PullRequestComment): number {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

export interface SyncPullRequestsOptions {
  linkedRepos?: readonly LinkedRepo[];
  /** Directory the `gh` calls run in. */
  cwd?: string;
  /**
   * Branches whose Pull Requests deserve the extra review-comment read.
   * Omitted means every branch — the caller that has no worktree set yet.
   */
  activeBranches?: ReadonlySet<string>;
  /** Where a per-repository failure is reported. Defaults to no-op. */
  onError?: (message: string) => void;
}

export interface PullRequestSync {
  /** Branch → the Pull Requests targeting it, across every repository. */
  byBranch: Map<string, PullRequestEntry[]>;
  /** One message per repository whose query failed. */
  errors: string[];
}

/**
 * One synchronisation pass.
 *
 * A repository whose query failed contributes an error and no entries; the
 * other repositories still produce data, because losing the whole pass to one
 * unreachable linked repository is worse than a partial view — the sweep that
 * must not act on partial data uses `fetchBranchPullRequestStates`, which
 * returns null instead.
 */
export async function syncPullRequests(
  options: SyncPullRequestsOptions = {},
): Promise<PullRequestSync> {
  const linkedRepos = options.linkedRepos ?? [];
  const cwd = options.cwd;

  const results = await Promise.all(
    repoTargets(linkedRepos).map((target) =>
      fetchOpenPullRequests({
        ...(target.slug === undefined ? {} : { repoSlug: target.slug }),
        ...(target.label === undefined ? {} : { repoLabel: target.label }),
        ...(cwd === undefined ? {} : { cwd }),
      }),
    ),
  );

  const byBranch = new Map<string, PullRequestEntry[]>();
  const errors: string[] = [];
  for (const result of results) {
    if (!result.ok) {
      errors.push(result.error);
      options.onError?.(result.error);
      continue;
    }
    for (const [branch, entry] of result.data) {
      const existing = byBranch.get(branch) ?? [];
      existing.push(entry);
      byBranch.set(branch, existing);
    }
  }

  // Read inline review comments only for Pull Requests of branches the caller
  // cares about, and only when `updatedAt` moved since the last pass.
  const pending: Array<{ entry: PullRequestEntry; repoSlug: string | undefined }> = [];
  for (const [branch, entries] of byBranch) {
    if (options.activeBranches && !options.activeBranches.has(branch)) continue;
    for (const entry of entries) {
      if (entry.state !== 'open') continue;
      const cachedUpdatedAt = prUpdatedAtCache.get(entry.url);
      const cached = prCommentsCache.get(entry.url);
      if (cachedUpdatedAt === entry.updatedAt && cached !== undefined) {
        entry.comments = [...entry.comments, ...cached].sort(byCreatedAt);
      } else {
        pending.push({ entry, repoSlug: repoSlugForEntry(entry, linkedRepos) });
      }
    }
  }

  if (pending.length > 0) {
    const fetched = await mapWithConcurrency(pending, REVIEW_COMMENT_CONCURRENCY, (task) =>
      fetchReviewComments(task.entry.number, {
        ...(task.repoSlug === undefined ? {} : { repoSlug: task.repoSlug }),
        ...(cwd === undefined ? {} : { cwd }),
      }),
    );
    for (const [index, task] of pending.entries()) {
      const reviewComments = fetched[index] ?? [];
      prUpdatedAtCache.set(task.entry.url, task.entry.updatedAt);
      prCommentsCache.set(task.entry.url, reviewComments);
      task.entry.comments = [...task.entry.comments, ...reviewComments].sort(byCreatedAt);
    }
  }

  evictSyncCaches(byBranch, linkedRepos);
  return { byBranch, errors };
}

/**
 * Drop cache entries for Pull Requests that are no longer open. Without it the
 * three caches grow one entry per Pull Request ever seen in the process.
 */
function evictSyncCaches(
  byBranch: ReadonlyMap<string, PullRequestEntry[]>,
  linkedRepos: readonly LinkedRepo[],
): void {
  const activeUrls = new Set<string>();
  const activePaths = new Set<string>();
  for (const entries of byBranch.values()) {
    for (const entry of entries) {
      activeUrls.add(entry.url);
      activePaths.add(reviewCommentApiPath(entry.number, repoSlugForEntry(entry, linkedRepos)));
    }
  }
  for (const url of prUpdatedAtCache.keys()) {
    if (!activeUrls.has(url)) prUpdatedAtCache.delete(url);
  }
  for (const url of prCommentsCache.keys()) {
    if (!activeUrls.has(url)) prCommentsCache.delete(url);
  }
  evictReviewCommentCache(activePaths);
}

export interface PullRequestMonitorOptions extends SyncPullRequestsOptions {
  intervalMs?: number;
  /**
   * Activity gate. When it answers `false` the tick is skipped entirely — no
   * `gh` call at all.
   *
   * This is the display-sync policy of §20: nobody is looking, so nothing is
   * queried and no rate limit is spent. A maintenance sweep that must run with
   * the dashboard closed simply omits this option; that is the difference
   * between the two upstream loops, expressed as one parameter rather than two
   * near-identical functions.
   */
  isActive?: () => boolean;
  /** Called with the result of each pass that actually ran. */
  onSync?: (sync: PullRequestSync) => void | Promise<void>;
  /** Called when a pass throws. Defaults to swallowing, as upstream does. */
  onFailure?: (error: unknown) => void;
}

/**
 * Start the periodic Pull Request sync. Returns the stop function.
 *
 * Ticks never overlap: {@link startSerializedInterval} coalesces a tick that
 * arrives mid-pass into a single rerun, so a slow GitHub cannot pile up
 * concurrent `gh` fan-outs.
 */
export function startPullRequestMonitor(options: PullRequestMonitorOptions = {}): () => void {
  const { intervalMs = DEFAULT_SYNC_INTERVAL_MS, isActive, onSync, onFailure, ...sync } = options;

  const pass = async (): Promise<void> => {
    if (isActive && !isActive()) return;
    try {
      const result = await syncPullRequests(sync);
      await onSync?.(result);
    } catch (error) {
      onFailure?.(error);
    }
  };

  return startSerializedInterval(pass, intervalMs);
}
