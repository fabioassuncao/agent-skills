/**
 * Shared TypeScript interfaces for the Issue Flow CLI.
 * These types mirror the tasks.json schema used by the issue-flow pipeline.
 */

import type { ClaudeUsage } from './core/metrics.js';

/**
 * Granular lifecycle state of a story, for consumers that need more than the
 * binary `passes` (a Kanban board, for instance).
 *
 * `in_review` has no automatic derivation: nothing in the pipeline produces it,
 * so it only ever comes from an explicit value in `tasks.json`.
 */
export type UserStoryStatus = 'backlog' | 'in_progress' | 'in_review' | 'done';

/**
 * A single story of the plan.
 *
 * The metrics inherited from {@link ClaudeUsage} plus `durationSeconds` are all
 * optional and purely observational: they are written by the execute loop when
 * the story completes, and a `tasks.json` produced before they existed (or by a
 * CLI that reports no usage) simply omits them. Absent means "not reported",
 * never zero.
 */
export interface UserStory extends ClaudeUsage {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  passes: boolean;
  notes: string;
  durationSeconds?: number;
  /**
   * Observational only: the pipeline keeps deciding what to execute from
   * `passes`. Absent means "not informed" — never assume `'backlog'` here.
   */
  status?: UserStoryStatus;
  /**
   * IDs of other stories in the same plan this one depends on. Validated by
   * shape only (`string[]`): neither existence nor cycles are checked, and
   * nothing in the pipeline orders execution by it.
   */
  dependencies?: string[];
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
  /**
   * Conventional-commit scope the execute prompt must use, e.g. `issue-71`
   * producing `feat(issue-71): …`.
   *
   * Only set when several issues share a branch (a multi-issue queue), where the
   * commit message is the only thing that says which issue a change belongs to.
   * Absent means the historical format, `feat: [Story ID] - [Story Title]`.
   */
  commitScope?: string;
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
  /** Token/cost metrics reported by the CLI, or null when unavailable. */
  cost: ClaudeUsage | null;
}
