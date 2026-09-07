import { mapChecks, summarizeChecks } from './ci.js';
import { ghBounded } from './client.js';
import { type LinkedRepo, repoTargets } from './linked-repos.js';
import type {
  GhPullRequestEntry,
  PullRequestEntry,
  PullRequestState,
  PullRequestStatus,
  PullRequestSummary,
} from './types.js';

/**
 * Pull Request reading — listing, parsing and single-PR status.
 *
 * `PORT` per §20: the WebMux implementation is the more complete one (it knows
 * about drafts, about linked repositories and about the difference between a
 * failed query and an empty answer), so this is the canonical implementation of
 * the responsibility. `core/session-git.ts` and `commands/pr-review.ts`
 * delegate here instead of shelling out to `gh pr list` / `gh pr view`
 * themselves — one responsibility, one implementation.
 *
 * Pull Request *creation* stays where it is (`commands/pr.ts`): §20 makes the
 * Issue Flow canonical there, because WebMux delegates it to the agent and has
 * no deterministic `Closes` / `Refs` body.
 */

/** How many Pull Requests a single `gh pr list` returns. */
export const PR_FETCH_LIMIT = 50;

/** `gh pr list --json` fields the display sync needs. */
const LIST_FIELDS = 'number,headRefName,state,isDraft,updatedAt,statusCheckRollup,url,comments';

export type FetchPullRequestsResult =
  | { ok: true; data: Map<string, PullRequestEntry> }
  | { ok: false; error: string };

/**
 * Parse `gh pr list --json` output into a branch → entry map. Throws on
 * invalid JSON; every caller here turns that into a Result.
 */
export function parsePullRequestList(
  json: string,
  repoLabel?: string,
): Map<string, PullRequestEntry> {
  const prs = new Map<string, PullRequestEntry>();
  const entries = JSON.parse(json) as GhPullRequestEntry[];
  for (const entry of entries) {
    // If multiple Pull Requests share a branch in one repository, the first
    // (most recent) wins.
    if (prs.has(entry.headRefName)) continue;
    prs.set(entry.headRefName, {
      repo: repoLabel ?? '',
      number: entry.number,
      state: entry.state.toLowerCase() as PullRequestState,
      isDraft: entry.isDraft === true,
      url: entry.url,
      updatedAt: entry.updatedAt ?? '',
      ciStatus: summarizeChecks(entry.statusCheckRollup),
      ciChecks: mapChecks(entry.statusCheckRollup),
      comments: (entry.comments ?? []).map((comment) => ({
        type: 'comment' as const,
        author: comment.author?.login ?? 'unknown',
        body: comment.body ?? '',
        createdAt: comment.createdAt ?? '',
      })),
    });
  }
  return prs;
}

/** Parse `gh pr view --json state,isDraft` output. Returns null when unusable. */
export function parsePullRequestStatus(json: string): PullRequestStatus | null {
  try {
    const data = JSON.parse(json) as { state?: unknown; isDraft?: unknown };
    if (typeof data.state !== 'string') return null;
    return {
      state: data.state.toLowerCase() as PullRequestState,
      isDraft: data.isDraft === true,
    };
  } catch {
    return null;
  }
}

export interface FetchPullRequestsOptions {
  /** `owner/repo` of a linked repository; omitted reads the current one. */
  repoSlug?: string;
  /** Alias stamped on every entry, so the UI can say where it came from. */
  repoLabel?: string;
  cwd?: string;
}

/**
 * Fetch every open Pull Request of a repository.
 *
 * Returns a Result: a failed query is *not* an empty list. Reporting `[]` for a
 * network failure is what makes an auto-remove sweep delete a worktree whose
 * Pull Request is merely unreachable, so the distinction is load-bearing.
 */
export async function fetchOpenPullRequests(
  options: FetchPullRequestsOptions = {},
): Promise<FetchPullRequestsResult> {
  const label = options.repoSlug ?? 'current';
  const args = [
    'pr',
    'list',
    '--state',
    'open',
    '--json',
    LIST_FIELDS,
    '--limit',
    String(PR_FETCH_LIMIT),
  ];
  if (options.repoSlug !== undefined) args.push('--repo', options.repoSlug);

  const result = await ghBounded(args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

  // A timeout is reported apart from a plain non-zero exit: the caller needs to
  // tell "GitHub is slow" from "this repository answered with an error".
  if (result.failure?.kind === 'timeout') {
    return { ok: false, error: `gh pr list timed out for ${label}` };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `gh pr list failed for ${label} (exit ${result.exitCode}): ${result.stderr.trim()}`,
    };
  }

  try {
    return { ok: true, data: parsePullRequestList(result.stdout, options.repoLabel) };
  } catch (error) {
    return { ok: false, error: `failed to parse gh output for ${label}: ${String(error)}` };
  }
}

export interface ViewPullRequestOptions {
  cwd?: string;
}

/**
 * `gh pr view <target> --json <fields>`, parsed. `target` is a number, a branch
 * or a URL — whatever `gh` accepts. Returns null when the call fails or the
 * output is not an object, so a caller never has to guard a throw.
 *
 * This is the only `gh pr view` invocation of the project.
 */
