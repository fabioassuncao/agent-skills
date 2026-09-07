import type { GitWorktreeGateway } from './git.js';
import type { ManagedWorktree, WorktreeManager } from './lifecycle.js';

/** Merge evidence of one branch across every repository that has a pull request for it. */
export interface BranchPullRequestEvidence {
  state: string;
  headCommit: string | null;
  currentRepository: boolean;
}
export type BranchPullRequestStates = Map<string, BranchPullRequestEvidence[]>;

export type AutoRemoveCandidateResult =
  | 'removed'
  | 'dirty'
  | 'not-merged'
  | 'no-pull-request'
  | 'busy'
  | 'identity-changed'
  | 'head-mismatch'
  | 'inconclusive';

export interface AutoRemoveDependencies {
  worktrees: WorktreeManager;
  git: GitWorktreeGateway;
  projectRoot: string;
  /**
   * Authoritative pull request state per branch.
   *
   * Queried live rather than read from a cache, so a merge is detected even
   * when no display sync ever ran. Returning `null` means the query was
   * **inconclusive** — a repository failed to answer — and the sweep then does
   * nothing at all: removing on partial state could drop a worktree whose
   * cross-repository pull request is still open.
   */
  branchPullRequestStates: () => Promise<BranchPullRequestStates | null>;
  /** Locked destructive gate supplied by the canonical session/worktree operation. */
  removeCandidate: (worktree: ManagedWorktree) => Promise<AutoRemoveCandidateResult>;
  /** Branches a removal is already running for, so a sweep never races itself. */
  isRemoving?: (branch: string) => boolean;
  markRemoving?: (branch: string) => void;
  unmarkRemoving?: (branch: string) => void;
  onInfo?: (message: string) => void;
  onError?: (message: string) => void;
}

export interface AutoRemoveResult {
  removed: string[];
  /** Branches examined and deliberately left alone, with the reason. */
  skipped: Array<{ branch: string; reason: Exclude<AutoRemoveCandidateResult, 'removed'> }>;
  /** True when the pull request query was inconclusive and nothing was attempted. */
  inconclusive: boolean;
}

/** Remove every worktree whose pull requests are all merged and whose tree is clean. */
export async function runAutoRemove(deps: AutoRemoveDependencies): Promise<AutoRemoveResult> {
  const result: AutoRemoveResult = { removed: [], skipped: [], inconclusive: false };
  const managed = (await deps.worktrees.list()).filter(
    (entry) => entry.state === 'managed' && entry.entry !== null && entry.binding !== null,
  );
  if (managed.length === 0) return result;

  const states = await deps.branchPullRequestStates();
  if (states === null) {
    result.inconclusive = true;
    return result;
  }

  for (const worktree of managed) {
    const branch = worktree.branch;
    if (deps.isRemoving?.(branch) === true) {
      result.skipped.push({ branch, reason: 'busy' });
      continue;
    }

    const branchStates = states.get(branch);
    if (branchStates === undefined || branchStates.length === 0) {
      result.skipped.push({ branch, reason: 'no-pull-request' });
      continue;
    }
    if (!branchStates.every((evidence) => evidence.state === 'merged')) {
      result.skipped.push({ branch, reason: 'not-merged' });
      continue;
    }

    deps.markRemoving?.(branch);
    try {
      const decision = await deps.removeCandidate(worktree);
      if (decision === 'removed') {
        result.removed.push(branch);
        deps.onInfo?.(`Removed merged worktree: ${branch}`);
      } else {
        result.skipped.push({ branch, reason: decision });
        if (decision === 'dirty') deps.onInfo?.(`Skipping dirty worktree: ${branch}`);
      }
    } catch (error) {
      deps.onError?.(
        `Failed to remove worktree ${branch}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      deps.unmarkRemoving?.(branch);
    }
  }

  return result;
}

export type AutoPullResult =
  | { status: 'updated'; from: string; to: string }
  | { status: 'already_up_to_date' }
  | { status: 'fetch_failed'; error: string }
  | { status: 'merge_failed'; error: string };

export interface AutoPullDependencies {
  git: GitWorktreeGateway;
  projectRoot: string;
  mainBranch: string;
}

export async function pullMainBranch(deps: AutoPullDependencies): Promise<AutoPullResult> {
  const before = (await deps.git.readWorktreeStatus(deps.projectRoot)).currentCommit;

  const fetched = await deps.git.fetchBranch(deps.projectRoot, 'origin', deps.mainBranch);
  if (!fetched.ok) return { status: 'fetch_failed', error: fetched.stderr };

  const merged = await deps.git.fastForwardMerge(deps.projectRoot, `origin/${deps.mainBranch}`);
  if (!merged.ok) return { status: 'merge_failed', error: merged.stderr };

  const after = (await deps.git.readWorktreeStatus(deps.projectRoot)).currentCommit;
  if (before === after) return { status: 'already_up_to_date' };
  return { status: 'updated', from: before ?? 'unknown', to: after ?? 'unknown' };
}
