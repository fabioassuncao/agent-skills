import { parseIssueArguments } from '../../issues/args.js';

/**
 * What one `issue-flow run` was asked to work on.
 *
 * §17 of the absorption plan converges `webmux oneshot` into `run`, and the
 * entry side of that convergence is this module: the Issue Flow way in (one or
 * more issue identifiers) is kept, and the WebMux way in (a free prompt) is
 * accepted **as an Issue**, under `source: 'inline'`.
 *
 * The validation is ported from `parseOneshotArgs`
 * (`.references/webmux-main/bin/src/oneshot.ts` @ d8c9d5f). What is preserved
 * is its posture, not its flags: a demand is required, a demand given twice in
 * two spellings is rejected rather than silently resolved, and every rejection
 * names the offending argument. The `--linear` and `--branch` clauses are not
 * ported: restored Linear posting/pickup live in the integration surface, and
 * `run` derives its branch from the plan.
 */

/** Malformed or contradictory demand flags, reported as a CLI error. */
export class RunDemandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunDemandError';
  }
}

export interface RunDemandFlags {
  /** Positional identifiers, as commander hands them over. */
  issues?: readonly string[];
  /** `--prompt <text>`: the demand itself, with no Issue behind it. */
  prompt?: string;
  /** `--auto-close`: close what the run leaves open once it is done. */
  autoClose?: boolean;
  /** `--keep-open`: the explicit opposite, which also revokes a configured default. */
  keepOpen?: boolean;
}

export type RunDemand =
  | { kind: 'issues'; ids: string[] }
  /** A free prompt. The Issue is minted before the pipeline starts. */
  | { kind: 'prompt'; prompt: string };

/**
 * Settle what this invocation runs.
 *
 * @throws RunDemandError when no demand was given, or when two were.
 */
export function resolveRunDemand(flags: RunDemandFlags): RunDemand {
  const issues = flags.issues ?? [];
  const prompt = flags.prompt;

  if (prompt !== undefined) {
    // Upstream: `--prompt requires a value`. Commander already rejects a
    // missing value, so what is left to catch is a value that is only
    // whitespace — which reaches the agent as an empty demand.
    if (prompt.trim() === '') {
      throw new RunDemandError('--prompt requires a value.');
    }
    if (issues.length > 0) {
      throw new RunDemandError(
        `Cannot pass both an issue (${issues.join(', ')}) and --prompt; --prompt is the demand itself.`,
      );
    }
    return { kind: 'prompt', prompt };
  }

  if (issues.length === 0) {
    throw new RunDemandError(
      'No demand was informed. Pass at least one issue number, or describe the work with --prompt.',
    );
  }

  return { kind: 'issues', ids: parseIssueArguments(issues) };
}

/**
 * Whether this invocation closes what it opened when the run finishes.
 *
 * `undefined` means "the user said nothing", and the caller falls back to the
 * project's configuration. Unlike upstream — where auto-close is the default
 * because the oneshot *is* the session — closing is opt-in here: `run` has
 * always left the working tree, the branch and any session it touched in
 * place, and a flag added to an existing command must not change what the
 * command already did.
 *
 * @throws RunDemandError when both flags are passed.
 */
export function resolveAutoCloseFlag(flags: RunDemandFlags): boolean | undefined {
  if (flags.autoClose === true && flags.keepOpen === true) {
    throw new RunDemandError('--auto-close and --keep-open are mutually exclusive; pass only one.');
  }
  if (flags.autoClose === true) return true;
  if (flags.keepOpen === true) return false;
  return undefined;
}
