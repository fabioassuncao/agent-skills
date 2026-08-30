import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

vi.mock('../storage/resolve.js', () => ({
  resolveIssuePaths: vi.fn(async () => ({ sessionFile: join(runtime.dir, 'session.json') })),
}));

vi.mock('../web/lock.js', () => ({ ensureWebMonitor: vi.fn(async () => null) }));

const plan = vi.hoisted(
  (): TaskPlan => ({
    project: 'issue-flow',
    issueNumber: 75,
    issueUrl: 'https://github.com/fabioassuncao/issue-flow/issues/75',
    branchName: 'develop',
    description: 'Monitor web',
    issueStatus: 'in_progress',
    completedAt: null,
    lastAttemptAt: null,
    lastError: null,
    correctionCycle: 0,
    maxCorrectionCycles: 3,
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
    const { FilePublisher } = await import('../core/session-state.js');
    const publisher = getSessionPublisher();
    runtime.publisherWasInstalled = publisher instanceof FilePublisher;
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

  it('creates no publisher, timer or session file when web monitoring is off', async () => {
    expect(await runExecute(undefined, { issue: '75' })).toBe(0);

    expect(runtime.publisherWasInstalled).toBe(false);
    expect(getSessionPublisher()).toBeInstanceOf(NullPublisher);
    expect(existsSync(join(runtime.dir, 'session.json'))).toBe(false);
    expect(ensureWebMonitor).not.toHaveBeenCalled();
  });

  it('owns a file publisher for direct execute --web and flushes its final snapshot', async () => {
    runtime.webEnabled = true;

    expect(await runExecute(undefined, { issue: '75' })).toBe(0);

    expect(runtime.publisherWasInstalled).toBe(true);
    expect(ensureWebMonitor).toHaveBeenCalledTimes(1);
    expect(getSessionPublisher()).toBeInstanceOf(NullPublisher);
    const snapshot = JSON.parse(await readFile(join(runtime.dir, 'session.json'), 'utf-8'));
    expect(snapshot.status).toBe('completed');
    expect(snapshot.currentPhase).toBeNull();
    expect(snapshot.stories.map((story: { id: string }) => story.id)).toEqual(['US-001']);
  });

  it('forwards the one-shot restart request only for direct execute monitoring', async () => {
    runtime.webEnabled = true;

    expect(await runExecute(undefined, { issue: '75', restartWeb: true })).toBe(0);

    expect(ensureWebMonitor).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3737, host: '127.0.0.1' }),
      { restart: true },
    );
  });
});
