import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_LOCK_HEARTBEAT_MS, RUN_LOCK_STALE_INTERVALS } from '../storage/lock.js';
import { getUnitRunLockPath, UNIT_LOCKS_DIR_NAME } from '../storage/paths.js';
import { acquireExecutionSlot, countLiveUnitLocks, describeSlotRefusal } from './concurrency.js';

/**
 * §31.3: parallelism is a consequence of worktree isolation, not a feature of
 * its own — and the default has to stay exactly what this project has always
 * done. Nothing becomes parallel by upgrading.
 */
describe('execution slots', () => {
  let projectDir: string;
  const handles: Array<{ release(): Promise<void> }> = [];

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'issue-flow-concurrency-'));
  });

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.release().catch(() => {});
    await rm(projectDir, { recursive: true, force: true });
  });

  function input(overrides: Partial<Parameters<typeof acquireExecutionSlot>[0]> = {}) {
    return {
      projectDir,
      projectRunLockFile: join(projectDir, 'run.lock'),
      unitId: '42',
      target: 'issue 42',
      ...overrides,
    };
  }

  async function acquire(overrides: Partial<Parameters<typeof acquireExecutionSlot>[0]> = {}) {
    const result = await acquireExecutionSlot(input(overrides));
    if (result.ok) handles.push(result.handle);
    return result;
  }

  /**
   * A live lock belonging to **another** process.
   *
   * pid 1 exists on every platform this runs on and is never this process, so
   * it is the cheapest way to write a lock that is genuinely somebody else's.
   */
  async function writeForeignLock(lockFile: string): Promise<void> {
    await mkdir(dirname(lockFile), { recursive: true });
    const now = new Date().toISOString();
    await writeFile(
      lockFile,
      JSON.stringify({
        pid: 1,
        host: 'test-host',
        target: 'someone else',
        startedAt: now,
        lastHeartbeatAt: now,
      }),
    );
  }

  /** A live lock belonging to this process, so it counts as running. */
  async function writeLiveUnitLock(unitId: string): Promise<string> {
    const lockFile = getUnitRunLockPath(projectDir, unitId);
    await mkdir(join(projectDir, UNIT_LOCKS_DIR_NAME), { recursive: true });
    const now = new Date().toISOString();
    await writeFile(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        host: 'test-host',
        target: unitId,
        startedAt: now,
        lastHeartbeatAt: now,
      }),
    );
    return lockFile;
  }

  describe('the default ceiling', () => {
    // The whole point: an upgrade must not change how a project behaves.
    it('uses the project lock and nothing else', async () => {
      const result = await acquire();
      expect(result).toMatchObject({ ok: true, scope: 'project' });
      if (result.ok) expect(result.lockFile).toBe(join(projectDir, 'run.lock'));
      // No locks directory is created at all.
      await expect(countLiveUnitLocks(projectDir)).resolves.toBe(0);
    });

    it('refuses a second run of the project, as it always did', async () => {
      await writeForeignLock(join(projectDir, 'run.lock'));
      const result = await acquire();
      expect(result).toMatchObject({ ok: false, reason: 'owned' });
    });

    it('treats 0 and a missing value the same as 1', async () => {
      const result = await acquire({ maxConcurrent: 0 });
      expect(result).toMatchObject({ ok: true, scope: 'project' });
    });
  });

  describe('a raised ceiling', () => {
    it('moves the lock to the unit', async () => {
      const result = await acquire({ maxConcurrent: 3 });
      expect(result).toMatchObject({ ok: true, scope: 'unit' });
      if (result.ok) expect(result.lockFile).toBe(getUnitRunLockPath(projectDir, '42'));
    });

    it('lets different units run at the same time', async () => {
      const first = await acquire({ unitId: '42', maxConcurrent: 3 });
      const second = await acquire({ unitId: '43', target: 'issue 43', maxConcurrent: 3 });
      const third = await acquire({ unitId: '44', target: 'issue 44', maxConcurrent: 3 });

      expect([first.ok, second.ok, third.ok]).toEqual([true, true, true]);
      await expect(countLiveUnitLocks(projectDir)).resolves.toBe(3);
    });

    // The guarantee the project lock was really providing, kept exactly. The
    // exclusion is between *processes*: re-acquiring one's own lock is how a
    // single process resumes its own work, and always was.
    it('never lets another process run the same unit', async () => {
      await mkdir(join(projectDir, UNIT_LOCKS_DIR_NAME), { recursive: true });
      await writeForeignLock(getUnitRunLockPath(projectDir, '42'));
      const result = await acquire({ unitId: '42', maxConcurrent: 5 });
      expect(result).toMatchObject({ ok: false, reason: 'owned' });
    });

    it('refuses once the ceiling is reached, naming the numbers', async () => {
      await acquire({ unitId: '42', maxConcurrent: 2 });
      await acquire({ unitId: '43', target: 'issue 43', maxConcurrent: 2 });

      const third = await acquire({ unitId: '44', target: 'issue 44', maxConcurrent: 2 });
      expect(third).toMatchObject({ ok: false, reason: 'at-capacity', running: 2, ceiling: 2 });
      if (!third.ok) {
        expect(describeSlotRefusal(third)).toContain('2 of 2');
        expect(describeSlotRefusal(third)).toContain('runtime.maxConcurrent');
      }
    });

    it('frees the slot when a run releases it', async () => {
      const first = await acquire({ unitId: '42', maxConcurrent: 1 + 1 });
      await acquire({ unitId: '43', target: 'issue 43', maxConcurrent: 2 });
      expect(await acquire({ unitId: '44', target: 'issue 44', maxConcurrent: 2 })).toMatchObject({
        ok: false,
      });

      if (first.ok) await first.handle.release();
      handles.shift();
      expect(await acquire({ unitId: '44', target: 'issue 44', maxConcurrent: 2 })).toMatchObject({
        ok: true,
      });
    });
  });

  // §39's completion criterion for this phase: five executions at once, with a
  // marginal cost per session inside the §35 budget of 30 ms.
  it('takes five slots at once, well inside the marginal budget', async () => {
    const samples: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const startedAt = Date.now();
      const result = await acquire({
        unitId: String(100 + index),
        target: `issue ${100 + index}`,
        maxConcurrent: 5,
      });
      samples.push(Date.now() - startedAt);
      expect(result.ok).toBe(true);
    }

    await expect(countLiveUnitLocks(projectDir)).resolves.toBe(5);
    const median = [...samples].sort((left, right) => left - right)[2] ?? Number.POSITIVE_INFINITY;
    console.log(`execution slot: median ${median} ms over ${samples.length} acquisitions`);
    expect(median).toBeLessThanOrEqual(30);

    // And the sixth is refused rather than quietly making it six.
    expect(await acquire({ unitId: '999', target: 'issue 999', maxConcurrent: 5 })).toMatchObject({
      ok: false,
      reason: 'at-capacity',
    });
  });

  // `--background` is recorded in the lock, and it is what lets a later run tell
  // a detached owner from an interactive one. A slot that dropped it would make
  // every parallel run look interactive.
  describe('a detached run stays marked as one', () => {
    it('records it on the project lock', async () => {
      await acquire({ detached: true });
      const lock = JSON.parse(await readFile(join(projectDir, 'run.lock'), 'utf-8'));
      expect(lock.detached).toBe(true);
    });

    it('records it on the unit lock too', async () => {
      await acquire({ detached: true, maxConcurrent: 3 });
      const lock = JSON.parse(await readFile(getUnitRunLockPath(projectDir, '42'), 'utf-8'));
      expect(lock.detached).toBe(true);
    });

    it('leaves an interactive run unmarked rather than writing false', async () => {
      await acquire({ maxConcurrent: 3 });
      const lock = JSON.parse(await readFile(getUnitRunLockPath(projectDir, '42'), 'utf-8'));
      expect(lock.detached).toBeUndefined();
    });
  });

  describe('counting what is actually running', () => {
    it('reports nothing before any unit has run', async () => {
      await expect(countLiveUnitLocks(projectDir)).resolves.toBe(0);
    });

    it('counts a live lock', async () => {
      await writeLiveUnitLock('42');
      await expect(countLiveUnitLocks(projectDir)).resolves.toBe(1);
    });

    // A crashed run leaves its lock behind. Counting it would make a project
    // refuse work for a process that no longer exists.
    it('ignores a lock whose owner is gone', async () => {
      const lockFile = getUnitRunLockPath(projectDir, '42');
      await mkdir(join(projectDir, UNIT_LOCKS_DIR_NAME), { recursive: true });
      const now = new Date().toISOString();
      await writeFile(
        lockFile,
        // pid 1 exists but is not us; the heartbeat is what settles it.
        JSON.stringify({
          pid: process.pid,
          host: 'test-host',
          target: '42',
          startedAt: now,
          lastHeartbeatAt: new Date(
            Date.now() - RUN_LOCK_HEARTBEAT_MS * (RUN_LOCK_STALE_INTERVALS + 2),
          ).toISOString(),
        }),
      );
      await expect(countLiveUnitLocks(projectDir)).resolves.toBe(0);
    });

    it('ignores an unreadable lock rather than refusing the project', async () => {
      await mkdir(join(projectDir, UNIT_LOCKS_DIR_NAME), { recursive: true });
      await writeFile(getUnitRunLockPath(projectDir, 'broken'), '{ not json');
      await expect(countLiveUnitLocks(projectDir)).resolves.toBe(0);
    });

    it('ignores files that are not locks', async () => {
      await writeLiveUnitLock('42');
      await writeFile(join(projectDir, UNIT_LOCKS_DIR_NAME, 'README.md'), 'notes\n');
      await expect(countLiveUnitLocks(projectDir)).resolves.toBe(1);
    });
  });

  describe('unit lock paths', () => {
    // A story id can contain a slash, and one that produced a nested path would
    // create a lock nobody looks for.
    it('keeps a unit id to a single path component', () => {
      expect(getUnitRunLockPath('/p', 'US-001')).toBe('/p/locks/US-001.lock');
      expect(getUnitRunLockPath('/p', 'feat/63-thing')).toBe('/p/locks/feat-63-thing.lock');
      // `..` is a path component with a meaning; a lock file is not the place
      // to find out whether join() normalises it the way one hoped.
      expect(getUnitRunLockPath('/p', '../escape')).toBe('/p/locks/escape.lock');
      expect(getUnitRunLockPath('/p', '..')).toBe('/p/locks/unit.lock');
      expect(getUnitRunLockPath('/p', '!!!')).toBe('/p/locks/unit.lock');
    });
  });
});
