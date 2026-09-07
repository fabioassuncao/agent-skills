import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRunLock } from '../../storage/lock.js';
import { withWorktreeBranchLock } from './lock.js';

const dirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('worktree branch lock', () => {
  it('serializes the complete check-and-act sequence for one branch', async () => {
    const events: string[] = [];
    let releaseFirst = (): void => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withWorktreeBranchLock('project', 'feature', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    await Promise.resolve();
    const second = withWorktreeBranchLock('project', 'feature', async () => {
      events.push('second:start');
      events.push('second:end');
    });
    await Promise.resolve();

    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('does not serialize independent branches', async () => {
    const events: string[] = [];
    let releaseFirst = (): void => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withWorktreeBranchLock('project', 'one', async () => {
      events.push('one');
      await firstGate;
    });
    const second = withWorktreeBranchLock('project', 'two', async () => {
      events.push('two');
    });

    await second;
    expect(events).toEqual(['one', 'two']);
    releaseFirst();
    await first;
  });

  it('holds a durable lock for independent CLI and monitor processes', async () => {
    const lockDir = await mkdtemp(join(tmpdir(), 'issue-flow-worktree-lock-'));
    dirs.push(lockDir);
    let observed: string[] = [];

    await withWorktreeBranchLock(
      'project',
      'feature',
      async () => {
        observed = await readdir(lockDir);
        expect(observed).toHaveLength(1);
        const competing = await acquireRunLock(join(lockDir, observed[0] as string), {
          target: 'worktree:feature',
          pid: process.pid + 100_000,
          heartbeat: false,
        });
        expect(competing.ok).toBe(false);
        const child = await execFileAsync(
          join(process.cwd(), 'node_modules', '.bin', 'vite-node'),
          [join(import.meta.dirname, 'fixtures', 'lock-contender.ts'), lockDir],
        );
        expect(child.stdout).toBe('blocked\n');
        await withWorktreeBranchLock('project', 'feature', async () => {}, { lockDir });
      },
      { lockDir },
    );

    expect(observed[0]).toMatch(/^[a-f0-9]{16}\.lock$/);
    await expect(readdir(lockDir)).resolves.toEqual([]);
  });
});
