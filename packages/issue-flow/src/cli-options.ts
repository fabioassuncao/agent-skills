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
