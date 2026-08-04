import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GLOBAL_ROOT_ENV, getIssuePaths } from '../storage/paths.js';
import type { UserStory } from '../types.js';
import {
  createInitialSnapshot,
  FilePublisher,
  MemoryPublisher,
  NullPublisher,
  reduceSessionEvent,
  type SessionEvent,
  type SessionSnapshot,
} from './session-state.js';

function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: 'US-001',
    title: 'First story',
    description: 'Test story',
    acceptanceCriteria: ['Criterion 1'],
    priority: 1,
    passes: false,
    notes: '',
    ...overrides,
  };
}

function startedSnapshot(): SessionSnapshot {
  return reduceSessionEvent(createInitialSnapshot(), {
    type: 'session:start',
    at: '2026-08-03T12:00:00Z',
    sessionId: 'abc',
    issueNumber: 22,
    issueUrl: 'https://github.com/test/test/issues/22',
    branch: 'issue/22-test',
    baseBranch: 'main',
    phases: ['init', 'prd', 'execute'],
  });
}

describe('createInitialSnapshot', () => {
  it('starts idle, read-only, with empty collections', () => {
    const snap = createInitialSnapshot();
    expect(snap.schemaVersion).toBe(1);
    expect(snap.status).toBe('idle');
    expect(snap.readOnly).toBe(true);
    expect(snap.capabilities).toEqual([]);
    expect(snap.phases).toEqual([]);
    expect(snap.logs).toEqual([]);
    expect(snap.startedAt).toBeNull();
  });

  it('starts every aggregate metric as null, never zero', () => {
    expect(createInitialSnapshot().metrics).toEqual({
      totalInputTokens: null,
      totalOutputTokens: null,
      totalCacheReadTokens: null,
      totalCacheCreationTokens: null,
      totalCostUsd: null,
    });
  });
});

