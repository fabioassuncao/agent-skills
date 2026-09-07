import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Default location of the worktree container, relative to the repository. */
export const DEFAULT_WORKTREE_ROOT = '../worktrees';

/** Directory, inside a worktree's git dir, holding its runtime artifacts. */
export const WORKTREE_ARTIFACTS_DIRNAME = 'issue-flow';

export interface WorktreeStoragePaths {
  gitDir: string;
  artifactsDir: string;
  /** Shell-consumable environment, written for hooks and panes. */
  runtimeEnvPath: string;
}

export function resolveWorktreePath(
  projectRoot: string,
  worktreeRoot: string,
  branch: string,
): string {
  return resolve(projectRoot, worktreeRoot, branch);
}

export function getWorktreeStoragePaths(gitDir: string): WorktreeStoragePaths {
  const artifactsDir = join(gitDir, WORKTREE_ARTIFACTS_DIRNAME);
  return { gitDir, artifactsDir, runtimeEnvPath: join(artifactsDir, 'runtime.env') };
}

export async function ensureWorktreeStorageDirs(gitDir: string): Promise<WorktreeStoragePaths> {
  const paths = getWorktreeStoragePaths(gitDir);
  await mkdir(paths.artifactsDir, { recursive: true });
  return paths;
}
