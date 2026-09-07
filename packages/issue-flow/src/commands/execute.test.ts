import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedPaths, TaskPlan } from '../types.js';

const runtime = vi.hoisted(() => ({
  dir: '',
  webEnabled: false,
  publisherWasInstalled: false,
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    validateDependencies: vi.fn(async () => []),
    resolvePaths: vi.fn(
      async (): Promise<ResolvedPaths> => ({
        prdFile: join(runtime.dir, 'tasks.json'),
        progressFile: join(runtime.dir, 'progress.txt'),
        archiveDir: join(runtime.dir, 'archive'),
        lastBranchFile: join(runtime.dir, '.last-branch'),
        projectRoot: runtime.dir,
      }),
    ),
    loadWebConfig: vi.fn(async () => ({
      enabled: runtime.webEnabled,
      port: 3737,
      host: '127.0.0.1',
      refreshSeconds: 5,
      logLimit: 200,
      includeLogs: true,
    })),
  };
});

vi.mock('../web/lock.js', () => ({ ensureWebMonitor: vi.fn(async () => null) }));

const plan = vi.hoisted(
  (): TaskPlan => ({
    project: 'issue-flow',
    issueNumber: 75,
    issueUrl: 'https://github.com/fabioassuncao/issue-flow/issues/75',
    branchName: 'develop',
    noBranch: false,
    description: 'Monitor web',
    issueStatus: 'in_progress',
    completedAt: null,
    lastAttemptAt: null,
    lastError: null,
    correctionCycle: 0,
    maxCorrectionCycles: 3,
    lastReviewFindings: null,
    pipeline: {
      prdCompleted: true,
      jsonCompleted: true,
      executionCompleted: false,
      reviewCompleted: false,
      prCreated: false,
    },
    userStories: [
      {
        id: 'US-001',
        title: 'Story',
        description: '',
        acceptanceCriteria: [],
        priority: 1,
        passes: true,
        notes: '',
      },
    ],
  }),
);

vi.mock('../core/state-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/state-manager.js')>();
  return {
    ...actual,
    loadTaskPlan: vi.fn(async () => structuredClone(plan)),
    saveTaskPlan: vi.fn(async () => {}),
  };
});

vi.mock('../core/engine.js', () => ({
  runEngine: vi.fn(async () => {
    const { getSessionPublisher } = await import('../core/session-publisher.js');
    const publisher = getSessionPublisher();
    runtime.publisherWasInstalled = !(publisher instanceof NullPublisher);
    publisher.publish({
      type: 'stories:update',
      at: '2026-08-30T05:01:00Z',
      stories: structuredClone(plan.userStories),
    });
    return 0;
  }),
}));

const { setSessionPublisher, getSessionPublisher } = await import('../core/session-publisher.js');
const { NullPublisher } = await import('../core/session-state.js');
const { ensureWebMonitor } = await import('../web/lock.js');
const { runExecute } = await import('./execute.js');

describe('runExecute — standalone web monitoring', () => {
  beforeEach(async () => {
    runtime.dir = await mkdtemp(join(tmpdir(), 'issue-flow-execute-web-'));
    runtime.webEnabled = false;
    runtime.publisherWasInstalled = false;
    setSessionPublisher(undefined);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    setSessionPublisher(undefined);
    await rm(runtime.dir, { recursive: true, force: true });
  });

  it('creates no publisher or monitor when web monitoring is off', async () => {
    expect(await runExecute({ issue: '75' })).toBe(0);

    expect(runtime.publisherWasInstalled).toBe(false);
    expect(getSessionPublisher()).toBeInstanceOf(NullPublisher);
    expect(ensureWebMonitor).not.toHaveBeenCalled();
  });

  it('owns a publisher for direct execute --web and releases it at the end', async () => {
    runtime.webEnabled = true;

    expect(await runExecute({ issue: '75' })).toBe(0);

    expect(runtime.publisherWasInstalled).toBe(true);
    expect(ensureWebMonitor).toHaveBeenCalledTimes(1);
    expect(getSessionPublisher()).toBeInstanceOf(NullPublisher);
  });

  it('forwards the one-shot restart request only for direct execute monitoring', async () => {
    runtime.webEnabled = true;

    expect(await runExecute({ issue: '75', restartWeb: true })).toBe(0);

    expect(ensureWebMonitor).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3737, host: '127.0.0.1' }),
      { restart: true },
    );
  });
});
