import type { LabelDefinition } from '../policy/types.js';
import { run } from '../utils/shell.js';

/**
 * Reconciling the labels an agent suggested with the ones the repository
 * actually has.
 *
 * A workflow tool has no business changing a repository's taxonomy. Labels are
 * governance: a team that deleted `high`/`medium`/`low` in favour of a native
 * priority field, or `bug`/`enhancement` in favour of Issue Types, made a
 * decision — and a generator that silently recreates them undoes it, quietly and
 * repository-wide.
 *
 * So the default is to **validate, never create**. `policy.issues.allowLabelCreation`
 * restores the old behaviour for repositories that want it.
 */

export interface LabelReconciliation {
  /** Labels to apply, in the repository's own casing. */
  labels: string[];
  /** Suggested labels the repository does not have. */
  missing: string[];
}

/**
 * Intersect the suggested labels with the repository's real ones.
 *
 * Matching is case-insensitive and the result carries the **repository's**
 * casing: `gh issue create --label Bug` fails on a repository whose label is
 * `bug`, and an agent has no way to know which one it is.
 *
 * An empty `known` means the labels could not be read at all — no policy, no
 * `gh`, no network. That is not evidence the labels do not exist, so the
 * suggestions pass through untouched and the behaviour is the one that shipped
 * before this layer. Refusing to label an issue because discovery was offline
 * would be the wrong failure.
 */
export function reconcileLabels(
  suggested: string[],
  known: LabelDefinition[],
): LabelReconciliation {
  if (known.length === 0) {
    return { labels: [...suggested], missing: [] };
  }

  const canonical = new Map(known.map((label) => [label.name.toLowerCase(), label.name]));

  const labels: string[] = [];
  const missing: string[] = [];
  for (const suggestion of suggested) {
    const match = canonical.get(suggestion.trim().toLowerCase());
    if (match === undefined) {
      if (!missing.includes(suggestion)) missing.push(suggestion);
      continue;
    }
    if (!labels.includes(match)) labels.push(match);
  }

  return { labels, missing };
}

/**
 * Create the labels the repository is missing, for
 * `policy.issues.allowLabelCreation: true`.
 *
 * Best-effort per label: one that cannot be created is reported and skipped, so
 * a single failure does not cost the Issue. Returns the labels that now exist.
 */
export async function createMissingLabels(
  names: string[],
  warn: (message: string) => void,
): Promise<string[]> {
  const created: string[] = [];

  for (const name of names) {
    const result = await run('gh', ['label', 'create', name]);
    if (result.exitCode === 0) {
      created.push(name);
      continue;
    }
    // gh answers "already exists" when a label was created between the
    // discovery and now, which is a success for our purposes.
    const detail = (result.stderr || result.stdout).trim();
    if (/already exists/i.test(detail)) {
      created.push(name);
      continue;
    }
    warn(`Could not create label "${name}": ${detail || 'gh label create failed'}`);
  }

  return created;
}
