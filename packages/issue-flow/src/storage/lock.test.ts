import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireRunLock,
  describeRunLockOwner,
  isRunLockStale,
  RUN_LOCK_HEARTBEAT_MS,
  RUN_LOCK_STALE_INTERVALS,
  readRunLock,
  removeRunLock,
  touchRunLock,
} from './lock.js';
import type { RunLock } from './schemas.js';

const HOST = hostname();

/** A pid that is certainly not running: pid 1 is init, and this is not it. */
const DEAD_PID = 0x7ffffffe;

let dir: string;
let lockFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdirOf(), 'issue-flow-lock-'));
  lockFile = join(dir, 'run.lock');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function tmpdirOf(): string {
  return process.env.TMPDIR ?? '/tmp';
}

function lockOf(overrides: Partial<RunLock> = {}): RunLock {
  return {
    pid: process.pid,
    host: HOST,
    target: '63',
    startedAt: '2026-08-30T03:00:00.000Z',
    lastHeartbeatAt: '2026-08-30T03:00:00.000Z',
    ...overrides,
  };
}

async function writeLock(lock: RunLock): Promise<void> {
  await writeFile(lockFile, JSON.stringify(lock, null, 2), 'utf-8');
}

/** A clock pinned to the lock timestamps above, in ms. */
const AT = Date.parse('2026-08-30T03:00:00.000Z');
const clockAt = (offsetMs: number) => () => AT + offsetMs;

describe('readRunLock', () => {
  it('reads a lock its owner wrote', async () => {
    await writeLock(lockOf());
    await expect(readRunLock(lockFile)).resolves.toEqual(lockOf());
  });

  it('reads an absent file as no lock', async () => {
    await expect(readRunLock(lockFile)).resolves.toBeNull();
  });

  it.each([
    ['truncated JSON', '{"pid": 12'],
    ['not an object', '"hello"'],
    ['a shape it does not know', '{"owner":"someone"}'],
    ['an empty file', ''],
  ])('degrades %s to no lock', async (_name, content) => {
    await writeFile(lockFile, content, 'utf-8');
    await expect(readRunLock(lockFile)).resolves.toBeNull();
  });
});

describe('isRunLockStale', () => {
  it('is false for a live pid beating on time', () => {
    expect(isRunLockStale(lockOf(), { clock: clockAt(RUN_LOCK_HEARTBEAT_MS) })).toBe(false);
  });

  it('is true once the heartbeat is older than the tolerated intervals', () => {
    const justInside = RUN_LOCK_HEARTBEAT_MS * RUN_LOCK_STALE_INTERVALS;

    expect(isRunLockStale(lockOf(), { clock: clockAt(justInside) })).toBe(false);
    expect(isRunLockStale(lockOf(), { clock: clockAt(justInside + 1) })).toBe(true);
  });

  it('is true for a dead pid even with a fresh heartbeat', () => {
    expect(isRunLockStale(lockOf({ pid: DEAD_PID }), { clock: clockAt(0) })).toBe(true);
  });

  it('judges a lock from another host by its heartbeat alone', () => {
    // Our pid table says nothing about a process on another machine, so a
    // fresh heartbeat from `builder-02` is a live owner however dead that
    // number looks here.
    const foreign = lockOf({ pid: DEAD_PID, host: 'builder-02' });

    expect(isRunLockStale(foreign, { clock: clockAt(0) })).toBe(false);
    expect(
      isRunLockStale(foreign, {
        clock: clockAt(RUN_LOCK_HEARTBEAT_MS * RUN_LOCK_STALE_INTERVALS + 1),
      }),
    ).toBe(true);
  });

  it('treats an unparseable heartbeat as silence', () => {
    expect(isRunLockStale(lockOf({ lastHeartbeatAt: 'whenever' }), { clock: clockAt(0) })).toBe(
      true,
    );
  });
});

