/**
 * Pure mappings from parsed CLI options to command arguments.
 *
 * They live outside cli.ts because that module runs `program.parse()` on
 * import, so anything defined there is untestable.
 */

import type { WebConfig } from './schemas.js';

/** Extract ephemeral/config-backed web flags from commander's camel-cased options. */
export function resolveWebOverrides(opts: Record<string, unknown>): Partial<WebConfig> {
  const overrides: Partial<WebConfig> = {};
  if (opts.web === true || opts.serve === true || opts.restartWeb === true) {
    overrides.enabled = true;
  }
  if (opts.port !== undefined) overrides.port = opts.port as number;
  if (opts.host !== undefined) overrides.host = opts.host as string;
  if (opts.refresh !== undefined) overrides.refreshSeconds = opts.refresh as number;
  if (opts.webLogLimit !== undefined) overrides.logLimit = opts.webLogLimit as number;
  if (opts.webNoLogs === true) overrides.includeLogs = false;
  return overrides;
}

/** Shape commander produces for a negated boolean option (`--no-branch`). */
export interface BranchFlagOptions {
  branch?: boolean;
}

/**
 * Translate commander's `--no-branch` into the tri-state `runPipeline` expects.
 *
 * Commander stores a negated option under its positive name: `--no-branch`
 * yields `{ branch: false }` and never a `noBranch` key. Reading `noBranch`
 * silently dropped the flag, so the pipeline always created a branch and opened
 * a PR.
 *
 * `undefined` (flag absent) is preserved on purpose: `runPipeline` uses it to
 * tell "the user said nothing, keep the mode persisted in tasks.json" apart
 * from an explicit choice.
 */
export function resolveNoBranch(options: BranchFlagOptions): boolean | undefined {
  return options.branch === false ? true : undefined;
}

/** Invalid flag combination on a command, reported as a CLI error. */
export class CliFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliFlagError';
  }
}

/** Options `run` accepts that select which phases the pipeline executes. */
export interface RunPhaseFlagOptions extends BranchFlagOptions {
  prReview?: boolean;
}

/** Phase selection `runPipeline` expects, both entries tri-state. */
export interface RunPhaseFlags {
  noBranch: boolean | undefined;
  prReview: boolean | undefined;
}

/** Scope flags of `run`, deciding what a discovered hierarchy does. */
export interface QueueScopeFlagOptions {
  yes?: boolean;
  only?: boolean;
  cascade?: boolean;
}

/** Resolved scope answer; both absent means "ask, when the terminal allows it". */
export interface QueueScopeFlags {
  yes: boolean | undefined;
  only: boolean | undefined;
  cascade: boolean | undefined;
}

/**
 * Resolve `--yes` / `--only`, rejecting the combination that has no meaning.
 *
 * They answer the same question in opposite ways — run everything that was
 * discovered, or run only what was asked for — so passing both is a mistake
 * worth naming rather than silently resolving by precedence.
 *
 * @throws CliFlagError when both are present.
 */
export function resolveQueueScopeFlags(options: QueueScopeFlagOptions): QueueScopeFlags {
  if (options.yes === true && options.only === true) {
    throw new CliFlagError(
      '--yes cannot be combined with --only: --yes runs the whole discovered hierarchy, ' +
        '--only runs just the issues you informed.',
    );
  }
  if (options.cascade === true && options.only === true) {
    throw new CliFlagError(
      '--cascade cannot be combined with --only: --cascade runs the container hierarchy, ' +
        '--only runs just the issues you informed.',
    );
  }

  return {
    yes: options.yes === true ? true : undefined,
    only: options.only === true ? true : undefined,
    cascade: options.cascade === true ? true : undefined,
  };
}

/**
 * Resolve the phase-selection flags of `run`, rejecting the one combination
 * that cannot work.
 *
 * `--no-branch` skips the `pr` phase, so there is no Pull Request for
 * `--pr-review` to review. Failing here — before any phase runs — beats
 * discovering it at the end of a full pipeline.
 *
 * Both values stay `undefined` when the user passed nothing: `runPipeline`
 * uses that to tell "no opinion, keep what tasks.json persisted" apart from an
 * explicit choice.
 *
 * @throws CliFlagError when `--pr-review` is combined with `--no-branch`.
 */
export function resolveRunPhaseFlags(options: RunPhaseFlagOptions): RunPhaseFlags {
  const noBranch = resolveNoBranch(options);
  const prReview = options.prReview === true ? true : undefined;

  if (prReview === true && noBranch === true) {
    throw new CliFlagError(
      '--pr-review cannot be combined with --no-branch: --no-branch skips the pr phase, ' +
        'so there is no Pull Request to review.',
    );
  }

  return { noBranch, prReview };
}

/** Options `run` and `plan` accept to override User Story numbering (issue #36). */
export interface UserStoryNumberingFlagOptions {
  continue?: boolean;
  startUs?: number;
}

/** Resolved User Story numbering override, ready for `determineUserStoryNumbering()`. */
export interface UserStoryNumberingFlags {
  continueFlag: boolean;
  startUs: number | undefined;
}

/**
 * Resolve the `--continue` / `--start-us <n>` override of the User Story
 * numbering cascade (issue #36), rejecting the one combination that cannot
 * work: the two disagree about whether history should be consulted at all.
 *
 * @throws CliFlagError when both flags are passed together.
 */
export function resolveUserStoryNumberingFlags(
  options: UserStoryNumberingFlagOptions,
): UserStoryNumberingFlags {
  const continueFlag = options.continue === true;
  const startUs = options.startUs;

  if (continueFlag && startUs !== undefined) {
    throw new CliFlagError(
      '--continue and --start-us cannot be combined: choose either the last known numbering ' +
        '(--continue) or an explicit override (--start-us).',
    );
  }

  return { continueFlag, startUs };
}
