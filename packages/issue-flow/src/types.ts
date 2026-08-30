/**
 * Shared TypeScript interfaces for the Issue Flow CLI.
 * These types mirror the tasks.json schema used by the issue-flow pipeline.
 */

import type { ClaudeUsage } from './core/metrics.js';
import type { ExecutionRecord } from './telemetry/types.js';

/**
 * Granular lifecycle state of a story, for consumers that need more than the
 * binary `passes` (a Kanban board, for instance).
 *
 * `in_review` has no automatic derivation: nothing in the pipeline produces it,
 * so it only ever comes from an explicit value in `tasks.json`.
 */
export type UserStoryStatus = 'backlog' | 'in_progress' | 'in_review' | 'done';

/**
 * Fine-grained execution stage of a story, tracking the real pipeline cycle
 * (execute -> review -> correction when needed -> done) instead of the
 * binary `passes`. Unlike {@link UserStoryStatus} (a board-style summary),
 * `stage` is derived only from real pipeline events — see
 * `core/session-state.ts`'s `applyEvent` for the transition rules.
 *
 * - `pending`: not yet the story `execute` is working on.
 * - `executing`: the story `iteration:start` published as the active one.
 * - `awaiting_review`: `passes` just flipped to `true`, but the `review`
 *   phase has not started yet.
 * - `in_review`: the `review` phase is running (`phase:start`).
 * - `in_correction`: an automatic correction cycle is in progress
 *   (`correction:cycle`) — pipeline-wide, since correction re-runs the whole
 *   `execute`+`review` cycle rather than targeting one story.
 * - `done`: the `review` phase finished successfully (`phase:end`, success).
 * - `failed`: the `review` phase finished in failure after exhausting the
 *   correction cycles.
 */
export type StoryStage =
  | 'pending'
  | 'executing'
  | 'awaiting_review'
  | 'in_review'
  | 'in_correction'
  | 'done'
  | 'failed';

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
  /**
   * Execution-stage snapshot, mirroring `SessionStorySnapshot.stage`.
   * Nothing in the pipeline writes this back onto `tasks.json` today; it
   * exists purely as an optional, observational hint (same treatment as
   * `status`) for a plan that wants to seed a story's stage explicitly.
   * Absent means "not informed".
   */
  stage?: StoryStage;
  stageSince?: string;
  stageDetail?: string;
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

/**
 * Status of one issue's run, the issue-level projection of `RunStatus` in
 * `resilience/policy.ts`.
 *
 * `idle` is the name `queued` takes when there is no queue, and the two
 * terminal states of the run machine are absent on purpose: "this issue is
 * done" is already `issueStatus`, and duplicating it here would create two
 * answers to one question.
 */
export type IssueRunStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'retrying'
  | 'paused'
  | 'blocked'
  | 'failed';

/**
 * The process that owns this run.
 *
 * `pid` plus `host` is what lets a second invocation tell "someone is working
 * on this" from "someone died holding it": the pid is only meaningful on the
 * host that wrote it.
 */
export interface RunOwner {
  pid: number;
  host: string;
  startedAt: string;
}

export interface IssueRunState {
  status: IssueRunStatus;
  /** Phase the run is in, `null` between phases and before the first one. */
  currentPhase: string | null;
  /** 1-based attempt of `currentPhase`; `0` while no attempt has started. */
  attempt: number;
  /** Last sign of life. Stale plus a dead pid is what makes a lock reclaimable. */
  lastHeartbeatAt: string | null;
  /** Why a human is needed. Non-null only while `status` is `blocked`. */
  blockedReason: string | null;
  owner: RunOwner | null;
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
  /**
   * Where this issue's run stands *right now*, as opposed to how far it got.
   *
   * `pipeline` answers "which phases are done" and is what `PipelineManager`
   * resumes from; it cannot answer "is anything running", "is it waiting on a
   * backoff", "did someone have to be called". Before this field, resumption
   * worked by accident — `nextQueueIssue()` treating a stale `in_progress` as
   * "resume this first" — and a `Ctrl+C` left no trace at all.
   *
   * Optional and purely additive: a plan written before it simply has none, and
   * absent means exactly what it always meant.
   */
  runState?: IssueRunState;
  /** Written by the `pr` phase; absent in every plan created before it. */
  pullRequest?: PullRequestRef;
  /** Written by the `pr-review` phase; absent while the phase never ran. */
  prReview?: PrReviewState;
  userStories: UserStory[];
  /**
   * One row per agent invocation. Additive and optional: a plan written
   * before this field has none, and absent is not the same as `[]`.
   */
  executions?: ExecutionRecord[];
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
  /**
   * How many related stories the execute agent may close in one session.
   * Default `1` is the historical "ONE story per iteration".
   */
  storiesPerIteration?: number;
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
