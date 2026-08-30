import {
  PIPELINE_PHASES,
  PIPELINE_PHASES_NO_BRANCH,
  PIPELINE_PHASES_WITH_PR_REVIEW,
  type PipelinePhase,
} from '../../core/pipeline.js';
import type { UserStory } from '../../types.js';
import {
  QUEUE_PR_PHASES,
  QUEUE_PR_PHASES_WITH_REVIEW,
  RUNNABLE_PHASES,
  RUNNABLE_PHASES_NO_BRANCH,
  RUNNABLE_PHASES_WITH_PR_REVIEW,
  RUNNABLE_QUEUE_PR_PHASES,
  RUNNABLE_QUEUE_PR_PHASES_WITH_REVIEW,
  type RunPipelineOptions,
} from './types.js';

/**
 * Retry budget of the `execute` phase (`--retry-limit`, `--retry-forever`).
 * Left `undefined` when the flags are absent so `createConfig()` applies the
 * engine defaults — passing a number here would make `run` diverge from
 * `execute` the moment one of those defaults changes.
 */
export function resolveExecuteRetry(runOptions?: RunPipelineOptions): {
  retryLimit: number | undefined;
  retryForever: boolean | undefined;
} {
  return {
    retryLimit: runOptions?.retryLimit,
    retryForever: runOptions?.retryForever,
  };
}

/**
 * User Story numbering flags (issue #36). `--start-us` names a starting
 * point, so the queue only ever hands it to the first issue it runs —
 * applying it to each one would give them all the same ids, the very
 * collision #36 set out to remove. Every later issue continues from history,
 * which by then already includes the plans written earlier in this run.
 */
export function resolveStoryNumbering(runOptions?: RunPipelineOptions): {
  continueNumbering: boolean | undefined;
  startUs: number | undefined;
} {
  return {
    continueNumbering: runOptions?.continueNumbering,
    startUs: runOptions?.startUs,
  };
}

/** Fields of an existing `tasks.json` that affect --no-branch / --pr-review. */
export interface PersistedPlanFlags {
  noBranch: boolean;
  prReviewEnabled: boolean;
  issueUrl?: string;
  branchName?: string;
  userStories: readonly UserStory[];
}

export interface BranchAndReviewModes {
  effectiveNoBranch: boolean;
  effectivePrReview: boolean;
  /** Warnings to print, in order — empty when nothing conflicts. */
  warnings: string[];
  planIssueUrl: string | undefined;
  planBranch: string | undefined;
  planStories: UserStory[];
}

/**
 * Resolve `--no-branch` and `--pr-review` against a persisted plan (if any).
 *
 * Precedences deliberately differ:
 *
 * - **`--no-branch`**: persisted value takes precedence on resume. Changing the
 *   branch mode mid-pipeline would rewrite what earlier phases already did.
 * - **`--pr-review`**: flag > persisted value > default (off). Unlike
 *   `--no-branch`, the flag wins: the phase adds a step at the end instead of
 *   changing what the earlier phases did, so opting in on resume is safe.
 *
 * The CLI rejects `--pr-review` with `--no-branch`, but the persisted no-branch
 * mode can only be known here. Without a pr phase there is no Pull Request to
 * review, so the opt-in is dropped instead of failing a resumed run.
 */
export function resolveBranchAndReviewModes(input: {
  noBranch: boolean | undefined;
  prReview: boolean | undefined;
  persisted: PersistedPlanFlags | null;
}): BranchAndReviewModes {
  const warnings: string[] = [];

  if (input.persisted === null) {
    // No tasks.json yet — use the CLI flag as-is
    const effectiveNoBranch = input.noBranch ?? false;
    let effectivePrReview = input.prReview ?? false;
    if (effectiveNoBranch && effectivePrReview) {
      warnings.push(
        'This pipeline runs with --no-branch and opens no PR. Skipping the pr-review phase.',
      );
      effectivePrReview = false;
    }
    return {
      effectiveNoBranch,
      effectivePrReview,
      warnings,
      planIssueUrl: undefined,
      planBranch: undefined,
      planStories: [],
    };
  }

  const persistedNoBranch = input.persisted.noBranch;
  // Resolve pr-review mode: flag > persisted value > default (off).
  let effectivePrReview = input.prReview ?? input.persisted.prReviewEnabled;

  // Only warn when the user explicitly passed a flag that conflicts with the persisted value
  if (input.noBranch !== undefined && input.noBranch !== persistedNoBranch) {
    if (persistedNoBranch) {
      warnings.push(
        'This pipeline was started with --no-branch. Ignoring current flag; using persisted mode.',
      );
    } else {
      warnings.push(
        'This pipeline was started without --no-branch. Ignoring current flag; using persisted mode.',
      );
    }
  }

  // Persisted mode wins on resume
  const effectiveNoBranch = persistedNoBranch;

  if (effectiveNoBranch && effectivePrReview) {
    warnings.push(
      'This pipeline runs with --no-branch and opens no PR. Skipping the pr-review phase.',
    );
    effectivePrReview = false;
  }

  return {
    effectiveNoBranch,
    effectivePrReview,
    warnings,
    planIssueUrl: input.persisted.issueUrl,
    planBranch: input.persisted.branchName,
    planStories: [...input.persisted.userStories],
  };
}

/**
 * Inside a queue the Pull Request is opened once, after the last issue, so
 * `pr` (and with it `pr-review`) leaves the per-issue phase list. The list is
 * the same one `--no-branch` uses, but the branch is still created: what
 * changes is who opens the Pull Request, not whether there is a branch.
 *
 * The queue's last pass implements nothing: it only opens the single Pull
 * Request that covers every issue already committed to the shared branch.
 */
export function selectPhaseLists(input: {
  finalPr: boolean;
  inQueue: boolean;
  effectiveNoBranch: boolean;
  effectivePrReview: boolean;
}): {
  activePhases: readonly PipelinePhase[];
  phaseOrder: PipelinePhase[];
} {
  const { finalPr, inQueue, effectiveNoBranch, effectivePrReview } = input;
  const activePhases = finalPr
    ? effectivePrReview
      ? QUEUE_PR_PHASES_WITH_REVIEW
      : QUEUE_PR_PHASES
    : inQueue
      ? PIPELINE_PHASES_NO_BRANCH
      : effectiveNoBranch
        ? PIPELINE_PHASES_NO_BRANCH
        : effectivePrReview
          ? PIPELINE_PHASES_WITH_PR_REVIEW
          : PIPELINE_PHASES;
  const phaseOrder = finalPr
    ? effectivePrReview
      ? RUNNABLE_QUEUE_PR_PHASES_WITH_REVIEW
      : RUNNABLE_QUEUE_PR_PHASES
    : inQueue
      ? RUNNABLE_PHASES_NO_BRANCH
      : effectiveNoBranch
        ? RUNNABLE_PHASES_NO_BRANCH
        : effectivePrReview
          ? RUNNABLE_PHASES_WITH_PR_REVIEW
          : RUNNABLE_PHASES;
  return { activePhases, phaseOrder };
}