describe('reduceSessionEvent', () => {
  it('does not mutate the input snapshot', () => {
    const before = createInitialSnapshot();
    const frozen = JSON.parse(JSON.stringify(before));
    reduceSessionEvent(before, {
      type: 'log',
      at: '2026-08-03T12:00:00Z',
      level: 'info',
      message: 'hello',
    });
    expect(before).toEqual(frozen);
  });

  it('session:start initializes session, issue, git and pending phases', () => {
    const snap = startedSnapshot();
    expect(snap.status).toBe('running');
    expect(snap.sessionId).toBe('abc');
    expect(snap.issue).toEqual({ number: 22, url: 'https://github.com/test/test/issues/22' });
    expect(snap.git.branch).toBe('issue/22-test');
    expect(snap.git.baseBranch).toBe('main');
    expect(snap.startedAt).toBe('2026-08-03T12:00:00Z');
    expect(snap.elapsedSeconds).toBe(0);
    expect(snap.progress.phasesTotal).toBe(3);
    expect(snap.phases.map((p) => p.status)).toEqual(['pending', 'pending', 'pending']);
  });

  it('session:start creates phases with null metric fields', () => {
    const phase = startedSnapshot().phases[0];
    expect(phase.inputTokens).toBeNull();
    expect(phase.outputTokens).toBeNull();
    expect(phase.cacheReadTokens).toBeNull();
    expect(phase.cacheCreationTokens).toBeNull();
    expect(phase.costUsd).toBeNull();
  });

  it('phase:start marks the phase running and sets currentPhase', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'phase:start',
      at: '2026-08-03T12:00:05Z',
      phase: 'prd',
    });
    expect(snap.currentPhase).toBe('prd');
    const prd = snap.phases.find((p) => p.name === 'prd');
    expect(prd?.status).toBe('running');
    expect(prd?.startedAt).toBe('2026-08-03T12:00:05Z');
    expect(snap.updatedAt).toBe('2026-08-03T12:00:05Z');
    expect(snap.elapsedSeconds).toBe(5);
  });

  it('phase:end computes duration, progress percent and clears currentPhase', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'phase:start',
      at: '2026-08-03T12:00:05Z',
      phase: 'prd',
    });
    snap = reduceSessionEvent(snap, {
      type: 'phase:end',
      at: '2026-08-03T12:00:35Z',
      phase: 'prd',
      success: true,
    });
    const prd = snap.phases.find((p) => p.name === 'prd');
    expect(prd?.status).toBe('completed');
    expect(prd?.durationSeconds).toBe(30);
    expect(snap.currentPhase).toBeNull();
    expect(snap.progress.phasesCompleted).toBe(1);
    expect(snap.progress.percent).toBe(33);
  });

  it('phase:end with failure records the error without ANSI codes', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'phase:start',
      at: '2026-08-03T12:00:05Z',
      phase: 'execute',
    });
    snap = reduceSessionEvent(snap, {
      type: 'phase:end',
      at: '2026-08-03T12:00:10Z',
      phase: 'execute',
      success: false,
      error: '[31mboom[0m',
    });
    const phase = snap.phases.find((p) => p.name === 'execute');
    expect(phase?.status).toBe('failed');
    expect(phase?.error).toBe('boom');
  });

  it('phase:start for an unknown phase appends it and bumps phasesTotal', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'phase:start',
      at: '2026-08-03T12:00:05Z',
      phase: 'review',
    });
    expect(snap.phases.map((p) => p.name)).toContain('review');
    expect(snap.progress.phasesTotal).toBe(4);
  });

  it('iteration and retry events update execution counters', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'iteration:start',
      at: '2026-08-03T12:01:00Z',
      iteration: 3,
    });
    snap = reduceSessionEvent(snap, { type: 'retry', at: '2026-08-03T12:02:00Z', attempt: 1 });
    snap = reduceSessionEvent(snap, { type: 'retry', at: '2026-08-03T12:03:00Z', attempt: 2 });
    expect(snap.execution.iteration).toBe(3);
    expect(snap.execution.retries).toBe(2);
  });

  it('stories:update projects stories and story progress counters', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [
        makeStory({ id: 'US-001', passes: true }),
        makeStory({ id: 'US-002', title: 'Second', priority: 2 }),
      ],
    });
    expect(snap.stories).toEqual([
      {
        id: 'US-001',
        title: 'First story',
        priority: 1,
        passes: true,
        completedAt: null,
        durationSeconds: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
      },
      {
        id: 'US-002',
        title: 'Second',
        priority: 2,
        passes: false,
        completedAt: null,
        durationSeconds: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
      },
    ]);
    expect(snap.progress.storiesCompleted).toBe(1);
    expect(snap.progress.storiesTotal).toBe(2);
  });

  it('stories:update stamps completedAt only when a story flips to passing', () => {
    // First seen already passing: completed before this session, no stamp.
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory({ id: 'US-001', passes: true }), makeStory({ id: 'US-002' })],
    });
    expect(snap.stories[0].completedAt).toBeNull();

    snap = reduceSessionEvent(snap, {
      type: 'stories:update',
      at: '2026-08-03T12:10:00Z',
      stories: [
        makeStory({ id: 'US-001', passes: true }),
        makeStory({ id: 'US-002', passes: true }),
      ],
    });
    expect(snap.stories[0].completedAt).toBeNull();
    expect(snap.stories[1].completedAt).toBe('2026-08-03T12:10:00Z');

    // Flipping back to failing clears the stamp.
    snap = reduceSessionEvent(snap, {
      type: 'stories:update',
      at: '2026-08-03T12:20:00Z',
      stories: [
        makeStory({ id: 'US-001', passes: true }),
        makeStory({ id: 'US-002', passes: false }),
      ],
    });
    expect(snap.stories[1].completedAt).toBeNull();
  });

  it('estimatedRemainingSeconds is null with fewer than two in-session completions', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory({ id: 'US-001' }), makeStory({ id: 'US-002', priority: 2 })],
    });
    expect(snap.estimatedRemainingSeconds).toBeNull();

    snap = reduceSessionEvent(snap, {
      type: 'stories:update',
      at: '2026-08-03T12:10:00Z',
      stories: [
        makeStory({ id: 'US-001', passes: true }),
        makeStory({ id: 'US-002', priority: 2 }),
      ],
    });
    expect(snap.estimatedRemainingSeconds).toBeNull();
  });

  it('estimatedRemainingSeconds averages in-session story durations times pending stories', () => {
    // Session starts 12:00. US-001 completes 12:10 (600s), US-002 12:30 (1200s).
    // Average 900s × 2 pending stories = 1800s.
    const stories = [
      makeStory({ id: 'US-001' }),
      makeStory({ id: 'US-002', priority: 2 }),
      makeStory({ id: 'US-003', priority: 3 }),
      makeStory({ id: 'US-004', priority: 4 }),
    ];
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:00:30Z',
      stories,
    });
    snap = reduceSessionEvent(snap, {
      type: 'stories:update',
      at: '2026-08-03T12:10:00Z',
      stories: stories.map((s) => (s.id === 'US-001' ? { ...s, passes: true } : s)),
    });
    snap = reduceSessionEvent(snap, {
      type: 'stories:update',
      at: '2026-08-03T12:30:00Z',
      stories: stories.map((s) =>
        s.id !== 'US-003' && s.id !== 'US-004' ? { ...s, passes: true } : s,
      ),
    });
    expect(snap.estimatedRemainingSeconds).toBe(1800);
  });

  it('derives nextSteps from the pending phases', () => {
    let snap = startedSnapshot();
    expect(snap.nextSteps).toEqual(['init', 'prd', 'execute']);

    snap = reduceSessionEvent(snap, {
      type: 'phase:start',
      at: '2026-08-03T12:00:05Z',
      phase: 'init',
    });
    expect(snap.nextSteps).toEqual(['prd', 'execute']);

    snap = reduceSessionEvent(snap, {
      type: 'phase:end',
      at: '2026-08-03T12:00:10Z',
      phase: 'init',
      success: true,
    });
    expect(snap.nextSteps).toEqual(['prd', 'execute']);
  });

  it('nextSteps is empty once the session completes', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'session:end',
      at: '2026-08-03T13:00:00Z',
      status: 'completed',
    });
    expect(snap.nextSteps).toEqual([]);
  });

  it('activity sets currentActivity and preserves `since` when unchanged', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'activity',
      at: '2026-08-03T12:01:00Z',
      story: 'US-001',
      tool: 'Bash',
      detail: 'npm test',
    });
    expect(snap.currentActivity).toEqual({
      story: 'US-001',
      tool: 'Bash',
      detail: 'npm test',
      since: '2026-08-03T12:01:00Z',
    });

    snap = reduceSessionEvent(snap, {
      type: 'activity',
      at: '2026-08-03T12:01:30Z',
      story: 'US-001',
      tool: 'Bash',
      detail: 'npm test',
    });
    expect(snap.currentActivity?.since).toBe('2026-08-03T12:01:00Z');

    snap = reduceSessionEvent(snap, {
      type: 'activity',
      at: '2026-08-03T12:02:00Z',
      story: 'US-001',
      tool: 'Edit',
      detail: 'src/foo.ts',
    });
    expect(snap.currentActivity?.since).toBe('2026-08-03T12:02:00Z');
  });

  it('iteration:end clears currentActivity', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'activity',
      at: '2026-08-03T12:01:00Z',
      tool: 'Bash',
    });
    snap = reduceSessionEvent(snap, {
      type: 'iteration:end',
      at: '2026-08-03T12:02:00Z',
      iteration: 1,
    });
    expect(snap.currentActivity).toBeNull();
  });

  it('log strips ANSI codes and caps the ring buffer at logLimit', () => {
    let snap = startedSnapshot();
    for (let i = 0; i < 10; i++) {
      snap = reduceSessionEvent(
        snap,
        {
          type: 'log',
          at: '2026-08-03T12:01:00Z',
          level: 'info',
          message: `[32mline ${i}[0m`,
        },
        { logLimit: 5 },
      );
    }
    expect(snap.logs).toHaveLength(5);
    expect(snap.logs[0].message).toBe('line 5');
    expect(snap.logs[4].message).toBe('line 9');
  });

  it('derives errors and warnings from the logs ring buffer', () => {
    let snap = startedSnapshot();
    snap = reduceSessionEvent(snap, {
      type: 'log',
      at: '2026-08-03T12:01:00Z',
      level: 'info',
      message: 'ok',
    });
    snap = reduceSessionEvent(snap, {
      type: 'log',
      at: '2026-08-03T12:01:01Z',
      level: 'warn',
      message: 'careful',
    });
    snap = reduceSessionEvent(snap, {
      type: 'log',
      at: '2026-08-03T12:01:02Z',
      level: 'error',
      message: 'broke',
    });
    expect(snap.errors.map((e) => e.message)).toEqual(['broke']);
    expect(snap.warnings.map((w) => w.message)).toEqual(['careful']);

    // An error evicted from the ring buffer disappears from the derived slice.
    for (let i = 0; i < 3; i++) {
      snap = reduceSessionEvent(
        snap,
        { type: 'log', at: '2026-08-03T12:01:03Z', level: 'info', message: `fill ${i}` },
        { logLimit: 3 },
      );
    }
    expect(snap.errors).toEqual([]);
    expect(snap.warnings).toEqual([]);
  });

  it('correction:cycle updates execution state', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'correction:cycle',
      at: '2026-08-03T12:05:00Z',
      cycle: 2,
      maxCycles: 3,
    });
    expect(snap.execution.correctionCycle).toBe(2);
    expect(snap.execution.maxCorrectionCycles).toBe(3);
  });

  it('session:end records final status, endedAt and lastError', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'session:end',
      at: '2026-08-03T13:00:00Z',
      status: 'failed',
      error: 'phase execute failed',
    });
    expect(snap.status).toBe('failed');
    expect(snap.endedAt).toBe('2026-08-03T13:00:00Z');
    expect(snap.elapsedSeconds).toBe(3600);
    expect(snap.lastError).toEqual({ message: 'phase execute failed', at: '2026-08-03T13:00:00Z' });
    expect(snap.currentPhase).toBeNull();
    expect(snap.currentActivity).toBeNull();
  });

  it('session:end without error keeps lastError untouched', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'session:end',
      at: '2026-08-03T13:00:00Z',
      status: 'completed',
    });
    expect(snap.status).toBe('completed');
    expect(snap.lastError).toBeNull();
  });

  it('tolerates unparsable timestamps without producing NaN', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'phase:start',
      at: 'not-a-date',
      phase: 'prd',
    });
    expect(snap.elapsedSeconds).toBe(0);
    const ended = reduceSessionEvent(snap, {
      type: 'phase:end',
      at: 'also-not-a-date',
      phase: 'prd',
      success: true,
    });
    expect(ended.phases.find((p) => p.name === 'prd')?.durationSeconds).toBeNull();
  });

  it('ignores unknown event types', () => {
    const snap = startedSnapshot();
    const next = reduceSessionEvent(snap, {
      type: 'unknown:event',
      at: '2026-08-03T12:00:00Z',
    } as unknown as SessionEvent);
    expect(next).toBe(snap);
  });
});

