import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { type RunLock, runLockSchema } from './schemas.js';

/**
 * Run ownership: who is executing in this project right now.
 *
 * Generalised from `web/lock.ts`, which has guarded the monitoring server the
 * same way since it existed — atomic `wx` create, `process.kill(pid, 0)` for
 * liveness, and a read that degrades to "no lock" on anything malformed. What
 * this module adds is the piece a *long* run needs and a server does not: a
 * **heartbeat**. A web server proves it is alive by answering a health probe;
 * a pipeline has no port to probe, so it says so in the file instead.
 *
 * The two signals answer different questions and both are needed:
 *
 * - the **pid** catches the machine that rebooted or the process that was
 *   `kill -9`ed — the lock outlives its owner, and nothing else would notice;
 * - the **heartbeat** catches the owner that is technically alive but no longer
 *   running (a pid reused by an unrelated process is the same case), and it is
 *   the only signal that survives being read from another host.
 *
 * Nothing here is destructive by inference: a lock is only taken over when it
 * is stale by both measures the policy states, and taking one over is reported
 * to the caller (`reclaimedFrom`) so the run can be recorded as interrupted
 * rather than silently restarted.
 */

/** The lock is rewritten this often while a run holds it. */
export const RUN_LOCK_HEARTBEAT_MS = 10_000;

/**
 * How many missed heartbeats make a lock stale.
 *
 * Three, not one: a machine under load, a suspended laptop or a slow
 * filesystem can miss a beat without the run being dead, and stealing a lock
 * from a live owner is the failure this module exists to prevent.
 */
export const RUN_LOCK_STALE_INTERVALS = 3;

/** How many times a claim is retried after clearing a stale lock. */
const CLAIM_RETRIES = 3;

export interface RunLockHandle {
  readonly lock: RunLock;
  /**
   * The dead owner this lock was taken from, when it was taken from one.
   *
   * `null` on a clean acquisition. Non-null is the fact a caller records as an
   * *interrupted* run: something was executing here and never finished.
   */
  readonly reclaimedFrom: RunLock | null;
  /** Stop the heartbeat and remove the lock. Never rejects. */
  release(): Promise<void>;
}

export type AcquireRunLockResult =
  | { ok: true; handle: RunLockHandle }
  | { ok: false; owner: RunLock };

export interface AcquireRunLockOptions {
  /** Issue (or queue) identifier this run works on. */
  target: string;
  /** Rewrite interval. Also the unit `staleIntervals` counts. */
  heartbeatMs?: number;
  staleIntervals?: number;
  /** Injectable identity, so a test can pretend to be another process. */
  pid?: number;
  host?: string;
  /** Injectable clock, so staleness is testable without waiting. */
  clock?: () => number;
  /** Called once, when a stale lock is taken over. Never throws through. */
  onTakeover?: (previous: RunLock) => void;
  /**
   * Start the rewriting timer. Default true; a test that drives the clock by
   * hand turns it off and calls `touchRunLock` itself.
   */
  heartbeat?: boolean;
  /** The owner is a process spawned by `--background`. */
  detached?: boolean;
}

/**
 * `process.kill(pid, 0)` throws `ESRCH` when the pid is gone and `EPERM` when
 * it is alive but owned by another user — **only `ESRCH` means "not alive"**.
 * Reading `EPERM` as death is how a lock gets stolen from a healthy run
 * started by another user.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read a lock, degrading anything unreadable to "no lock".
 *
 * A partial write, a file from an incompatible release, a truncated JSON: all
 * of them mean the same thing operationally, and none of them justifies
 * failing a run. Same behaviour as `readWebLock` and `loadGlobalConfig`.
 */
