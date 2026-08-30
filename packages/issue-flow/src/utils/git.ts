import { type ExecResult, run } from './shell.js';

/**
 * Get the root directory of the current git repository.
 * Throws if not inside a git repository.
 */
export async function getProjectRoot(): Promise<string> {
  const result = await run('git', ['rev-parse', '--show-toplevel']);

  if (result.exitCode !== 0) {
    throw new Error(
      'Not inside a git repository. Please run issue-flow from within a git project.',
    );
  }

  return result.stdout.trim();
}

/**
 * Get the current git branch name.
 * Returns an empty string if in detached HEAD state.
 */
export async function getCurrentBranch(): Promise<string> {
  const result = await run('git', ['branch', '--show-current']);

  if (result.exitCode !== 0) {
    throw new Error(
      'Failed to detect git branch. Ensure git is installed and you are inside a repository.',
    );
  }

  return result.stdout.trim();
}

export interface CommitInfo {
  hash: string;
  subject: string;
}

/**
 * Get the base branch of the repository: the remote HEAD (origin/HEAD) when
 * available, otherwise the first of main/master that exists locally.
 * Never throws; defaults to 'main'.
 */
export async function getBaseBranch(): Promise<string> {
  const remoteHead = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead.exitCode === 0) {
    const name = remoteHead.stdout.trim().replace(/^origin\//, '');
    if (name) return name;
  }

  for (const candidate of ['main', 'master']) {
    const check = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (check.exitCode === 0) return candidate;
  }

  return 'main';
}

/**
 * Get the URL of the `origin` remote.
 * Never throws: a missing remote, a non-zero exit code, an empty stdout or a
 * git binary that cannot even be spawned all resolve to `null` — the same
 * discipline as {@link getBaseBranch}, so callers can treat "no remote" as an
 * ordinary state instead of an error path.
 *
 * `cwd` selects which repository is queried; omitting it falls back to
 * `process.cwd()`, which is almost never what a caller resolving a specific
 * `projectRoot` wants — pass it explicitly whenever one is available.
 */
export async function getRemoteUrl(cwd?: string): Promise<string | null> {
  let result: ExecResult;
  try {
    result = await run('git', ['remote', 'get-url', 'origin'], { cwd });
  } catch {
    return null;
  }

  if (result.exitCode !== 0) return null;

  const url = result.stdout.trim();
  return url === '' ? null : url;
}

/**
 * Get the abbreviated hash of the current HEAD commit.
 * Never throws, same discipline as {@link getRemoteUrl}: a repository with no
 * commits yet, a non-zero exit code, an empty stdout or a git binary that
 * cannot be spawned all resolve to `null`, so callers can treat "no HEAD" as
 * an ordinary state instead of an error path.
 *
 * `cwd` selects which repository is queried; omitting it falls back to
 * `process.cwd()`.
 */
export async function getHeadCommit(cwd?: string): Promise<string | null> {
  let result: ExecResult;
  try {
    result = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd });
  } catch {
    return null;
  }

  if (result.exitCode !== 0) return null;

  const hash = result.stdout.trim();
  return hash === '' ? null : hash;
}

/**
 * Reduce a git remote URL to a canonical `host/path` identity, so that every
 * way of addressing the same repository collapses to the same string:
 *
 * ```
 * https://github.com/org/repo.git        -> github.com/org/repo
 * git@github.com:org/repo.git            -> github.com/org/repo
 * ssh://git@github.com:22/org/repo.git   -> github.com/org/repo
 * https://user:token@github.com/org/repo -> github.com/org/repo
 * https://github.com/Org/Repo/           -> github.com/org/repo
 * ```
 *
 * Pure function: it never shells out, so it is testable without a git
 * repository. Returns `null` when no host and path can be extracted.
 *
 * Known limitation: both host and path are lowercased. Hostnames are
 * case-insensitive by definition, but repository paths are case-sensitive on
 * some self-hosted servers — so `host/org/Repo` and `host/org/repo` normalize
 * to the same identity even if that server considers them distinct. This is a
 * deliberate trade: matching the same repository across clones (where users
 * routinely type the wrong case) matters more than telling apart two repos
 * whose paths differ only by case.
 */
