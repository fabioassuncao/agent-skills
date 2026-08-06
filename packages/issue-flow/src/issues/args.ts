/**
 * Parsing of the issue identifiers a command receives on the command line.
 *
 * `run` accepts both spellings of the same list — `42,43,50` and `42 43 50` —
 * because both are what a user naturally types, and commander gives them to us
 * as different shapes (one argument with commas, or several arguments). Normal-
 * izing here keeps every downstream layer working on a plain `string[]`.
 */

/** Malformed issue arguments, reported as a CLI error. */
export class IssueArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueArgumentError';
  }
}

/**
 * Rejected before an identifier ever becomes a path segment or an API call.
 * Mirrors `normalizeIssueNumber` in `storage/paths.ts`: the storage layer would
 * refuse these anyway, and failing here names the offending argument instead.
 */
const INVALID_ID = /[/\\\s]/;

/**
 * Normalize the positional arguments of `run` into a list of issue identifiers.
 *
 * - splits on commas, so `42,43` and `42 43` produce the same list;
 * - strips a leading `#` and surrounding whitespace;
 * - preserves the order the user typed, which is what a tie-break falls back to;
 * - drops exact duplicates silently (`42 42` is a typo with an obvious intent),
 *   but rejects an empty or malformed identifier, which is not.
 *
 * @throws IssueArgumentError when no identifier survives or one is malformed.
 */
export function parseIssueArguments(values: readonly string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    for (const raw of value.split(',')) {
      const id = raw.trim().replace(/^#/, '').trim();
      if (id === '') {
        // An empty slot is always a typo: `42,,43` or a stray comma.
        if (raw.trim() !== '' || value.includes(',')) {
          throw new IssueArgumentError(
            `Invalid issue list '${value}': it has an empty entry. Use '42,43' or '42 43'.`,
          );
        }
        continue;
      }
      if (INVALID_ID.test(id) || id === '.' || id === '..') {
        throw new IssueArgumentError(`Invalid issue identifier '${raw.trim()}'.`);
      }
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }

  if (ids.length === 0) {
    throw new IssueArgumentError('No issue was informed. Pass at least one issue number.');
  }

  return ids;
}
