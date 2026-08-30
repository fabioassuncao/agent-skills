import type { IssueSource } from '../issues/types.js';
import type { LastError, PullRequestRef } from '../types.js';

/**
 * Domain model of a **multi-issue execution queue**: several Issues resolved in
 * one `run`, in a computed order, on a single shared branch.
 *
 * It sits deliberately *above* `TaskPlan` rather than replacing it: each Issue
 * of the queue keeps its own `tasks.json` (stories, phases, metrics, review
 * state), and only the coordination lives here. That is what keeps every phase
 * — and the whole single-issue path — untouched.
 */

/** Priority read from the Issue's labels; `null` when it carries none. */
export type IssuePriority = 'high' | 'medium' | 'low';

/**
 * Lifecycle of one Issue inside the queue.
 *
 * `blocked` and `skipped` are what let a queue survive one bad Issue:
 * `blocked` means a human is needed and no retry will help, `skipped` means the
 * queue moved on and will come back to it. Neither is reachable without the
 * queue policy asking for it, so a plan written before they existed still only
 * ever holds the original four.
 */
export type QueueIssueStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped';

/** Lifecycle of the queue itself, derived from its entries. */
export type QueueStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** Why an Issue is part of the queue. */
export type QueueIssueOrigin = 'requested' | 'discovered';

/** What the queue does with this entry. */
export type QueueIssueRole = 'executable' | 'container';

export interface ExecutionPlanIssue {
  /** Provider-scoped identifier, the same string `Issue.id` carries. */
  id: string;
  /** Numeric form when the origin uses one, `null` otherwise. */
  number: number | null;
  title: string;
  /** Remote URL, `null` for an Issue with no remote counterpart. */
  url: string | null;
  source: IssueSource;
  /** 1-based position in the execution order. */
  position: number;
  status: QueueIssueStatus;
  origin: QueueIssueOrigin;
  /**
   * `container` names the branch and the PR and never runs a phase.
   * Default `executable` so a plan written before this field stays runnable.
   */
  role: QueueIssueRole;
  /** Blockers discovered in the graph but left out of this queue. */
  externalDependencies: string[];
  /** Ids inside the queue this one must wait for. */
  dependsOn: string[];
  /** Parent Issue in the hierarchy, informative. */
  parent: string | null;
  priority: IssuePriority | null;
  /**
   * True when at least one relation of this Issue was found only by the textual
   * heuristic, so a UI can flag it as lower-confidence.
   */
  heuristic: boolean;
  /** Phase the Issue was running when it failed, `null` otherwise. */
  failedPhase: string | null;
  lastError: LastError | null;
  /**
   * How many times the queue has handed this Issue to the pipeline.
   *
   * A queue that skips a failing Issue and comes back to it needs a count, or
   * "come back later" becomes "come back forever". `0` on a plan written before
   * the field existed, which is exactly right: nothing had been counted.
   */
  attempts: number;
  /** Why a human is needed. Non-null only while `status` is `blocked`. */
  blockedReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** An Issue that was discovered but left out of the queue. */
export interface ExecutionPlanExcluded {
  id: string;
  number: number | null;
  title: string;
  url: string | null;
  /** Human-readable reason, shown in the consolidated Pull Request body. */
  reason: string;
}

export interface ExecutionPlan {
  schemaVersion: 1;
  /** Queue id: the identifier of the primary (first requested) Issue. */
  id: string;
  /** Project id of the global storage tree the queue belongs to. */
  project: string;
  /** Identifiers the user asked for, verbatim and in order. */
  requested: string[];
  /**
   * Branch shared by every Issue of the queue. `null` until the first `plan`
   * phase produced one — the branch name is derived by the agent from the
   * primary Issue's title, exactly as in a single-issue run.
   */
  branchName: string | null;
  noBranch: boolean;
  prReview: boolean;
  status: QueueStatus;
  createdAt: string;
  updatedAt: string;
  /** True when the discovery hit its node/depth limit. */
  truncated: boolean;
  issues: ExecutionPlanIssue[];
  excluded: ExecutionPlanExcluded[];
  /** The single consolidated Pull Request, once the `pr` phase opened it. */
  pullRequest?: PullRequestRef;
}
