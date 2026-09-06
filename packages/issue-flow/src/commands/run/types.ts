import { PIPELINE_PHASES, type PipelinePhase } from '../../core/pipeline.js';
import type { SessionPublisher } from '../../core/session-state.js';
import type { ExecutionPlan } from '../../execution/types.js';
import type { ResolvedIssue } from '../../issues/types.js';
import type { IssuePaths } from '../../storage/paths.js';
import type { RunLock } from '../../storage/schemas.js';
import type { RunSummaryPrReview } from '../../ui/summary.js';
import type { PrQueueContext } from '../pr.js';

/** Runnable phase lists (excluding 'init' which is handled separately). */
export const RUNNABLE_PHASES: PipelinePhase[] = PIPELINE_PHASES.filter((phase) => phase !== 'init');
export const RUNNABLE_PHASES_NO_BRANCH: PipelinePhase[] = RUNNABLE_PHASES.filter(
  (phase) => phase !== 'pr',
);
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
 * authorized issue close, the highlighted warning and the final summary.
 *
 * Same shape the summary consumes: `requestedChanges` drives the close
 * suppression and is true on exit code 2 even when the plan is gone.
 */
export type PrReviewOutcome = RunSummaryPrReview;

/** What one failing Issue does to the rest of the queue. */
export const QUEUE_FAILURE_MODES = ['stop', 'skip', 'block'] as const;

export type QueueFailureMode = (typeof QUEUE_FAILURE_MODES)[number];

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

/** Options `run` accepts on top of the phase selection ones. */
export interface RunPipelineOptions {
  closeIssue?: boolean;
  /**
   * `--prompt <text>`: the demand itself, with no Issue behind it (§17).
   *
   * The pipeline never sees it as a prompt. It is minted into an Issue of the
   * `inline` origin before anything starts, so every phase, the acceptance
   * contract and the independent reviewer run exactly as they always did.
   */
  prompt?: string;
  /**
   * `--auto-close` / `--keep-open`: whether the run closes the agent sessions
   * it left open once it is over. `undefined` falls back to `run.autoClose`
   * in `.issue-flow.json`, whose default is off.
   *
   * A run a person took over (`human_hold`) never closes anything, whatever
   * this says — §32's takeover is the disarm.
   */
  autoClose?: boolean;
  /** `--yes`: accept the discovered hierarchy without confirmation. */
  yes?: boolean;
  /** `--only`: run just the issues informed, skipping discovery. */
  only?: boolean;
  /** `--cascade`: hierarchy of a container, without implementing it. */
  cascade?: boolean;
  /** `--background`: parent process should detach after confirmation. */
  background?: boolean;
  /** Hidden: this process is the child of a `--background` spawn. */
  detachedChild?: boolean;
  /** `--restart-web`: replace the machine-wide monitor once for this invocation. */
  restartWeb?: boolean;
  /** `--continue`: name the (automatic) User Story numbering continuity. */
  continueNumbering?: boolean;
  /** `--start-us <n>`: force the first plan of this run to start at `n`. */
  startUs?: number;
  /**
   * `--retry-limit <n>`: consecutive retries the `execute` phase may spend on a
   * transient failure. Absent means the engine default (`DEFAULTS.retryLimit`),
   * which is what every release before this flag existed used.
   */
  retryLimit?: number;
  /** `--retry-forever`: lift the retry count of the `execute` phase. */
  retryForever?: boolean;
  /**
   * `--on-issue-failure <mode>`: what one failing Issue does to the rest of a
   * queue. `stop` is the default and the behaviour of every release before the
   * flag existed.
   */
  onIssueFailure?: QueueFailureMode;
}

export interface IssueSessionInput {
  from?: string;
  noBranch?: boolean;
  prReview?: boolean;
  /** Identifiers the user asked for; only the standalone attempt needs them. */
  requested?: string[];
  runOptions?: RunPipelineOptions;
  /** One-shot restart request; queue members after the first never inherit it. */
  restartWeb?: boolean;
  queue?: QueueRunContext;
  /**
   * The dead owner whose lock this run took over. Recorded in the journal as
   * an interrupted run: something was executing here and never finished, and
   * that is the difference between a resume and a fresh start.
   */
  interruptedBy?: RunLock;
}

/** Runner for one issue session — injected to avoid a session ↔ multi-issue cycle. */
export type RunIssueSession = (
  issueNumber: string,
  mode: string,
  input: IssueSessionInput,
) => Promise<IssueRunResult>;

/** Phase orchestrator injected into the session to avoid a session ↔ phases cycle. */
export type RunPipelinePhases = (
  issueNumber: string,
  paths: IssuePaths,
  mode: string,
  publisher: SessionPublisher,
  input: IssueSessionInput,
) => Promise<IssueRunResult>;

/** An {@link IssueRunResult} carrying nothing but an exit code. */
export function failure(code: number): IssueRunResult {
  return { code, failedPhase: null, branchName: null, storyCount: 0, elapsedSeconds: 0 };
}
