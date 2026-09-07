/**
 * The GitHub Pull Request / CI model.
 *
 * Ported from WebMux `backend/src/domain/model.ts` @ d8c9d5f (the `PrEntry`,
 * `CiCheck` and `PrComment` shapes) and from the private `Gh*` interfaces of
 * `backend/src/services/pr-service.ts`. The raw shapes live here rather than
 * inside a parser because `pr.ts` and `ci.ts` both read them, and the whole
 * point of this phase is that one responsibility has one implementation.
 */

/** Lifecycle of a Pull Request, lowercased from the `gh` payload. */
export type PullRequestState = 'open' | 'closed' | 'merged';

/** Rolled-up verdict of every check attached to a Pull Request. */
export type CiStatus = 'none' | 'pending' | 'success' | 'failed';

/** One check, after the rollup has been deduped and typed. */
export interface CiCheck {
  name: string;
  status: 'pending' | 'success' | 'failed' | 'skipped';
  url: string | null;
  /** GitHub Actions run id parsed out of the details URL; null for external CI. */
  runId: number | null;
}

/**
 * A Pull Request comment. `comment` is a conversation comment; `inline` is a
 * review comment anchored to a file and line, and only that variant carries
 * `path` / `line` / `diffHunk` / `isReply`.
 */
export interface PullRequestComment {
  type: 'comment' | 'inline';
  author: string;
  body: string;
  createdAt: string;
  path?: string;
  line?: number | null;
  diffHunk?: string;
  isReply?: boolean;
}

/** A Pull Request as the display sync knows it. */
export interface PullRequestEntry {
  /** Alias of the linked repository, or `''` for the current repository. */
  repo: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
  url: string;
  updatedAt: string;
  ciStatus: CiStatus;
  ciChecks: CiCheck[];
  comments: PullRequestComment[];
}

/** The fields a single-PR refresh can re-read: everything else is list-only. */
export type PullRequestStatus = Pick<PullRequestEntry, 'state' | 'isDraft'>;

/** The subset of `gh pr list --json number,url,title` the branch lookup needs. */
export interface PullRequestSummary {
  number: number;
  url: string;
  title: string;
}

/* ── raw `gh` payload shapes ────────────────────────────────────────────── */

export type GhCheckStatus =
  | 'QUEUED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'WAITING'
  | 'REQUESTED'
  | 'PENDING';

export type GhCheckConclusion =
  | 'SUCCESS'
  | 'FAILURE'
  | 'NEUTRAL'
  | 'CANCELLED'
  | 'SKIPPED'
  | 'TIMED_OUT'
  | 'ACTION_REQUIRED';

export interface GhComment {
  author: { login: string };
  body: string;
  createdAt: string;
}

export interface GhReviewComment {
  body: string;
  path: string;
  line: number | null;
  diff_hunk: string;
  user: { login: string };
  created_at: string;
  in_reply_to_id?: number;
}

/** CheckRun entries from GitHub Actions. */
export interface GhCheckRunEntry {
  __typename: 'CheckRun';
  conclusion: GhCheckConclusion | null;
  status: GhCheckStatus;
  name: string;
  detailsUrl: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

/** StatusContext entries from external CI (e.g. Vercel). */
export interface GhStatusContextEntry {
  __typename: 'StatusContext';
  context: string;
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED';
  targetUrl: string | null;
  createdAt?: string | null;
}

export type GhCheckEntry = GhCheckRunEntry | GhStatusContextEntry;

export interface GhPullRequestEntry {
  number: number;
  headRefName: string;
  state: string;
  isDraft?: boolean;
  updatedAt: string;
  statusCheckRollup: GhCheckEntry[] | null;
  url: string;
  comments: GhComment[];
}
