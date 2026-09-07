import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
// The single validator for what git accepts as a ref name. Keeping a second
// opinion here is how a name passes one check and fails the other halfway
// through creating a worktree (invariant 13).
import { isValidBranchName } from '../../conventions/git/slug.js';
import {
  deleteWorktree as deleteStoredWorktree,
  listWorktrees as listStoredWorktrees,
  loadWorktree as loadStoredWorktree,
  type PlanRepositoryContext,
  type StoredWorktree,
  saveWorktree,
} from '../../storage/db/repository.js';
import {
  type CreateWorktreeMode,
  createGitWorktreeGateway,
  type GitWorktreeEntry,
  type GitWorktreeGateway,
} from './git.js';
import { withWorktreeBranchLock } from './lock.js';
import {
  buildRuntimeEnvMap,
  createWorktreeMeta,
  type WorktreeMeta,
  type WorktreeRuntimeKind,
  writeRuntimeEnv,
} from './meta.js';
import { DEFAULT_WORKTREE_ROOT, resolveWorktreePath } from './paths.js';
import {
  type WorktreeCreationProgress,
  WorktreeCreationTracker,
  type WorktreeSource,
} from './progress.js';

/**
 * Create, remove and merge managed worktrees.
 *
 * Ported from WebMux `backend/src/services/lifecycle-service.ts` @ d8c9d5f
 * (1.523 LOC), narrowed to what a worktree *is*: the checkout, its branch, its
 * durable binding and its rollback. Everything the upstream folds into the same
 * class but that belongs to another responsibility — tmux windows, containers,
 * port allocation, profiles — enters through the extension points below, and
 * the phases that own those fill them in. Half-porting them here would have
 * produced a second, weaker implementation of each.
 *
 * ADR-08 is the rule that shapes `list()`: git is the authority on which
 * worktrees exist, the database on what each is bound to. A binding whose
 * directory git no longer lists is reported as `orphaned` — never recreated,
 * never silently deleted.
 */

/** Failures a caller is expected to distinguish, carrying the upstream's status codes. */
export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

/**
 * What another phase contributes to a worktree's life.
 *
 * Every hook is optional and every one of them is allowed to fail: a worktree
 * that exists with no tmux window is a degraded worktree, not a failed
 * creation. Their errors are collected into the rollback report rather than
 * replacing the original cause.
 */
export interface WorktreeLifecycleHooks {
  /** Run after the checkout exists and before the runtime is prepared. */
  postCreate?: (input: { meta: WorktreeMeta; worktreePath: string }) => Promise<void> | void;
  /** Run before anything is removed, while the directory still exists. */
  preRemove?: (input: {
    binding: StoredWorktree | null;
    worktreePath: string;
  }) => Promise<void> | void;
  /** Tear down whatever the runtime phases attached to this branch. */
  disposeRuntime?: (input: {
    branch: string;
    runtime: WorktreeRuntimeKind;
  }) => Promise<void> | void;
}

export interface WorktreeManagerOptions {
  projectRoot: string;
  /** Persistence context. Absent means "do not persist" — used by tests and dry runs. */
  storage?: PlanRepositoryContext;
  /** Container of worktrees, relative to the repository. Default `../worktrees`. */
  worktreeRoot?: string;
  /** Branch worktrees are cut from and merged into. */
  mainBranch: string;
  git?: GitWorktreeGateway;
  hooks?: WorktreeLifecycleHooks;
  tracker?: WorktreeCreationTracker;
  /** Durable lock directory shared by the monitor and direct CLI processes. */
  mutationLockDir?: string;
  onProgress?: (progress: WorktreeCreationProgress) => void;
}

export interface CreateWorktreeInput {
  branch: string;
  mode?: CreateWorktreeMode;
  baseBranch?: string;
  agent: string;
  profile?: string;
  runtime?: WorktreeRuntimeKind;
  startupEnvValues?: Record<string, string>;
  allocatedPorts?: Record<string, number>;
  source?: WorktreeSource;
}

