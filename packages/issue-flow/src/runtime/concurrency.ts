import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type AcquireRunLockResult,
  acquireRunLock,
  isProcessAlive,
  isRunLockStale,
  type RunLockHandle,
  readRunLock,
} from '../storage/lock.js';
import { getUnitRunLockPath, UNIT_LOCKS_DIR_NAME } from '../storage/paths.js';
import type { RunLock } from '../storage/schemas.js';

/**
 * Running more than one execution unit in a project at a time.
 *
 * §31.3 is explicit that this is **not a feature of its own**: parallelism is a
 * consequence of worktree isolation, and the upstream has no global lock
 * precisely because none of its state is shared — every worktree has its own
 * directory, its own environment, its own ports and its own tmux window.
 *
 * So the mechanism here is small, and its default is "unchanged":
 *
 * - `maxConcurrent: 1` keeps the project-wide `run.lock` and the serial queue
 *   this project has always had. Nothing becomes parallel by upgrading.
 * - Above 1 the lock moves to the execution **unit** — an issue, or a story —
 *   and a ceiling replaces the exclusion.
 *
 * ## What is exact and what is a throttle
 *
 * The per-unit lock is **exact**: it is claimed with an exclusive create, so two
 * runs of the same unit can never both hold it. That is the guarantee that
 * matters, and it is the one the previous project-wide lock was really
 * providing.
 *
 * The ceiling is a **throttle**. Counting live locks and then claiming one is
 * not atomic, so two processes starting in the same instant can both see room
 * and both start, transiently exceeding the ceiling by one. Making that exact
 * would need a lock over the counting, which would serialise exactly the thing
 * this exists to parallelise — and the cost of being one over for a few seconds
 * is a machine that is slightly busier, not a corrupted run.
 */

export interface AcquireExecutionSlotInput {
  /** `<projectDir>` — where `run.lock` and `locks/` live. */
  projectDir: string;
  /** Project-wide lock, used unchanged when the ceiling is 1. */
  projectRunLockFile: string;
  /** Issue or story this run is for. */
  unitId: string;
  /** Human-readable target recorded in the lock. */
  target: string;
  /** From `runtime.maxConcurrent`. Default 1. */
  maxConcurrent?: number;
  /**
   * `--background`. Recorded in the lock so a later run can tell a detached
   * owner from an interactive one, which is what decides whether reclaiming it
   * is a recovery or a collision. Dropping it here would make every parallel
   * run look interactive.
   */
  detached?: boolean;
}

export type AcquireExecutionSlotResult =
  | { ok: true; handle: RunLockHandle; lockFile: string; scope: 'project' | 'unit' }
  | { ok: false; reason: 'owned'; owner: RunLock; lockFile: string }
  | { ok: false; reason: 'at-capacity'; running: number; ceiling: number };

/** Locks in `locks/` whose owner is alive and heartbeating. */
export async function countLiveUnitLocks(projectDir: string): Promise<number> {
  const directory = join(projectDir, UNIT_LOCKS_DIR_NAME);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    // No directory means no unit has ever run in parallel here.
    return 0;
  }

  // One pass over the directory rather than a probe per unit (ADR-13): the
  // question is "how many are running", and asking it per entity is what turns
  // a constant cost into a linear one.
  const locks = await Promise.all(
    entries
      .filter((name) => name.endsWith('.lock'))
      .map((name) => readRunLock(join(directory, name))),
  );
  return locks.filter(
    (lock): lock is RunLock => lock !== null && isProcessAlive(lock.pid) && !isRunLockStale(lock),
  ).length;
}

/**
 * Take a slot for one execution unit.
 *
 * At the default ceiling this is `acquireRunLock` on the project lock and
 * nothing else — the same call, the same file, the same outcome.
 */
export async function acquireExecutionSlot(
  input: AcquireExecutionSlotInput,
): Promise<AcquireExecutionSlotResult> {
  const ceiling = input.maxConcurrent ?? 1;

  if (ceiling <= 1) {
    const result: AcquireRunLockResult = await acquireRunLock(input.projectRunLockFile, {
      target: input.target,
      ...(input.detached === undefined ? {} : { detached: input.detached }),
    });
    return result.ok
      ? { ok: true, handle: result.handle, lockFile: input.projectRunLockFile, scope: 'project' }
      : { ok: false, reason: 'owned', owner: result.owner, lockFile: input.projectRunLockFile };
  }

  const running = await countLiveUnitLocks(input.projectDir);
  if (running >= ceiling) return { ok: false, reason: 'at-capacity', running, ceiling };

  const lockFile = getUnitRunLockPath(input.projectDir, input.unitId);
  await mkdir(dirname(lockFile), { recursive: true });
  const result = await acquireRunLock(lockFile, {
    target: input.target,
    ...(input.detached === undefined ? {} : { detached: input.detached }),
  });
  return result.ok
    ? { ok: true, handle: result.handle, lockFile, scope: 'unit' }
    : { ok: false, reason: 'owned', owner: result.owner, lockFile };
}

/** Wording for a refusal, so every caller reports the same thing. */
export function describeSlotRefusal(
  result: Extract<AcquireExecutionSlotResult, { ok: false }>,
): string {
  if (result.reason === 'at-capacity') {
    return `This project is already running ${result.running} of ${result.ceiling} allowed executions. Raise runtime.maxConcurrent or wait for one to finish.`;
  }
  return `Another issue-flow run owns this unit: pid ${result.owner.pid} on ${result.owner.host} (${result.owner.target}, last heartbeat ${result.owner.lastHeartbeatAt}).`;
}
