export {
  type AutoPullResult,
  type AutoRemoveResult,
  type BranchPullRequestStates,
  pullMainBranch,
  runAutoRemove,
} from './gc.js';
export {
  createGitWorktreeGateway,
  filterLiveWorktreeEntries,
  type GitWorktreeEntry,
  type GitWorktreeGateway,
  parseGitWorktreePorcelain,
  removeGitWorktree,
  type WorktreeStatus,
  worktreeAddArgs,
} from './git.js';
export {
  type CreatedWorktree,
  type CreateWorktreeInput,
  createWorktreeManager,
  type ManagedWorktree,
  WorktreeError,
  type WorktreeLifecycleHooks,
  type WorktreeManager,
} from './lifecycle.js';
export {
  buildRuntimeEnvMap,
  createWorktreeMeta,
  renderRuntimeEnv,
  type WorktreeMeta,
  writeRuntimeEnv,
} from './meta.js';
export {
  DEFAULT_WORKTREE_ROOT,
  getWorktreeStoragePaths,
  resolveWorktreePath,
} from './paths.js';
export {
  type WorktreeCreationPhase,
  type WorktreeCreationProgress,
  WorktreeCreationTracker,
  type WorktreeSource,
} from './progress.js';
