import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { acquireRunLock, describeRunLockOwner } from '../../storage/lock.js';

/** Directory below a resolved project store that owns worktree mutation locks. */
export function getWorktreeMutationLockDir(projectDir: string): string {
  return join(projectDir, 'worktree-locks');
}

export function getWorktreeMutationLockPath(lockDir: string, branch: string): string {
  const digest = createHash('sha256').update(branch).digest('hex').slice(0, 16);
  return join(lockDir, `${digest}.lock`);
}

const held = new AsyncLocalStorage<ReadonlySet<string>>();
const tails = new Map<string, Promise<void>>();

export interface WorktreeBranchLockOptions {
  /** Enables process-wide exclusion. Omitted only by isolated unit fakes. */
  lockDir?: string;
}

/**
 * Serialize every worktree mutation for a project/branch.
 *
 * The promise tail covers concurrent callers in this process. The durable lock
 * covers independent CLI and monitor processes. Async-local ownership makes
 * manager calls nested inside a larger session operation safely re-entrant.
 */
export async function withWorktreeBranchLock<T>(
  projectId: string,
  branch: string,
  operation: () => Promise<T>,
  options: WorktreeBranchLockOptions = {},
): Promise<T> {
  const key = `${projectId}\0${branch}`;
  if (held.getStore()?.has(key) === true) return operation();

  const previous = tails.get(key) ?? Promise.resolve();
  let releaseLocal = (): void => {};
  const gate = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  tails.set(key, tail);

  await previous.catch(() => {});
  let releaseDurable: (() => Promise<void>) | null = null;
  try {
    if (options.lockDir !== undefined) {
      const acquired = await acquireRunLock(getWorktreeMutationLockPath(options.lockDir, branch), {
        target: `worktree:${branch}`,
      });
      if (!acquired.ok) {
        throw new Error(
          `Worktree ${branch} is being changed by ${describeRunLockOwner(acquired.owner)}.`,
        );
      }
      releaseDurable = acquired.handle.release;
    }
    const nextHeld = new Set(held.getStore() ?? []);
    nextHeld.add(key);
    return await held.run(nextHeld, operation);
  } finally {
    await releaseDurable?.();
    releaseLocal();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
