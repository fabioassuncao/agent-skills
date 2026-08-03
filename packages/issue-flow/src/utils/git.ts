import { run } from './shell.js';

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
