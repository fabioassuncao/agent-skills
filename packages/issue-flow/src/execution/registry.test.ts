import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInitialSnapshot } from '../core/session-state.js';
import type { PlanRepositoryContext } from '../storage/db/repository.js';
import { SqliteSessionPublisher } from '../storage/db/session-publisher.js';
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

  it('enriches a lock from SQLite snapshots without a session.json projection', async () => {
    const projectId = 'sqlite-project';
    const issueId = '55';
    const context: PlanRepositoryContext = {
      tasksPath: join(tmp, 'projects', projectId, 'issues', issueId, 'tasks.json'),
      projectId,
      issueId,
      projectRoot: '/project/sqlite',
      databaseOptions: { env: env() },
    };
    const publisher = new SqliteSessionPublisher(context, { onWarn: () => {} });
    const at = new Date().toISOString();
    publisher.publish({
      type: 'session:start',
      at,
      sessionId: 'session-55',
      issueNumber: 55,
      phases: ['execute'],
    });
    publisher.publish({ type: 'phase:start', at, phase: 'execute' });
    await publisher.flush();
    await publisher.close();

    await mkdir(join(tmp, 'projects', projectId), { recursive: true });
    await writeFile(
      join(tmp, 'projects', projectId, 'run.lock'),
      JSON.stringify(lock({ target: issueId })),
    );

    await expect(listLiveRuns({ env: env() })).resolves.toEqual([
      expect.objectContaining({
        projectId,
        issue: 55,
        phase: 'execute',
        storiesCompleted: 0,
        storiesTotal: 0,
      }),
    ]);
  });

  it('uses compatibility snapshots without opening SQLite in JSON mode', async () => {
    const issueDir = join(tmp, 'projects', 'json-project', 'issues', '63');
    await mkdir(issueDir, { recursive: true });
    await writeFile(
      join(tmp, 'projects', 'json-project', 'run.lock'),
      JSON.stringify(lock({ target: '63' })),
    );
    await writeFile(
      join(issueDir, 'session.json'),
      JSON.stringify({
        ...createInitialSnapshot(),
        sessionId: 'json-session',
        status: 'running',
        currentPhase: 'execute',
        updatedAt: new Date().toISOString(),
        issue: { ...createInitialSnapshot().issue, number: 63 },
      }),
    );

    await expect(listLiveRuns({ env: env(), storageDriver: 'json' })).resolves.toEqual([
      expect.objectContaining({ projectId: 'json-project', issue: 63, phase: 'execute' }),
    ]);
    expect(existsSync(join(tmp, 'issue-flow.db'))).toBe(false);
  });
});