describe('NullPublisher', () => {
  it('is a no-op with version 0 and a stable empty snapshot', async () => {
    const publisher = new NullPublisher();
    publisher.publish({ type: 'log', at: '2026-08-03T12:00:00Z', level: 'info', message: 'x' });
    expect(publisher.version()).toBe(0);
    expect(publisher.snapshot().status).toBe('idle');
    expect(publisher.snapshot().logs).toEqual([]);
    await publisher.flush();
    await publisher.close();
  });
});

describe('MemoryPublisher', () => {
  it('increments version monotonically on each published event', () => {
    const publisher = new MemoryPublisher();
    expect(publisher.version()).toBe(0);
    publisher.publish({
      type: 'session:start',
      at: '2026-08-03T12:00:00Z',
      sessionId: 's',
      issueNumber: 1,
      phases: ['init'],
    });
    publisher.publish({ type: 'log', at: '2026-08-03T12:00:01Z', level: 'info', message: 'a' });
    expect(publisher.version()).toBe(2);
    expect(publisher.snapshot().status).toBe('running');
    expect(publisher.snapshot().logs).toHaveLength(1);
  });

  it('publish never throws, even when internals fail; warns only once', () => {
    const warnings: string[] = [];
    const publisher = new MemoryPublisher({ onWarn: (m) => warnings.push(m) });
    // Force an internal failure in the reducer path.
    const broken = {
      type: 'stories:update',
      at: '2026-08-03T12:00:00Z',
      stories: null,
    } as unknown as SessionEvent;
    expect(() => publisher.publish(broken)).not.toThrow();
    expect(() => publisher.publish(broken)).not.toThrow();
    expect(warnings).toHaveLength(1);
  });

  it('drops log events without bumping the version when includeLogs is false', () => {
    const publisher = new MemoryPublisher({ includeLogs: false });
    publisher.publish({
      type: 'session:start',
      at: '2026-08-03T12:00:00Z',
      sessionId: 's',
      issueNumber: 1,
      phases: ['init'],
    });
    publisher.publish({ type: 'log', at: '2026-08-03T12:00:01Z', level: 'error', message: 'x' });
    expect(publisher.version()).toBe(1);
    expect(publisher.snapshot().logs).toEqual([]);
    expect(publisher.snapshot().errors).toEqual([]);
    // Non-log events still flow normally.
    expect(publisher.snapshot().status).toBe('running');
  });
});

