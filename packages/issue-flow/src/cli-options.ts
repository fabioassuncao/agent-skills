/**
 * Pure mappings from parsed CLI options to command arguments.
 *
 * They live outside cli.ts because that module runs `program.parse()` on
 * import, so anything defined there is untestable.
 */

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