export function normalizeRemoteUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;

  const trimmed = url.trim();
  if (trimmed === '') return null;

  let authority: string;
  let path: string;

  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(trimmed);
  if (scheme) {
    const rest = trimmed.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    if (slash === -1) return null;
    authority = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  } else {
    // scp-like syntax: [user@]host:path — everything after the first colon is
    // the path, which is how git itself reads it (no port is possible here).
    const colon = trimmed.indexOf(':');
    if (colon === -1) return null;
    authority = trimmed.slice(0, colon);
    path = trimmed.slice(colon + 1);
  }

  // Drop embedded credentials (user, user:token) and the ssh user.
  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = authority.slice(at + 1);

  const host = authority.replace(/:\d+$/, '').toLowerCase();
  if (host === '') return null;

  const normalizedPath = path
    .replace(/[?#].*$/, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (normalizedPath === '') return null;

  return `${host}/${normalizedPath}`;
}

/**
 * Remove Basic-Auth-style credentials (`user:token@`, `user@`) embedded in an
 * `http(s)` remote URL, without touching anything else about it — case, port,
 * the `.git` suffix, query string and trailing slashes are all preserved.
 *
 * Deliberately scoped to `http`/`https`: that is the only place a git remote
 * can carry a real secret (a PAT is routinely embedded as
 * `https://x-access-token:TOKEN@host/...` by CI and automation), and the URL
 * stays a valid, clonable remote once the userinfo is gone. SSH has no
 * equivalent syntax — both `ssh://user@host/path` and the scp-like shorthand
 * `user@host:path` require that user segment to connect at all (it is almost
 * always the fixed, non-secret `git` service account), so this function
 * leaves any other scheme, the scp-like form and local paths untouched.
 *
 * Unlike {@link normalizeRemoteUrl}, which collapses a URL to a lossy
 * `host/path` identity, this keeps the URL "as configured" — it exists for
 * surfaces (like the web monitor's `repository.remoteUrl`) that want to show
 * the real remote, minus whatever secret an HTTPS token commonly embeds in
 * it.
 *
 * Pure function, never throws. Returns `null` for a nullish or empty input.
 */
export function stripRemoteUrlCredentials(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;

  const trimmed = url.trim();
  if (trimmed === '') return null;

  const httpScheme = /^https?:\/\//i.exec(trimmed);
  if (!httpScheme) return trimmed;

  const rest = trimmed.slice(httpScheme[0].length);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const remainder = slash === -1 ? '' : rest.slice(slash);

  const at = authority.lastIndexOf('@');
  if (at === -1) return trimmed;
  return `${httpScheme[0]}${authority.slice(at + 1)}${remainder}`;
}

/**
 * List commits on HEAD that are not on the given base branch (base..HEAD),
 * most recent first. Never throws; returns [] when the range cannot be
 * resolved (e.g. unknown base branch or shallow clone).
 */
export async function getCommitsSince(base: string): Promise<CommitInfo[]> {
  const result = await run('git', ['log', '--pretty=format:%h%x09%s', `${base}..HEAD`]);
  if (result.exitCode !== 0) return [];

  return result.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const tab = line.indexOf('\t');
      return tab === -1
        ? { hash: line.trim(), subject: '' }
        : { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}

/* ── repository preflight ───────────────────────────────────────────────── */

/**
 * A repository state that stops the pipeline.
 *
 * The whole point of this type is that it is *reported*, never acted on: the
 * second explicit limit of the resilience Epic is that **no destructive
 * operation is ever run automatically to fix state**. A repository mid-rebase
 * is a person's unfinished work, and an `--abort` issued by a tool at 3am is
 * indistinguishable from data loss.
 */
export type PreflightBlockKind =
  | 'rebase_in_progress'
  | 'merge_in_progress'
  | 'cherry_pick_in_progress'
  | 'revert_in_progress'
  | 'unmerged_paths'
  | 'detached_head'
  | 'branch_mismatch'
  | 'dirty_tree';

export interface PreflightBlock {
  kind: PreflightBlockKind;
  /** What is wrong, in one line. */
  message: string;
  /** The command a human would run. Printed, never executed. */
  suggestion: string;
}

export interface PreflightResult {
  ok: boolean;
  blocks: PreflightBlock[];
  /** Current branch, or `null` on a detached HEAD. */
  branch: string | null;
  /** Whether the working tree has uncommitted changes. */
  dirty: boolean;
}

/** What the caller is about to do, which decides how a dirty tree is read. */
export type PreflightIntent =
  | /** Continuing the phase that produced the changes. */ 'resume-same-phase'
  | /** Starting a different phase, or a different issue. */ 'new-phase';

export interface PreflightOptions {
  /** Branch the plan says this work belongs to. `null` skips the check. */
  expectedBranch?: string | null;
  /** Default `new-phase`, the strict reading. */
  intent?: PreflightIntent;
  cwd?: string;
}

/** `git rev-parse --verify --quiet <ref>` — exit 0 means the ref exists. */
async function refExists(ref: string, cwd?: string): Promise<boolean> {
  const result = await run('git', ['rev-parse', '--verify', '--quiet', ref], {
    ...(cwd === undefined ? {} : { cwd }),
  });
  return result.exitCode === 0;
}

/** The in-progress sequencer operations, by the ref each one leaves behind. */
const SEQUENCER_REFS: readonly {
  ref: string;
  kind: PreflightBlockKind;
  name: string;
  suggestion: string;
}[] = [
  {
    ref: 'REBASE_HEAD',
    kind: 'rebase_in_progress',
    name: 'a rebase',
    suggestion: 'git rebase --continue (or git rebase --abort)',
  },
  {
    ref: 'MERGE_HEAD',
    kind: 'merge_in_progress',
    name: 'a merge',
    suggestion: 'git merge --continue (or git merge --abort)',
  },
  {
    ref: 'CHERRY_PICK_HEAD',
    kind: 'cherry_pick_in_progress',
    name: 'a cherry-pick',
    suggestion: 'git cherry-pick --continue (or git cherry-pick --abort)',
  },
  {
    ref: 'REVERT_HEAD',
    kind: 'revert_in_progress',
    name: 'a revert',
    suggestion: 'git revert --continue (or git revert --abort)',
  },
];

/**
 * Describe the repository and decide whether it is safe to write to it.
 *
 * Every check is a *read*: `rev-parse`, `symbolic-ref`, `diff --name-only`,
 * `status --porcelain`, `branch --show-current`. Nothing here checks anything
 * out, resets anything, aborts anything or stashes anything — not on a resume,
 * not under a continuous profile, not ever. A repository in an ambiguous state
 * escalates to a human, which is the only correct answer for a tool that did
 * not put it there.
 *
 * A **dirty tree is not always a problem**: resuming the phase that produced
 * those changes is exactly the case where uncommitted work is expected. It
 * blocks only when the run is about to move on to something else, where the
 * changes would be carried into work they do not belong to.
 */
export async function preflightRepository(
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const { cwd, expectedBranch, intent = 'new-phase' } = options;
  const at = cwd === undefined ? {} : { cwd };
  const blocks: PreflightBlock[] = [];

  for (const sequencer of SEQUENCER_REFS) {
    if (await refExists(sequencer.ref, cwd)) {
      blocks.push({
        kind: sequencer.kind,
        message: `The repository is in the middle of ${sequencer.name} (${sequencer.ref} is present).`,
        suggestion: sequencer.suggestion,
      });
    }
  }

  const unmerged = await run('git', ['diff', '--name-only', '--diff-filter=U'], at);
  const conflicted = unmerged.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (conflicted.length > 0) {
    blocks.push({
      kind: 'unmerged_paths',
      message: `${conflicted.length} file(s) still have unresolved conflicts: ${conflicted.slice(0, 5).join(', ')}${conflicted.length > 5 ? ', …' : ''}.`,
      suggestion: 'Resolve them, then git add the files',
    });
  }

  // `symbolic-ref -q HEAD` fails on a detached HEAD, which is the whole test.
  const symbolic = await run('git', ['symbolic-ref', '-q', 'HEAD'], at);
  const detached = symbolic.exitCode !== 0;
  const branch = detached ? null : symbolic.stdout.trim().replace(/^refs\/heads\//, '');

  if (detached) {
    blocks.push({
      kind: 'detached_head',
      message: 'HEAD is detached, so a commit would belong to no branch.',
      suggestion: `git switch ${expectedBranch ?? '<branch>'}`,
    });
  } else if (
    expectedBranch !== undefined &&
    expectedBranch !== null &&
    expectedBranch !== '' &&
    branch !== expectedBranch
  ) {
    blocks.push({
      kind: 'branch_mismatch',
      message: `The plan works on '${expectedBranch}' but the repository is on '${branch}'.`,
      suggestion: `git switch ${expectedBranch}`,
    });
  }

  const status = await run('git', ['status', '--porcelain'], at);
  const dirty = status.stdout.trim() !== '';
  if (dirty && intent !== 'resume-same-phase') {
    blocks.push({
      kind: 'dirty_tree',
      message: 'The working tree has uncommitted changes that do not belong to this phase.',
      suggestion: 'Commit or stash them yourself, then run again',
    });
  }

  return { ok: blocks.length === 0, blocks, branch, dirty };
}

/** The report a caller prints when the preflight blocks. Never a fix. */
export function describePreflight(result: PreflightResult): string[] {
  return result.blocks.map((block) => `${block.message} Suggested: ${block.suggestion}`);
}