export async function viewPullRequest<T>(
  target: string,
  fields: string,
  options: ViewPullRequestOptions = {},
): Promise<T | null> {
  const result = await ghBounded(['pr', 'view', target, '--json', fields], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  if (result.exitCode !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/** Current state of one Pull Request, addressed by number, branch or URL. */
export async function fetchPullRequestStatus(
  target: string,
  options: ViewPullRequestOptions = {},
): Promise<PullRequestStatus | null> {
  const raw = await viewPullRequest<{ state?: unknown; isDraft?: unknown }>(
    target,
    'state,isDraft',
    options,
  );
  return raw === null ? null : parsePullRequestStatus(JSON.stringify(raw));
}

/**
 * Re-read the state of every entry still marked `open`.
 *
 * An entry can be absent from the open-PR list while still open (a failed repo
 * fetch, or `PR_FETCH_LIMIT` truncation), and a draft marked ready in that
 * window would otherwise keep rendering as a draft — which is why `isDraft` is
 * refreshed too, and not only `state`. An entry whose status cannot be read is
 * returned untouched: a failed read is not evidence of a closed Pull Request.
 */
export async function refreshStalePullRequests(
  entries: readonly PullRequestEntry[],
  options: ViewPullRequestOptions = {},
): Promise<PullRequestEntry[]> {
  if (!entries.some((entry) => entry.state === 'open')) return [...entries];

  return Promise.all(
    entries.map(async (entry) => {
      if (entry.state !== 'open') return entry;
      const status = await fetchPullRequestStatus(entry.url, options);
      return status ? { ...entry, ...status } : entry;
    }),
  );
}

export interface ListPullRequestsForBranchOptions {
  /**
   * `all` — the default, and what the session snapshot reports — or `open`,
   * which is the question "is there already a Pull Request I would be
   * duplicating".
   */
  state?: 'all' | 'open';
  cwd?: string;
}

/**
 * List the Pull Requests whose head is `branch`. Never throws; returns `[]`
 * when `gh` is unavailable, unauthenticated or returns bad JSON.
 *
 * The narrow projection (`number,url,title`) is what the session snapshot has
 * always reported; the full display sync uses {@link fetchOpenPullRequests}.
 */
export async function listPullRequestsForBranch(
  branch: string,
  options: ListPullRequestsForBranchOptions = {},
): Promise<PullRequestSummary[]> {
  if (!branch) return [];

  const result = await ghBounded(
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      options.state ?? 'all',
      '--json',
      'number,url,title',
      '--limit',
      '10',
    ],
    { ...(options.cwd === undefined ? {} : { cwd: options.cwd }) },
  );
  if (result.exitCode !== 0) return [];

  try {
    const parsed: unknown = JSON.parse(result.stdout || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (pr): pr is PullRequestSummary =>
          typeof pr === 'object' &&
          pr !== null &&
          typeof (pr as { number?: unknown }).number === 'number' &&
          typeof (pr as { url?: unknown }).url === 'string' &&
          typeof (pr as { title?: unknown }).title === 'string',
      )
      .map((pr) => ({ number: pr.number, url: pr.url, title: pr.title }));
  } catch {
    return [];
  }
}

/**
 * Every branch's Pull Request states across the current repository and all
 * linked repositories — one `gh pr list --state all` per repository.
 *
 * Unlike the display sync (open-only), this sees merged and closed Pull
 * Requests, so a maintenance sweep can detect a merge even when no earlier
 * open-state sync ever recorded the Pull Request.
 *
 * Returns null if **any** repository query failed: a failed query is
 * indistinguishable from "this branch has no Pull Request here", and a caller
 * acting on partial data could drop an open cross-repo Pull Request. Callers
 * must treat null as "skip this sweep".
 */
export async function fetchBranchPullRequestStates(
  linkedRepos: readonly LinkedRepo[] = [],
  options: { cwd?: string } = {},
): Promise<Map<string, BranchPullRequestEvidence[]> | null> {
  const perRepo = await Promise.all(
    repoTargets(linkedRepos).map((target, index) =>
      fetchRepoBranchStates(target.slug, options.cwd, index === 0),
    ),
  );
  if (perRepo.some((entries) => entries === null)) return null;

  const states = new Map<string, BranchPullRequestEvidence[]>();
  for (const entries of perRepo) {
    for (const { branch, ...evidence } of entries ?? []) {
      const existing = states.get(branch) ?? [];
      existing.push(evidence);
      states.set(branch, existing);
    }
  }
  return states;
}

export interface BranchPullRequestEvidence {
  state: PullRequestState;
  /** Commit the Pull Request actually merged from; branch names can be reused. */
  headCommit: string | null;
  /** Only the checkout's own repository can prove the identity of its HEAD. */
  currentRepository: boolean;
}

/**
 * Returns null (not `[]`) on any failure, so the caller can distinguish a
 * failed query from a repository that genuinely has no matching Pull Requests.
 */
async function fetchRepoBranchStates(
  repoSlug: string | undefined,
  cwd: string | undefined,
  currentRepository: boolean,
): Promise<Array<{ branch: string } & BranchPullRequestEvidence> | null> {
  const args = [
    'pr',
    'list',
    '--state',
    'all',
    '--json',
    'headRefName,state,headRefOid',
    // Shares the display-sync limit. On a repository with heavy merged/closed
    // history an older Pull Request for a still-checked-out branch may fall
    // outside the window and never be swept — best effort, but it fails safe
    // (a missed cleanup, never a wrong one).
    '--limit',
    String(PR_FETCH_LIMIT),
  ];
  if (repoSlug !== undefined) args.push('--repo', repoSlug);

  const result = await ghBounded(args, { ...(cwd === undefined ? {} : { cwd }) });
  if (result.exitCode !== 0) return null;

  try {
    const raw = JSON.parse(result.stdout) as Array<{
      headRefName: string;
      state: string;
      headRefOid?: unknown;
    }>;
    return raw.map((row) => ({
      branch: row.headRefName,
      state: row.state.toLowerCase() as PullRequestState,
      headCommit:
        typeof row.headRefOid === 'string' && row.headRefOid !== '' ? row.headRefOid : null,
      currentRepository,
    }));
  } catch {
    return null;
  }
}
