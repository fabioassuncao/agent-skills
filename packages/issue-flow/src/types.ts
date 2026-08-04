/**
 * Shared TypeScript interfaces for the Issue Flow CLI.
 * These types mirror the tasks.json schema used by the issue-flow pipeline.
 */

export interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  passes: boolean;
  notes: string;
}

export interface LastError {
  category: string;
  message: string;
  at: string;
}

export interface PipelineState {
  analyzeCompleted?: boolean;
  prdCompleted: boolean;
  jsonCompleted: boolean;
  executionCompleted: boolean;
  reviewCompleted: boolean;
  prCreated: boolean;
  /**
   * Optional like `analyzeCompleted`: the `pr-review` phase is opt-in, so every
   * `tasks.json` written before it existed stays valid without the field.
   */
  prReviewCompleted?: boolean;
}

/**
 * The Pull Request opened by the `pr` phase, persisted so later phases can
 * address it without querying GitHub again.
 */
export interface PullRequestRef {
  number: number;
  url: string;
  headBranch: string;
  createdAt: string;
}

export type PrReviewRecommendation = 'APPROVE' | 'APPROVE_WITH_SUGGESTIONS' | 'REQUEST_CHANGES';

/**
 * State of the opt-in `pr-review` phase. `enabled` mirrors `noBranch`: it is
 * the persisted answer used when the flag is absent on a resumed run.
 */
export interface PrReviewState {
  enabled: boolean;
  pullRequestNumber?: number;
  rounds: number;
  lastRecommendation?: PrReviewRecommendation;
  lastReviewedAt?: string;
}

export interface TaskPlan {
  project: string;
  /** Numeric for GitHub Issues, string for local (possibly non-numeric) ids. */
  issueNumber: number | string;
  /**
   * `''` when the Issue has no remote counterpart (local-only demands).
   * Always a string once loaded through `taskPlanSchema`, which defaults the
   * field — never actually `undefined` at runtime, unlike a plain optional.
   */
  issueUrl: string;
  branchName: string;
  noBranch?: boolean;
  description: string;
  issueStatus: 'pending' | 'in_progress' | 'completed';
  completedAt: string | null;
  lastAttemptAt: string | null;
  lastError: LastError | null;
  correctionCycle: number;
  maxCorrectionCycles: number;
  /**
   * Findings from the most recent failed review, verbatim; `null` once
   * addressed or when no review has failed yet. Non-null means the issue has
   * a pending correction even if every userStories[].passes is already
   * true — see the early-return guards in core/engine.ts.
   */
  lastReviewFindings: string | null;
  pipeline: PipelineState;
  /** Written by the `pr` phase; absent in every plan created before it. */
  pullRequest?: PullRequestRef;
  /** Written by the `pr-review` phase; absent while the phase never ran. */
  prReview?: PrReviewState;
  userStories: UserStory[];
}

export interface EngineConfig {
  issueNumber: string | undefined;
  maxIterations: number | undefined;
  retryLimit: number;
  retryForever: boolean;
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
}

export interface ResolvedPaths {
  prdFile: string;
  progressFile: string;
  archiveDir: string;
  lastBranchFile: string;
  projectRoot: string;
}

export interface ClaudeResult {
  exitCode: number;
  output: string;
}
