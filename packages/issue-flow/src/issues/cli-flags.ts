import type { IssueGenerateTarget, IssuesConfig } from './types.js';

/**
 * Mapping from the Issue provider CLI flags to configuration overrides.
 *
 * Kept out of cli.ts (which runs `program.parse()` on import) so the
 * precedence rules stay unit-testable. Only the keys the user actually passed
 * are returned: a key present with `undefined` would override .issue-flow.json
 * when the layers are merged.
 */

export interface IssueCliFlags {
  local?: boolean;
  github?: boolean;
  preferLocal?: boolean;
  preferGithub?: boolean;
  ask?: boolean;
}

/** Invalid flag combination, reported to the user as a CLI error. */
export class IssueFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueFlagError';
  }
}

/**
 * Translate the parsed options of a command into `IssuesConfig` overrides.
 *
 * @throws IssueFlagError when mutually exclusive flags are combined.
 */
export function resolveIssuesOverrides(opts: IssueCliFlags): Partial<IssuesConfig> {
  const overrides: Partial<IssuesConfig> = {};

  if (opts.local === true && opts.github === true) {
    throw new IssueFlagError('--local and --github are mutually exclusive; pass only one.');
  }
  if (opts.local === true) {
    overrides.preferredProvider = 'local';
  }
  if (opts.github === true) {
    overrides.preferredProvider = 'github';
  }

  const conflictFlags = [
    opts.preferLocal === true ? '--prefer-local' : null,
    opts.preferGithub === true ? '--prefer-github' : null,
    opts.ask === true ? '--ask' : null,
  ].filter((flag): flag is string => flag !== null);

  if (conflictFlags.length > 1) {
    throw new IssueFlagError(
      `${conflictFlags.join(', ')} are mutually exclusive; pass only one conflict policy.`,
    );
  }
  if (opts.preferLocal === true) {
    overrides.conflictPolicy = 'prefer-local';
  }
  if (opts.preferGithub === true) {
    overrides.conflictPolicy = 'prefer-github';
  }
  if (opts.ask === true) {
    overrides.conflictPolicy = 'ask';
  }

  return overrides;
}

/** Destination flags accepted by `generate`. */
export interface GenerateTargetFlags {
  github?: boolean;
  local?: boolean;
  both?: boolean;
}

/**
 * Destination the generated Issue is created in, or `undefined` when the user
 * passed no flag (the caller then falls back to `defaultGenerateTarget`).
 *
 * @throws IssueFlagError when more than one destination is requested.
 */
export function resolveGenerateTarget(opts: GenerateTargetFlags): IssueGenerateTarget | undefined {
  const selected: IssueGenerateTarget[] = [];
  if (opts.github === true) selected.push('github');
  if (opts.local === true) selected.push('local');
  if (opts.both === true) selected.push('both');

  if (selected.length > 1) {
    throw new IssueFlagError(
      `${selected.map((target) => `--${target}`).join(', ')} are mutually exclusive; ` +
        'pass only one destination.',
    );
  }

  return selected[0];
}