describe('FilePublisher', () => {
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'issue-flow-state-test-'));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('writes the snapshot to disk without leaving a temp file behind', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'session.json');
      const publisher = new FilePublisher(filePath, { throttleMs: 0, onWarn: () => {} });
      publisher.publish({
        type: 'session:start',
        at: '2026-08-03T12:00:00Z',
        sessionId: 's',
        issueNumber: 1,
        phases: ['init'],
      });
      await publisher.close();

      const written = JSON.parse(await readFile(filePath, 'utf-8')) as SessionSnapshot;
      expect(written.sessionId).toBe('s');
      expect(written.status).toBe('running');
      // Atomic write cleans up after itself: only session.json remains.
      expect(await readdir(dir)).toEqual(['session.json']);
    });
  });

  it('creates the parent directory on the first write when it does not exist yet', async () => {
    await withTempDir(async (dir) => {
      // The real destination: `run` hands the publisher `paths.sessionFile`,
      // several levels deep inside the global storage, where not even the
      // project directory has to exist yet.
      const { sessionFile } = getIssuePaths('widgets-0123456789ab', 23, {
        env: { [GLOBAL_ROOT_ENV]: dir },
      });
      const filePath = sessionFile;
      const warn = vi.fn();
      // Regression: the very first publish() used to fire before any phase
      // had a chance to mkdir the issue directory, throwing ENOENT on write.
      const publisher = new FilePublisher(filePath, { throttleMs: 0, onWarn: warn });
      publisher.publish({
        type: 'session:start',
        at: '2026-08-03T12:00:00Z',
        sessionId: 's',
        issueNumber: 23,
        phases: ['init'],
      });
      await publisher.close();

      expect(warn).not.toHaveBeenCalled();
      const written = JSON.parse(await readFile(filePath, 'utf-8')) as SessionSnapshot;
      expect(written.sessionId).toBe('s');
    });
  });

  it('honors includeLogs=false: published file contains no logs', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'session.json');
      const publisher = new FilePublisher(filePath, {
        throttleMs: 0,
        includeLogs: false,
        onWarn: () => {},
      });
      publisher.publish({
        type: 'session:start',
        at: '2026-08-03T12:00:00Z',
        sessionId: 's',
        issueNumber: 1,
        phases: ['init'],
      });
      publisher.publish({ type: 'log', at: '2026-08-03T12:00:01Z', level: 'info', message: 'x' });
      await publisher.close();

      const written = JSON.parse(await readFile(filePath, 'utf-8')) as SessionSnapshot;
      expect(written.logs).toEqual([]);
      expect(written.errors).toEqual([]);
      expect(written.warnings).toEqual([]);
    });
  });
});

