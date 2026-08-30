import type { PipelinePhase } from '../../core/pipeline.js';
import type { ExecutionPlan } from '../../execution/types.js';
import type { ResolvedIssue } from '../../issues/types.js';
import type { RunSummaryPrReview } from '../../ui/summary.js';
import type { PrQueueContext } from '../pr.js';

/** Runnable phase lists (excluding 'init' which is handled separately). */
export const RUNNABLE_PHASES: PipelinePhase[] = ['prd', 'plan', 'execute', 'review', 'pr'];
export const RUNNABLE_PHASES_NO_BRANCH: PipelinePhase[] = ['prd', 'plan', 'execute', 'review'];
export const RUNNABLE_PHASES_WITH_PR_REVIEW: PipelinePhase[] = [...RUNNABLE_PHASES, 'pr-review'];

/**
 * Phases of a queue's closing pass: the work is already committed by the
 * per-issue runs, so all that is left is the single consolidated Pull Request.
 */
export const QUEUE_PR_PHASES = ['init', 'pr'] as const satisfies readonly PipelinePhase[];
export const QUEUE_PR_PHASES_WITH_REVIEW = [
  'init',
  'pr',
  'pr-review',
] as const satisfies readonly PipelinePhase[];
export const RUNNABLE_QUEUE_PR_PHASES: PipelinePhase[] = ['pr'];
export const RUNNABLE_QUEUE_PR_PHASES_WITH_REVIEW: PipelinePhase[] = ['pr', 'pr-review'];

/**
 * What the `pr-review` phase left behind, for the steps that run after it: the
 * automatic issue close, the highlighted warning and the final summary.
 *
 * Same shape the summary consumes: `requestedChanges` drives the close
 * suppression and is true on exit code 2 even when the plan is gone.
 */
export type PrReviewOutcome = RunSummaryPrReview;

/** What one failing Issue does to the rest of the queue. */
export type QueueFailureMode =
  | /** End the run where it failed. The behaviour that has always been. */ 'stop'
  | /** Set it aside, run the independent work, come back to it. */ 'skip'
  | /** Set it aside for a human, and never come back to it. */ 'block';

/**
 * Everything a queue hands to the run of one of its issues.
 *
 * Its presence is what tells `runPipelinePhases` it is a member of a queue
 * rather than a standalone pipeline: the Pull Request moves to the end of the
 * queue, the branch is shared, commits carry the issue scope, and the terminal
 * summary is the queue's, not the issue's.
 */
export interface QueueRunContext {
  /** State of the queue, for the branch every issue of it shares. */
  plan: ExecutionPlan;
  /** True when `init` already ran in this process for the queue. */
  preChecked: boolean;
  /** Issue already resolved by the planner, if this is the primary one. */
  resolved?: ResolvedIssue;
  /**
   * Set on the final pass of a queue, which runs no implementation phase at
   * all: only `pr` (and the optional `pr-review`), for the single Pull Request
   * that consolidates every issue.
   */
  finalPr?: PrQueueContext;
}

/** What one issue's run reports back to the caller. */
export interface IssueRunResult {
  code: number;
  /** Phase that failed, `null` on success. */
  failedPhase: string | null;
  /** `branchName` of the issue's plan once the `plan` phase produced one. */
  branchName: string | null;
  storyCount: number;
  elapsedSeconds: number;
  /** Verdict of the `pr-review` phase, when it ran. */
  review?: PrReviewOutcome | null;
  /** Set when the run stopped to hand control over to a queue. */
  queue?: { plan: ExecutionPlan; resumed: boolean; resolved: ResolvedIssue };
}