export interface CreatedWorktree {
  branch: string;
  worktreeId: string;
  path: string;
  meta: WorktreeMeta;
  runtimeEnvPath: string;
  /** Whether this operation created the local branch and therefore owns deleting it on rollback. */
  branchCreated?: boolean;
}

/** A worktree as it actually is: what git sees, plus what the database bound to it. */
export interface ManagedWorktree {
  branch: string;
  path: string;
  entry: GitWorktreeEntry | null;
  binding: StoredWorktree | null;
  /** `orphaned` when the database has a binding git no longer backs. */
  state: 'managed' | 'unmanaged' | 'orphaned';
}

interface BranchAvailability {
  startPoint?: string;
  /** Whether a rollback should also delete the branch it created. */
  deleteBranchOnRollback: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wrap(error: unknown): WorktreeError {
  return error instanceof WorktreeError ? error : new WorktreeError(message(error), 500);
}

export function createWorktreeManager(options: WorktreeManagerOptions) {
  const git = options.git ?? createGitWorktreeGateway();
  const projectRoot = resolve(options.projectRoot);
  const worktreeRoot = options.worktreeRoot ?? DEFAULT_WORKTREE_ROOT;
  const tracker = options.tracker ?? new WorktreeCreationTracker();
  const hooks = options.hooks ?? {};
  const lockProjectId = options.storage?.projectId ?? projectRoot;

  function withMutationLock<T>(branch: string, operation: () => Promise<T>): Promise<T> {
    return withWorktreeBranchLock(lockProjectId, branch, operation, {
      lockDir: options.mutationLockDir,
    });
  }

  function pathFor(branch: string): string {
    return resolveWorktreePath(projectRoot, worktreeRoot, branch);
  }

  /**
   * The repository root **as git reports it**, resolved once.
   *
   * `resolve()` on the configured root is not enough to recognise the
   * repository's own entry in `worktree list`: on macOS the temporary and home
   * directories are symlinks, so git answers `/private/var/…` where the caller
   * passed `/var/…`. Comparing the two strings then fails to match, and the
   * repository itself shows up as one more managed worktree. Falls back to the
   * configured path when git cannot answer — a repository that cannot be
   * queried has bigger problems than this comparison.
   */
  let canonicalRootPromise: Promise<string> | null = null;
  function canonicalRoot(): Promise<string> {
    canonicalRootPromise ??= git.resolveWorktreeRoot(projectRoot).catch(() => projectRoot);
    return canonicalRootPromise;
  }

  function report(progress: WorktreeCreationProgress): void {
    tracker.set(progress);
    options.onProgress?.(progress);
  }

  /**
   * Decide whether the branch can be used, and what a rollback owes.
   *
   * The checked-out set comes from the **raw** worktree list, not the live one.
   * A stale registration — a directory deleted by hand that git has not pruned
   * — still holds its branch in git's view, so it must keep blocking reuse.
   * Filtering it out here would report the branch as free and then fail at
   * `worktree add` with a much worse message.
   */
  async function resolveBranchAvailability(
    branch: string,
    mode: CreateWorktreeMode,
  ): Promise<BranchAvailability> {
    const localBranches = new Set(await git.listLocalBranches(projectRoot));
    if (mode === 'new') {
      if (localBranches.has(branch)) {
        throw new WorktreeError(`Branch already exists: ${branch}`, 409);
      }
      return { deleteBranchOnRollback: false };
    }

    if (localBranches.has(branch)) {
      const checkedOut = new Set(
        (await git.listWorktrees(projectRoot))
          .map((entry) => entry.branch)
          .filter((name): name is string => name !== null),
      );
      if (checkedOut.has(branch)) {
        throw new WorktreeError(`Branch already has a worktree: ${branch}`, 409);
      }
      return { deleteBranchOnRollback: false };
    }

    const remoteBranches = new Set(await git.listRemoteBranches(projectRoot));
    if (!remoteBranches.has(branch)) {
      throw new WorktreeError(`Branch not found: ${branch}`, 404);
    }
    // Created locally from the remote, so a rollback must delete it again —
    // otherwise a failed creation leaves behind a branch nobody asked for.
    return { startPoint: `origin/${branch}`, deleteBranchOnRollback: true };
  }

  /**
   * Undo a failed creation.
   *
   * Every step is attempted even when an earlier one failed, and the errors are
   * concatenated onto the original cause instead of replacing it: the reason
   * creation failed is what the user needs to read, and a cleanup failure on
   * top of it is context, not a new headline.
   */
  async function cleanupFailedCreate(
    branch: string,
    worktreePath: string,
    runtime: WorktreeRuntimeKind,
    deleteBranch: boolean,
  ): Promise<string | null> {
    const errors: string[] = [];

    try {
      await hooks.disposeRuntime?.({ branch, runtime });
    } catch (error) {
      errors.push(`runtime cleanup failed: ${message(error)}`);
    }

    try {
      await git.removeWorktree({ repoRoot: projectRoot, worktreePath, force: true });
    } catch (error) {
      errors.push(`worktree cleanup failed: ${message(error)}`);
    }

    if (deleteBranch) {
      try {
        await git.deleteBranch(projectRoot, branch, true);
      } catch (error) {
        errors.push(`branch cleanup failed: ${message(error)}`);
      }
    }

    if (options.storage !== undefined) {
      try {
        await deleteStoredWorktree(options.storage, branch);
      } catch (error) {
        errors.push(`binding cleanup failed: ${message(error)}`);
      }
    }

    return errors.length > 0 ? errors.join('; ') : null;
  }

  function toStored(meta: WorktreeMeta, worktreePath: string): StoredWorktree {
    return {
      worktreeId: meta.worktreeId,
      branch: meta.branch,
      path: worktreePath,
      baseBranch: meta.baseBranch ?? null,
      label: meta.label ?? null,
      profile: meta.profile,
      agent: meta.agent,
      runtime: meta.runtime,
      startupEnvValues: meta.startupEnvValues,
      allocatedPorts: meta.allocatedPorts,
      source: meta.source ?? null,
      conversationId: meta.conversationId ?? null,
      archived: false,
      createdAt: meta.createdAt,
      updatedAt: meta.createdAt,
    };
  }

  async function createUnlocked(input: CreateWorktreeInput): Promise<CreatedWorktree> {
    const mode = input.mode ?? 'new';
    const branch = input.branch.trim();
    if (!isValidBranchName(branch)) throw new WorktreeError('Invalid branch name', 400);

    const requestedBase = input.baseBranch?.trim();
    const hasRequestedBase = requestedBase !== undefined && requestedBase !== '';
    if (hasRequestedBase) {
      if (!isValidBranchName(requestedBase)) {
        throw new WorktreeError('Invalid base branch name', 400);
      }
      if (mode === 'existing') {
        throw new WorktreeError('Base branch is only supported for new worktrees', 400);
      }
      if (requestedBase === branch) {
        throw new WorktreeError('Base branch must differ from branch name', 400);
      }
    }

    // One creation per branch at a time. Two concurrent `worktree add` calls
    // for the same branch race into a half-created checkout that neither
    // rollback owns.
    if (tracker.has(branch)) {
      throw new WorktreeError(`Worktree is already being created: ${branch}`, 409);
    }

    const baseBranch =
      mode === 'new' ? (hasRequestedBase ? requestedBase : options.mainBranch) : undefined;
    const availability = await resolveBranchAvailability(branch, mode);
    const worktreePath = pathFor(branch);
    const source = input.source ?? 'cli';
    const runtime = input.runtime ?? 'host';
    const deleteBranchOnRollback = mode === 'new' || availability.deleteBranchOnRollback;

    const progressBase = {
      branch,
      ...(baseBranch === undefined ? {} : { baseBranch }),
      path: worktreePath,
      source,
    };

    let created = false;
    try {
      report({ ...progressBase, phase: 'creating_worktree' });
      // The container may not exist yet, and `git worktree add` does not create
      // the intermediate directories a branch name with slashes implies.
      await mkdir(dirname(worktreePath), { recursive: true });

      await git.createWorktree(
        mode === 'new'
          ? {
              mode: 'new',
              repoRoot: projectRoot,
              worktreePath,
              branch,
              ...(baseBranch === undefined ? {} : { baseBranch }),
            }
          : {
              mode: 'existing',
              repoRoot: projectRoot,
              worktreePath,
              branch,
              ...(availability.startPoint === undefined
                ? {}
                : { startPoint: availability.startPoint }),
            },
      );
      created = true;

      const meta = createWorktreeMeta({
        branch,
        baseBranch: baseBranch ?? null,
        agent: input.agent,
        ...(input.profile === undefined ? {} : { profile: input.profile }),
        runtime,
        ...(input.startupEnvValues === undefined
          ? {}
          : { startupEnvValues: input.startupEnvValues }),
        ...(input.allocatedPorts === undefined ? {} : { allocatedPorts: input.allocatedPorts }),
        source,
      });

      const gitDir = await git.resolveWorktreeGitDir(worktreePath);
      const runtimeEnvPath = await writeRuntimeEnv(gitDir, buildRuntimeEnvMap(meta, worktreePath));

      if (options.storage !== undefined) {
        await saveWorktree(options.storage, toStored(meta, worktreePath));
      }

      report({ ...progressBase, phase: 'running_post_create_hook' });
      await hooks.postCreate?.({ meta, worktreePath });

      report({ ...progressBase, phase: 'preparing_runtime' });
      return {
        branch,
        worktreeId: meta.worktreeId,
        path: worktreePath,
        meta,
        runtimeEnvPath,
        branchCreated: deleteBranchOnRollback,
      };
    } catch (error) {
      if (created) {
        const cleanupError = await cleanupFailedCreate(
          branch,
          worktreePath,
          runtime,
          deleteBranchOnRollback,
        );
        if (cleanupError !== null) {
          throw wrap(new Error(`${message(error)}; ${cleanupError}`));
        }
      }
      throw wrap(error);
    } finally {
      tracker.clear(branch);
    }
  }

  /** Resolve a branch to the worktree git actually has for it. */
  async function resolveExisting(branch: string): Promise<GitWorktreeEntry> {
    const entries = await git.listLiveWorktrees(projectRoot);
    const entry = entries.find((candidate) => candidate.branch === branch);
    if (entry === undefined) throw new WorktreeError(`Worktree not found: ${branch}`, 404);
    return entry;
  }

  /**
   * Remove a worktree, and by default the branch with it.
   *
   * `keepBranch` exists for the runtime's `dispose()`, which is asked to free
   * the checkout without discarding the work: the branch is the only thing that
   * still holds the commits once the directory is gone, so deleting it there
   * would destroy exactly what the caller asked to keep. The default stays
   * "delete", which is what every existing caller means and what the upstream
   * does.
   */
  async function removeUnlocked(
    branch: string,
    opts: { force?: boolean; keepBranch?: boolean } = {},
  ): Promise<void> {
    try {
      const entry = await resolveExisting(branch);
      const binding =
        options.storage === undefined ? null : await loadStoredWorktree(options.storage, branch);

      await hooks.preRemove?.({ binding, worktreePath: entry.path });
      await hooks.disposeRuntime?.({ branch, runtime: binding?.runtime ?? 'host' });

      await git.removeWorktree({
        repoRoot: projectRoot,
        worktreePath: entry.path,
        force: opts.force ?? true,
      });
      if (opts.keepBranch !== true) await git.deleteBranch(projectRoot, branch, true);
      if (options.storage !== undefined) await deleteStoredWorktree(options.storage, branch);
    } catch (error) {
      throw wrap(error);
    }
  }

  /**
   * Merge a worktree's branch into the main one and remove it.
   *
   * The dirty check comes first and is not a warning: merging a branch whose
   * worktree still holds uncommitted work would silently leave that work in a
   * directory this method then deletes.
   */
  async function mergeUnlocked(branch: string): Promise<void> {
    try {
      const entry = await resolveExisting(branch);
      const status = await git.readWorktreeStatus(entry.path);
      if (status.dirty) {
        throw new WorktreeError(`Worktree has uncommitted changes: ${branch}`, 409);
      }

      await git.mergeBranch({
        repoRoot: projectRoot,
        sourceBranch: branch,
        targetBranch: options.mainBranch,
      });

      try {
        await removeUnlocked(branch);
      } catch (error) {
        // The merge succeeded and a cleanup failure does not undo it. Saying so
        // matters: a caller that read this as "merge failed" would retry it.
        throw new WorktreeError(
          `Merged ${branch} into ${options.mainBranch} but cleanup failed: ${message(error)}`,
          500,
        );
      }
    } catch (error) {
      throw wrap(error);
    }
  }

  /** What git has, joined with what the database bound — including the disagreements. */
  async function list(): Promise<ManagedWorktree[]> {
    const root = await canonicalRoot();
    const entries = (await git.listLiveWorktrees(projectRoot)).filter(
      (entry) =>
        !entry.bare &&
        entry.branch !== null &&
        resolve(entry.path) !== root &&
        resolve(entry.path) !== projectRoot,
    );
    const bindings =
      options.storage === undefined ? [] : await listStoredWorktrees(options.storage);
    const byBranch = new Map(bindings.map((binding) => [binding.branch, binding]));

    const managed: ManagedWorktree[] = entries.map((entry) => {
      const branch = entry.branch as string;
      const binding = byBranch.get(branch) ?? null;
      byBranch.delete(branch);
      return {
        branch,
        path: entry.path,
        entry,
        binding,
        state: binding === null ? 'unmanaged' : 'managed',
      };
    });

    // Bindings git no longer backs. Reported, never repaired: the outside world
    // is the authority on existence (ADR-08), and recreating a worktree because
    // a row says it should be there is exactly the optimistic recreation that
    // rule forbids.
    for (const binding of byBranch.values()) {
      managed.push({
        branch: binding.branch,
        path: binding.path,
        entry: null,
        binding,
        state: 'orphaned',
      });
    }
    return managed.sort((left, right) => left.branch.localeCompare(right.branch));
  }

  async function updateBinding(
    branch: string,
    update: (binding: StoredWorktree) => StoredWorktree,
  ): Promise<StoredWorktree> {
    await resolveExisting(branch);
    if (options.storage === undefined) {
      throw new WorktreeError('Worktree metadata storage is not configured', 501);
    }
    const binding = await loadStoredWorktree(options.storage, branch);
    if (binding === null) throw new WorktreeError(`Worktree is not managed: ${branch}`, 409);
    const next = update(binding);
    await saveWorktree(options.storage, next);
    return next;
  }

  /** Persist UI curation without competing with git for existence authority. */
  const setArchivedUnlocked = (branch: string, archived: boolean): Promise<StoredWorktree> =>
    updateBinding(branch, (binding) => ({
      ...binding,
      archived,
      updatedAt: new Date().toISOString(),
    }));

  const setLabelUnlocked = (branch: string, label: string | null): Promise<StoredWorktree> =>
    updateBinding(branch, (binding) => ({
      ...binding,
      label,
      updatedAt: new Date().toISOString(),
    }));

  const setProfileUnlocked = (branch: string, profile: string): Promise<StoredWorktree> =>
    updateBinding(branch, (binding) => ({
      ...binding,
      profile,
      updatedAt: new Date().toISOString(),
    }));

  return {
    create: (input: CreateWorktreeInput) =>
      withMutationLock(input.branch.trim(), () => createUnlocked(input)),
    remove: (branch: string, opts: { force?: boolean; keepBranch?: boolean } = {}) =>
      withMutationLock(branch, () => removeUnlocked(branch, opts)),
    merge: (branch: string) => withMutationLock(branch, () => mergeUnlocked(branch)),
    list,
    setArchived: (branch: string, archived: boolean) =>
      withMutationLock(branch, () => setArchivedUnlocked(branch, archived)),
    setLabel: (branch: string, label: string | null) =>
      withMutationLock(branch, () => setLabelUnlocked(branch, label)),
    setProfile: (branch: string, profile: string) =>
      withMutationLock(branch, () => setProfileUnlocked(branch, profile)),
    status: async (branch: string) => git.readWorktreeStatus((await resolveExisting(branch)).path),
    pathFor,
    creating: () => tracker.list(),
  };
}

export type WorktreeManager = ReturnType<typeof createWorktreeManager>;
