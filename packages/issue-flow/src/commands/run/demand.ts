import { parseIssueArguments } from '../../issues/args.js';

/**
 * What one `issue-flow run` was asked to work on.
 *
 * One or more issue identifiers and a free prompt share this boundary. A free
 * prompt is represented as an inline Issue, so execution has one path. A
 * demand is required and mutually exclusive inputs are rejected explicitly.
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
 * `undefined` means "the user said nothing", and the caller uses the project's
 * configuration. Closing is opt-in so the working tree, branch and sessions
 * remain available unless requested otherwise.
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