export async function readRunLock(lockFile: string): Promise<RunLock | null> {
  let raw: string;
  try {
    raw = await readFile(lockFile, 'utf-8');
  } catch {
    return null;
  }
  try {
    const result = runLockSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Remove a lock file. Best effort; never rejects. */
export async function removeRunLock(lockFile: string): Promise<void> {
  try {
    await rm(lockFile, { force: true });
  } catch {
    /* best-effort cleanup */
  }
}

export interface StalenessOptions {
  heartbeatMs?: number;
  staleIntervals?: number;
  clock?: () => number;
  /** Treat this pid as our own, so a re-entrant claim is not "stale". */
  pid?: number;
  host?: string;
}

/**
 * Whether `lock` may be taken over.
 *
 * A lock written on another host cannot be judged by pid — `process.kill` there
 * says nothing about a process here — so on a foreign host only the heartbeat
 * decides. That is the case a shared filesystem creates, and reading it wrong
 * is how two machines end up on the same branch.
 */
export function isRunLockStale(lock: RunLock, options: StalenessOptions = {}): boolean {
  const heartbeatMs = options.heartbeatMs ?? RUN_LOCK_HEARTBEAT_MS;
  const staleIntervals = options.staleIntervals ?? RUN_LOCK_STALE_INTERVALS;
  const now = (options.clock ?? Date.now)();
  const host = options.host ?? hostname();

  const beat = Date.parse(lock.lastHeartbeatAt);
  const silent = Number.isNaN(beat) || now - beat > heartbeatMs * staleIntervals;

  if (lock.host !== host) return silent;
  return silent || !isProcessAlive(lock.pid);
}

/** Whether this very process already owns `lock`. */
function isSelf(lock: RunLock, pid: number, host: string): boolean {
  return lock.pid === pid && lock.host === host;
}

/**
 * One line naming the owner, for the message a refused invocation prints.
 *
 * The pid alone is useless to a person; the pid *plus the host plus when it
 * last said anything* is what lets them decide between waiting and killing it.
 */
export function describeRunLockOwner(lock: RunLock): string {
  return `pid ${lock.pid} on ${lock.host} (issue ${lock.target}, started ${lock.startedAt}, last heartbeat ${lock.lastHeartbeatAt})`;
}

/** Rewrite the lock with a fresh heartbeat. Never rejects. */
export async function touchRunLock(lockFile: string, lock: RunLock, at: string): Promise<RunLock> {
  const next: RunLock = { ...lock, lastHeartbeatAt: at };
  try {
    await writeFile(lockFile, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  } catch {
    // A heartbeat that cannot be written is not worth failing a run over: the
    // worst case is that another invocation eventually judges us stale, which
    // is the same outcome as this process having died.
  }
  return next;
}

/**
 * Atomic exclusive create. `wx` fails with `EEXIST` when someone else won the
 * race, which is what lets two concurrent invocations agree on one winner
 * without a lock for the lock.
 */
async function claim(lockFile: string, lock: RunLock): Promise<boolean> {
  try {
    await mkdir(dirname(lockFile), { recursive: true });
    await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Take ownership of the run in this project, or report who already has it.
 *
 * Three outcomes, and only three:
 *
 * 1. **free** — the lock is claimed and a heartbeat starts;
 * 2. **held by a dead owner** — the stale lock is cleared, claimed, and the
 *    previous owner comes back on `reclaimedFrom` so the caller can record the
 *    interrupted run;
 * 3. **held by a live owner** — `{ ok: false, owner }`, and the caller refuses
 *    with a message naming it. Nothing is deleted, nothing is retried into
 *    submission.
 *
 * A lock this very process already holds is outcome 1 with a no-op release:
 * re-entering is not a conflict, and a nested acquisition must not remove the
 * file the outer one still owns.
 */
export async function acquireRunLock(
  lockFile: string,
  options: AcquireRunLockOptions,
): Promise<AcquireRunLockResult> {
  const pid = options.pid ?? process.pid;
  const host = options.host ?? hostname();
  const heartbeatMs = options.heartbeatMs ?? RUN_LOCK_HEARTBEAT_MS;
  const clock = options.clock ?? Date.now;
  const staleness: StalenessOptions = {
    heartbeatMs,
    ...(options.staleIntervals === undefined ? {} : { staleIntervals: options.staleIntervals }),
    clock,
    pid,
    host,
  };

  let reclaimedFrom: RunLock | null = null;

  for (let attempt = 0; attempt <= CLAIM_RETRIES; attempt++) {
    const at = new Date(clock()).toISOString();
    const mine: RunLock = {
      pid,
      host,
      target: options.target,
      startedAt: at,
      lastHeartbeatAt: at,
      ...(options.detached === true ? { detached: true } : {}),
    };

    if (await claim(lockFile, mine)) {
      return { ok: true, handle: startHandle(lockFile, mine, reclaimedFrom, options) };
    }

    const existing = await readRunLock(lockFile);

    if (existing === null) {
      // Unreadable: a partial write, or a file from a shape we do not know.
      // Treated as absent, exactly as `readRunLock` documents.
      await removeRunLock(lockFile);
      continue;
    }

    if (isSelf(existing, pid, host)) {
      return { ok: true, handle: nestedHandle(existing) };
    }

    if (!isRunLockStale(existing, staleness)) {
      return { ok: false, owner: existing };
    }

    reclaimedFrom = existing;
    try {
      options.onTakeover?.(existing);
    } catch {
      // A caller's bookkeeping must not decide whether the run starts.
    }
    await removeRunLock(lockFile);
  }

  // Every attempt lost the race and every lock read was stale or unreadable:
  // something else is fighting for this file. Refusing is the safe answer.
  const owner = await readRunLock(lockFile);
  if (owner !== null) return { ok: false, owner };
  return {
    ok: false,
    owner: {
      pid: 0,
      host,
      target: options.target,
      startedAt: new Date(clock()).toISOString(),
      lastHeartbeatAt: new Date(clock()).toISOString(),
    },
  };
}

function startHandle(
  lockFile: string,
  lock: RunLock,
  reclaimedFrom: RunLock | null,
  options: AcquireRunLockOptions,
): RunLockHandle {
  const heartbeatMs = options.heartbeatMs ?? RUN_LOCK_HEARTBEAT_MS;
  const clock = options.clock ?? Date.now;
  let current = lock;
  let timer: NodeJS.Timeout | null = null;

  if (options.heartbeat !== false) {
    timer = setInterval(() => {
      void touchRunLock(lockFile, current, new Date(clock()).toISOString()).then((next) => {
        current = next;
      });
    }, heartbeatMs);
    // The heartbeat must never be the reason a process stays alive.
    timer.unref();
  }

  return {
    lock,
    reclaimedFrom,
    release: async () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      await removeRunLock(lockFile);
    },
  };
}

/** A re-entrant acquisition: same owner, no timer of its own, no removal. */
function nestedHandle(lock: RunLock): RunLockHandle {
  return { lock, reclaimedFrom: null, release: async () => {} };
}
