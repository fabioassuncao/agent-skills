import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { classifyRunLock, listLiveRuns } from './registry.js';

const HOST = 'test-host';

function lock(overrides: Record<string, unknown> = {}) {
  return {
    pid: process.pid,
    host: HOST,
    target: '63',
    startedAt: '2026-08-30T03:00:00.000Z',
    lastHeartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('classifyRunLock', () => {
  it('is running when the pid is alive and the heartbeat is fresh', () => {
    expect(classifyRunLock(lock())).toBe('running');
  });

  it('is orphan when the pid is gone', () => {
    expect(
      classifyRunLock(lock({ pid: 2_147_483_647, lastHeartbeatAt: new Date().toISOString() })),
    ).toBe('orphan');
  });

  it('is unsignaled when the pid is alive but the heartbeat is stale', () => {
    expect(classifyRunLock(lock({ lastHeartbeatAt: '2020-01-01T00:00:00.000Z' }))).toBe(
      'unsignaled',
    );
  });
});

describe('listLiveRuns', () => {
  let tmp: string;
  const env = () => ({ [GLOBAL_ROOT_ENV]: tmp });

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'issue-flow-registry-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns nothing when the tree is empty', async () => {
    await expect(listLiveRuns({ env: env() })).resolves.toEqual([]);
  });

  it('lists a foreground lock, a detached lock and a lock from another project', async () => {
    await mkdir(join(tmp, 'projects', 'alpha'), { recursive: true });
    await mkdir(join(tmp, 'projects', 'beta'), { recursive: true });
    await writeFile(
      join(tmp, 'projects', 'alpha', 'run.lock'),
      JSON.stringify(lock({ target: '10' })),
    );
    await writeFile(
      join(tmp, 'projects', 'beta', 'run.lock'),
      JSON.stringify(lock({ target: '20', detached: true })),
    );

    const runs = await listLiveRuns({ env: env() });
    expect(runs).toHaveLength(2);
    expect(
      runs.map((run) => ({ projectId: run.projectId, target: run.target, detached: run.detached })),
    ).toEqual([
      { projectId: 'alpha', target: '10', detached: false },
      { projectId: 'beta', target: '20', detached: true },
    ]);
    expect(runs.every((run) => run.status === 'running')).toBe(true);
  });

  it('names a kill -9 leftover as orphan, never as running', async () => {
    await mkdir(join(tmp, 'projects', 'gone'), { recursive: true });
    await writeFile(
      join(tmp, 'projects', 'gone', 'run.lock'),
      JSON.stringify(lock({ pid: 2_147_483_647, lastHeartbeatAt: '2026-08-30T03:00:00.000Z' })),
    );

    const runs = await listLiveRuns({ env: env() });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('orphan');
    expect(runs[0]?.pid).toBe(2_147_483_647);
  });
});
