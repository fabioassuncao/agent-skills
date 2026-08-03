/**
 * Origin-agnostic domain model for Issues.
 *
 * Every provider (GitHub, local files, or any future source) maps its own
 * payload into `Issue`, so the rest of the pipeline never needs to know where
 * the demand came from.
 */

/** Registered Issue origins. */
export type IssueSource = 'github' | 'local';

/** Lifecycle state, normalized across providers (GitHub reports OPEN/CLOSED). */
export type IssueState = 'open' | 'closed';

export interface Issue {
  /** Provider-scoped identifier as a string (e.g. '23'). Always present. */
  id: string;
  /** Numeric identifier when the origin uses one, `null` for non-numeric ids. */
  number: number | null;
  title: string;
  body: string;
  labels: string[];
  state: IssueState;
  source: IssueSource;
  /** Remote reference (URL for GitHub), `null` when the Issue has no remote. */
  remoteRef: string | null;
  createdAt: string;
  updatedAt: string;
  /** `sha256:<hex>` of the normalized title + body, see `hashIssueContent`. */
  contentHash: string;
  /** Untouched provider payload, kept for debugging. */
  raw?: unknown;
}

/**
 * Content for an Issue that does not exist yet. Providers turn a draft into a
 * full `Issue` in `create()`, filling in ids, timestamps and the content hash.
 */
export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
}

/**
 * Outcome of `resolveIssue`: the Issue the pipeline will work on, plus the
 * candidates that were considered, so callers can report divergence without
 * querying the providers again.
 */
export interface ResolvedIssue {
  /** The Issue every phase consumes. */
  issue: Issue;
  /** Origin the `issue` came from. */
  source: IssueSource;
  local: Issue | null;
  github: Issue | null;
  /** True when both candidates exist and their `contentHash` differs. */
  divergent: boolean;
}
