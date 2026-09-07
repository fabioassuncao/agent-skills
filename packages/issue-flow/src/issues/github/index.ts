/**
 * GitHub Pull Request, CI and review-comment reading.
 *
 * The single implementation of each of those responsibilities (§20 of the
 * WebMux absorption). Pull Request *creation* is not here: it lives in
 * `commands/pr.ts`, where the deterministic `Closes` / `Refs` body is built.
 */
export {
  dedupeLatestChecks,
  deriveCheckStatus,
  type FailedRunLog,
  type FetchFailedRunLogOptions,
  fetchFailedRunLog,
  mapChecks,
  parseRunId,
  summarizeChecks,
} from './ci.js';
export { GH_TIMEOUT_MS, gh, ghBounded, ghPolicy, ghProbePolicy } from './client.js';
export {
  evictReviewCommentCache,
  type FetchReviewCommentsOptions,
  fetchReviewComments,
  hasCachedReviewComments,
  parseReviewComments,
  REVIEW_COMMENT_LIMIT,
  resetReviewCommentCache,
  reviewCommentApiPath,
  splitHttpMessage,
} from './comments.js';
export {
  type LinkedRepo,
  type RepoTarget,
  repoSlugForEntry,
  repoTargets,
} from './linked-repos.js';
export {
  DEFAULT_SYNC_INTERVAL_MS,
  type PullRequestMonitorOptions,
  type PullRequestSync,
  resetPullRequestSyncCache,
  type SyncPullRequestsOptions,
  startPullRequestMonitor,
  syncPullRequests,
} from './monitor.js';
export {
  type BranchPullRequestEvidence,
  type FetchPullRequestsOptions,
  type FetchPullRequestsResult,
  fetchBranchPullRequestStates,
  fetchOpenPullRequests,
  fetchPullRequestStatus,
  type ListPullRequestsForBranchOptions,
  listPullRequestsForBranch,
  PR_FETCH_LIMIT,
  parsePullRequestList,
  parsePullRequestStatus,
  refreshStalePullRequests,
  type ViewPullRequestOptions,
  viewPullRequest,
} from './pr.js';
export type {
  CiCheck,
  CiStatus,
  GhCheckEntry,
  GhCheckRunEntry,
  GhStatusContextEntry,
  PullRequestComment,
  PullRequestEntry,
  PullRequestState,
  PullRequestStatus,
  PullRequestSummary,
} from './types.js';