describe('acquireRunLock', () => {
  it('claims a free lock and writes the owner to disk', async () => {
    const result = await acquireRunLock(lockFile, { target: '63', heartbeat: false });

    expect(result.ok).toBe(true);
    const written = await readRunLock(lockFile);
    expect(written).toMatchObject({ pid: process.pid, host: HOST, target: '63' });
  });

  it('creates the project directory when nothing has written there yet', async () => {
    const nested = join(dir, 'projects', 'widgets-abc', 'run.lock');

    const result = await acquireRunLock(nested, { target: '63', heartbeat: false });

    expect(result.ok).toBe(true);
    await expect(readRunLock(nested)).resolves.not.toBeNull();
  });

  it('refuses when a live owner holds it, naming pid, host and heartbeat', async () => {
    // Another process on this host, beating right now.
    const owner = lockOf({ pid: 1, target: '101' });
    await writeLock(owner);

    const result = await acquireRunLock(lockFile, {
      target: '63',
      heartbeat: false,
      clock: clockAt(0),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.owner).toEqual(owner);

    const description = describeRunLockOwner(result.owner);
    expect(description).toContain('pid 1');
    expect(description).toContain(HOST);
    expect(description).toContain('101');
    expect(description).toContain('2026-08-30T03:00:00.000Z');
    // The live owner's file is left exactly as it was.
    await expect(readRunLock(lockFile)).resolves.toEqual(owner);
  });

  it('takes over a lock whose pid is gone, and reports the previous owner', async () => {
    const dead = lockOf({ pid: DEAD_PID, target: '101' });
    await writeLock(dead);
    const onTakeover = vi.fn();

    const result = await acquireRunLock(lockFile, {
      target: '63',
      heartbeat: false,
      clock: clockAt(0),
      onTakeover,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Non-null `reclaimedFrom` is the fact the caller records as an
    // interrupted run: something was executing here and never finished.
    expect(result.handle.reclaimedFrom).toEqual(dead);
    expect(onTakeover).toHaveBeenCalledWith(dead);
    await expect(readRunLock(lockFile)).resolves.toMatchObject({ target: '63' });
  });

  it('takes over a lock that stopped beating, even with a live pid', async () => {
    // Our own pid, so liveness is not the reason — only the silence is.
    await writeLock(lockOf({ pid: 1, target: '101' }));

    const result = await acquireRunLock(lockFile, {
      target: '63',
      heartbeat: false,
      clock: clockAt(RUN_LOCK_HEARTBEAT_MS * RUN_LOCK_STALE_INTERVALS + 1),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.handle.reclaimedFrom).toMatchObject({ pid: 1, target: '101' });
  });

  it('allows only one of two contenders that already observed the same stale owner to reclaim it', async () => {
    for (let iteration = 0; iteration < 20; iteration++) {
      await writeLock(
        lockOf({
          pid: DEAD_PID,
          ownerId: `stale-${iteration}`,
          host: 'stale-host',
          target: 'old',
        }),
      );
      let observed = 0;
      let letContendersProceed = (): void => {};
      const bothObserved = new Promise<void>((resolve) => {
        letContendersProceed = resolve;
      });
      const options = (pid: number, host: string, target: string) => ({
        target,
        heartbeat: false as const,
        pid,
        host,
        clock: clockAt(RUN_LOCK_HEARTBEAT_MS * RUN_LOCK_STALE_INTERVALS + 1),
        beforeReclaim: async () => {
          observed += 1;
          if (observed === 2) letContendersProceed();
          await bothObserved;
        },
      });

      const contenders = await Promise.all([
        acquireRunLock(lockFile, options(101_001, 'contender-a', 'a')),
        acquireRunLock(lockFile, options(202_002, 'contender-b', 'b')),
      ]);
      expect(contenders.filter((result) => result.ok)).toHaveLength(1);
      expect(contenders.filter((result) => !result.ok)).toHaveLength(1);
      const winner = contenders.find((result) => result.ok);
      if (winner?.ok) await winner.handle.release();
    }
  });

  it('does not let a resumed predecessor heartbeat or release a successor', async () => {
    const predecessor = await acquireRunLock(lockFile, {
      target: 'old',
      heartbeat: false,
    });
    expect(predecessor.ok).toBe(true);
    if (!predecessor.ok) return;

    // Model the predecessor being suspended while a takeover installs a new
    // owner. Both happen to use the same pid and host; ownerId distinguishes
    // the two possessions.
    await removeRunLock(lockFile);
    const successor = await acquireRunLock(lockFile, {
      target: 'new',
      heartbeat: false,
    });
    expect(successor.ok).toBe(true);
    if (!successor.ok) return;
    const successorOnDisk = await readRunLock(lockFile);

    await touchRunLock(lockFile, predecessor.handle.lock, '2099-01-01T00:00:00.000Z');
    await expect(readRunLock(lockFile)).resolves.toEqual(successorOnDisk);

    await predecessor.handle.release();
    await expect(readRunLock(lockFile)).resolves.toEqual(successorOnDisk);

    await successor.handle.release();
    await expect(readRunLock(lockFile)).resolves.toBeNull();
  });

  it('recovers when a dead local contender abandoned its ownership guard', async () => {
    const stale = lockOf({
      pid: DEAD_PID,
      ownerId: 'stale-owner',
      target: 'old',
    });
    await writeLock(stale);
    const digest = createHash('sha256')
      .update(stale.ownerId ?? '')
      .digest('hex');
    const abandonedGuard = `${lockFile}.owner-${digest}.abandoned.guard`;
    await writeFile(
      abandonedGuard,
      JSON.stringify({
        reservationId: 'abandoned',
        pid: DEAD_PID,
        host: HOST,
        choosing: false,
        number: 1,
      }),
      'utf-8',
    );

    const result = await acquireRunLock(lockFile, {
      target: 'successor',
      heartbeat: false,
      clock: clockAt(0),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(readRunLock(lockFile)).resolves.toMatchObject({ target: 'successor' });
    expect(await readdir(dir)).toContain(`run.lock.owner-${digest}.abandoned.guard`);

    await result.handle.release();
  });

  it.each([
    ['live local', process.pid, HOST],
    ['foreign', DEAD_PID, 'builder-02'],
  ])('fails closed without deleting a %s ownership guard', async (_kind, pid, host) => {
    const stale = lockOf({
      pid: DEAD_PID,
      ownerId: `guarded-owner-${_kind}`,
      target: 'old',
    });
    await writeLock(stale);
    const digest = createHash('sha256')
      .update(stale.ownerId ?? '')
      .digest('hex');
    const guardName = `run.lock.owner-${digest}.blocking.guard`;
    await writeFile(
      join(dir, guardName),
      JSON.stringify({ reservationId: 'blocking', pid, host, choosing: false, number: 1 }),
      'utf-8',
    );

    const result = await acquireRunLock(lockFile, {
      target: 'contender',
      heartbeat: false,
      clock: clockAt(0),
    });

    expect(result).toEqual({ ok: false, owner: stale });
    await expect(readRunLock(lockFile)).resolves.toEqual(stale);
    expect(await readdir(dir)).toContain(guardName);
  });

  it('clears an unreadable lock instead of refusing forever', async () => {
    await writeFile(lockFile, '{"pid": 12', 'utf-8');

    const result = await acquireRunLock(lockFile, { target: '63', heartbeat: false });

    expect(result.ok).toBe(true);
    // Nothing was "taken over": there was no owner to name.
    if (result.ok) expect(result.handle.reclaimedFrom).toBeNull();
  });

  it('does not remove a valid successor installed after observing an unreadable lock', async () => {
    await writeFile(lockFile, '{"pid": 12', 'utf-8');
    const successor = lockOf({
      pid: 1,
      ownerId: 'successor-owner',
      target: 'successor',
    });

    const result = await acquireRunLock(lockFile, {
      target: 'contender',
      heartbeat: false,
      clock: clockAt(0),
      beforeMalformedReclaim: async () => {
        await writeLock(successor);
      },
    });

    expect(result).toEqual({ ok: false, owner: successor });
    await expect(readRunLock(lockFile)).resolves.toEqual(successor);
  });

  it('re-entering from the same process is not a conflict', async () => {
    const first = await acquireRunLock(lockFile, { target: '63', heartbeat: false });
    const second = await acquireRunLock(lockFile, { target: '63', heartbeat: false });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // The nested handle must not remove the file the outer one still owns.
    if (second.ok) await second.handle.release();
    await expect(readRunLock(lockFile)).resolves.not.toBeNull();

    if (first.ok) await first.handle.release();
    await expect(readRunLock(lockFile)).resolves.toBeNull();
  });

  it('releases by removing the file, and tolerates a double release', async () => {
    const result = await acquireRunLock(lockFile, { target: '63', heartbeat: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.handle.release();
    await expect(readRunLock(lockFile)).resolves.toBeNull();
    await expect(result.handle.release()).resolves.toBeUndefined();
  });

  it('lets a second acquisition through once the first released', async () => {
    const first = await acquireRunLock(lockFile, { target: '63', heartbeat: false, pid: 1 });
    expect(first.ok).toBe(true);
    if (first.ok) await first.handle.release();

    const second = await acquireRunLock(lockFile, { target: '64', heartbeat: false });
    expect(second.ok).toBe(true);
  });
});

describe('the heartbeat', () => {
  it('rewrites the lock with a newer timestamp, keeping the owner', async () => {
    const lock = lockOf();
    await writeLock(lock);

    const next = await touchRunLock(lockFile, lock, '2026-08-30T03:00:30.000Z');

    expect(next).toEqual({ ...lock, lastHeartbeatAt: '2026-08-30T03:00:30.000Z' });
    await expect(readRunLock(lockFile)).resolves.toEqual(next);
  });

  it('never rejects when the file cannot be written', async () => {
    await removeRunLock(lockFile);
    const unwritable = join(dir, 'missing-dir', 'run.lock');

    await expect(touchRunLock(unwritable, lockOf(), 'x')).resolves.toMatchObject({
      lastHeartbeatAt: 'x',
    });
  });

  it('runs on a timer that never keeps the process alive', async () => {
    vi.useFakeTimers();
    try {
      const result = await acquireRunLock(lockFile, { target: '63', heartbeatMs: 10 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const before = await readFile(lockFile, 'utf-8');
      await vi.advanceTimersByTimeAsync(35);
      await vi.waitFor(async () => {
        await expect(readFile(lockFile, 'utf-8')).resolves.not.toBe(before);
      });
      await result.handle.release();
      // Released: the timer is cleared and the file is gone, so a later tick
      // cannot resurrect a lock this process no longer owns.
      await vi.advanceTimersByTimeAsync(50);
      await expect(readRunLock(lockFile)).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
