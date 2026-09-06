import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Where a worktree and its runtime artifacts live.
 *
 * Ported from the path helpers of WebMux `backend/src/adapters/fs.ts` @ d8c9d5f,
 * with the directory renamed and one behaviour kept exactly: everything a
 * worktree accumulates lives under the **git directory**, never in the working
 * tree. That is what makes it impossible to commit execution state (invariant
 * 17), and it is also why the same directory already holds the agent hooks.
 */

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

/**
 * Path of the worktree for a branch.
 *
 * A branch name may contain slashes (`feat/63-thing`), which nest directories
 * under the container. That is the upstream's behaviour and it is deliberate:
 * the path stays a readable mirror of the branch instead of a flattened,
 * ambiguous slug.
 */
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
