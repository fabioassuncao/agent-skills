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
