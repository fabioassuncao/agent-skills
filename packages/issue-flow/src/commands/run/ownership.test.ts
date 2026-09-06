import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNIT_LOCKS_DIR_NAME } from '../../storage/paths.js';

/**
 * How a run takes the thing that stops two of them colliding (§31.3).
 *
 * The point of this file is the *seam*: `claimRunOwnership` is the single
 * place a run asks for a slot, and `runtime.maxConcurrent` is the only thing
 * that decides whether that slot is the project lock this project has always
 * had or a lock on the execution unit. Both halves are asserted here, because
 * a wiring that silently kept using the project lock would pass every test in
 * `runtime/concurrency.test.ts` and still make the ceiling do nothing.
 */

const paths = vi.hoisted(() => ({ projectDir: '', runLockFile: '' }));
const runtime = vi.hoisted(() => ({ maxConcurrent: 1 }));

vi.mock('../../storage/resolve.js', () => ({
  resolveProjectPaths: vi.fn(async () => ({
    projectDir: paths.projectDir,
    runLockFile: paths.runLockFile,
  })),
}));

vi.mock('../../config/runtime.js', () => ({
  loadRuntimeConfig: vi.fn(async () => ({ maxConcurrent: runtime.maxConcurrent })),
}));

const { claimRunOwnership } = await import('./session.js');

describe('claiming ownership of a run', () => {
  let home: string;
  const taken: Array<{ release: () => Promise<void> }> = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-ownership-'));
    paths.projectDir = home;
    paths.runLockFile = join(home, 'run.lock');
    runtime.maxConcurrent = 1;
  });

  afterEach(async () => {
    for (const handle of taken.splice(0)) await handle.release().catch(() => {});
    await rm(home, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function claim(target: string, detached = false) {
    const result = await claimRunOwnership(target, detached);
    if (result.ok) taken.push(result);
    return result;
  }

  async function readLock(file: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(file, 'utf-8'));
  }

  // The upgrade must not change what a project does. At the default ceiling the
  // file is the same file it has always been.
  it('uses the project run lock at the default ceiling', async () => {
    const result = await claim('42');
    expect(result.ok).toBe(true);
    await expect(readLock(paths.runLockFile)).resolves.toMatchObject({ target: '42' });
  });

  it('never creates a unit lock at the default ceiling', async () => {
    await claim('42');
    await expect(readFile(join(home, UNIT_LOCKS_DIR_NAME, '42.lock'), 'utf-8')).rejects.toThrow();
  });

  // The whole reason the seam exists: above the default the exclusion moves,
  // and two issues in one project stop being a collision.
  it('moves the lock to the unit once the ceiling is raised', async () => {
    runtime.maxConcurrent = 3;
    const result = await claim('42');
    expect(result.ok).toBe(true);
    await expect(readLock(join(home, UNIT_LOCKS_DIR_NAME, '42.lock'))).resolves.toMatchObject({
      target: '42',
    });
  });

  it('lets two different issues run at once', async () => {
    runtime.maxConcurrent = 3;
    expect((await claim('42')).ok).toBe(true);
    expect((await claim('43')).ok).toBe(true);
  });

  it('refuses past the ceiling, and says what to raise', async () => {
    runtime.maxConcurrent = 2;
    await claim('42');
    await claim('43');

    const third = await claim('44');
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.refusal).toContain('runtime.maxConcurrent');
  });

  // `--background` has to survive the seam: it is what tells a later run whether
  // reclaiming a stale lock is a recovery or a collision.
  it('keeps the detached marker', async () => {
    await claim('42', true);
    await expect(readLock(paths.runLockFile)).resolves.toMatchObject({ detached: true });
  });

  // The guard exists to stop two runs colliding; it must never be the reason a
  // single run cannot start.
  it('runs without a lock when the project storage cannot be resolved at all', async () => {
    const { resolveProjectPaths } = await import('../../storage/resolve.js');
    vi.mocked(resolveProjectPaths).mockRejectedValueOnce(new Error('no git repository'));

    const result = await claimRunOwnership('42');
    expect(result).toMatchObject({ ok: true, interruptedBy: null });
  });
});