describe('git:update event', () => {
  it('updates commits and pull requests', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'git:update',
      at: '2026-08-03T12:05:00Z',
      branch: 'issue/22-test',
      baseBranch: 'main',
      commits: [{ hash: 'abc1234', subject: 'feat: US-001 - First story' }],
      pullRequests: [{ number: 30, url: 'https://github.com/test/test/pull/30', title: 'Fix' }],
    });
    expect(snap.git.branch).toBe('issue/22-test');
    expect(snap.git.baseBranch).toBe('main');
    expect(snap.git.commits).toEqual([{ hash: 'abc1234', subject: 'feat: US-001 - First story' }]);
    expect(snap.pullRequests).toEqual([
      { number: 30, url: 'https://github.com/test/test/pull/30', title: 'Fix' },
    ]);
    expect(snap.updatedAt).toBe('2026-08-03T12:05:00Z');
  });

  it('keeps previous values for omitted fields', () => {
    const enriched = reduceSessionEvent(startedSnapshot(), {
      type: 'git:update',
      at: '2026-08-03T12:05:00Z',
      commits: [{ hash: 'abc1234', subject: 'first' }],
      pullRequests: [{ number: 30, url: 'https://example.com/30', title: 'PR' }],
    });
    const snap = reduceSessionEvent(enriched, {
      type: 'git:update',
      at: '2026-08-03T12:06:00Z',
      baseBranch: 'develop',
    });
    expect(snap.git.branch).toBe('issue/22-test');
    expect(snap.git.baseBranch).toBe('develop');
    expect(snap.git.commits).toEqual([{ hash: 'abc1234', subject: 'first' }]);
    expect(snap.pullRequests).toEqual([{ number: 30, url: 'https://example.com/30', title: 'PR' }]);
  });
});
