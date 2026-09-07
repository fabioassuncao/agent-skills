import type { PullRequestEntry } from './types.js';

export interface LinkedRepo {
  /** `owner/name` as `gh --repo` expects it. */
  repo: string;
  /** Short label shown next to a Pull Request from this repository. */
  alias: string;
  /** Optional local checkout, for a caller that needs the working copy. */
  dir?: string;
}

/**
 * One repository to query: the current one (no slug, no label) followed by each
 * linked repository. The current repository comes first so its Pull Requests
 * win the first-wins rule of `parsePullRequestList` when a branch exists in
 * more than one repository.
 */
export interface RepoTarget {
  /** `undefined` means "the repository of the working directory". */
  slug?: string;
  /** `undefined` means the current repository, which carries no alias. */
  label?: string;
}

export function repoTargets(linkedRepos: readonly LinkedRepo[]): RepoTarget[] {
  return [{}, ...linkedRepos.map(({ repo, alias }) => ({ slug: repo, label: alias }))];
}

/**
 * The `owner/repo` slug an entry came from, or `undefined` for the current
 * repository. An entry carries the *alias*, so the slug needs the lookup.
 */
export function repoSlugForEntry(
  entry: Pick<PullRequestEntry, 'repo'>,
  linkedRepos: readonly LinkedRepo[],
): string | undefined {
  if (entry.repo === '') return undefined;
  return linkedRepos.find((linked) => linked.alias === entry.repo)?.repo;
}
