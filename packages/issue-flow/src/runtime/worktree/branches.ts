import type { GitWorktreeGateway } from './git.js';

/** Canonical branch choices shared by transports without duplicating git policy. */
export async function listAvailableWorktreeBranches(
  git: GitWorktreeGateway,
  projectRoot: string,
  includeRemote: boolean,
): Promise<string[]> {
  const [local, remote, worktrees] = await Promise.all([
    git.listLocalBranches(projectRoot),
    includeRemote ? git.listRemoteBranches(projectRoot) : Promise.resolve([]),
    git.listWorktrees(projectRoot),
  ]);
  const checkedOut = new Set(
    worktrees.map((entry) => entry.branch).filter((entry): entry is string => entry !== null),
  );
  return [...new Set([...local, ...remote])].filter((name) => !checkedOut.has(name)).sort();
}

export async function listWorktreeBaseBranches(
  git: GitWorktreeGateway,
  projectRoot: string,
): Promise<string[]> {
  return (await git.listLocalBranches(projectRoot)).sort();
}
