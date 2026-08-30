import { describe, expect, it } from 'vitest';
import {
  createInitialSnapshot,
  reduceSessionEvent,
  type SessionEvent,
  type SessionSnapshot,
} from '../session-state.js';
import { makeStory, startedSnapshot } from './test-helpers.js';

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

  it('projects agent attempts, failures, failover and streamed activity', () => {
    let snap = startedSnapshot();
    snap = reduceSessionEvent(snap, {
      type: 'agent:attempt',
      at: '2026-08-03T12:01:00Z',
      attempt: 2,
      provider: 'claude',
      model: 'sonnet',
      primaryProvider: 'claude',
    });
    snap = reduceSessionEvent(snap, {
      type: 'agent:result',
      at: '2026-08-03T12:01:10Z',
      provider: 'claude',
      success: false,
      failureKind: 'provider_down',
      cooldownUntil: '2026-08-03T12:02:10Z',
    });
    snap = reduceSessionEvent(snap, {
      type: 'failover',
      at: '2026-08-03T12:01:11Z',
      from: 'claude',
      to: 'codex',
      reason: 'provider_down',
      cooldownUntil: '2026-08-03T12:02:10Z',
    });
    snap = reduceSessionEvent(snap, {
      type: 'agent:activity',
      at: '2026-08-03T12:01:12Z',
      provider: 'codex',
    });
    snap = reduceSessionEvent(snap, {
      type: 'agent:result',
      at: '2026-08-03T12:01:13Z',
      provider: 'codex',
      success: true,
      cooldownUntil: null,
    });

    expect(snap.resilience).toEqual({
      attempt: 2,
      provider: 'codex',
      model: 'sonnet',
      lastFailureKind: 'provider_down',
      cooldownUntil: null,
      lastActivityAt: '2026-08-03T12:01:13Z',
    });
  });

  it('session:start initializes session, issue, git and pending phases', () => {
    const snap = startedSnapshot();
    expect(snap.status).toBe('running');
    expect(snap.sessionId).toBe('abc');
    expect(snap.issue).toEqual({
      number: 22,
      url: 'https://github.com/test/test/issues/22',
      title: null,
      description: null,
      labels: [],
      state: null,
    });
    expect(snap.git.branch).toBe('issue/22-test');
    expect(snap.git.baseBranch).toBe('main');
    expect(snap.startedAt).toBe('2026-08-03T12:00:00Z');
    expect(snap.elapsedSeconds).toBe(0);
    expect(snap.progress.phasesTotal).toBe(3);
    expect(snap.phases.map((p) => p.status)).toEqual(['pending', 'pending', 'pending']);
  });

  it('session:start seeds only the branch of the repository section', () => {
    // Everything else waits for publishGitState; the branch is already known
    // here, so a poll landing before the first git:update sees it in both
    // git.branch and repository.branch.
    expect(startedSnapshot().repository).toEqual({
      name: null,
      remoteUrl: null,
      branch: 'issue/22-test',
      headCommit: null,
      root: null,
    });
  });

  it('session:start creates phases with null metric fields', () => {
    const phase = startedSnapshot().phases[0];
    expect(phase.inputTokens).toBeNull();
    expect(phase.outputTokens).toBeNull();
    expect(phase.cacheReadTokens).toBeNull();
    expect(phase.cacheCreationTokens).toBeNull();
    expect(phase.costUsd).toBeNull();
  });

  it('issue:update enriches the issue section without dropping number and url', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'issue:update',
      at: '2026-08-03T12:00:02Z',
      // A provider that reports no identifier and no remote must not erase
      // what session:start already published.
      number: null,
      title: 'Enrich the monitor snapshot',
      description: 'Long body\nwith several lines',
      labels: ['enhancement', 'monitor'],
      state: 'open',
    });

    expect(snap.issue).toEqual({
      number: 22,
      url: 'https://github.com/test/test/issues/22',
      title: 'Enrich the monitor snapshot',
      description: 'Long body\nwith several lines',
      labels: ['enhancement', 'monitor'],
      state: 'open',
    });
    expect(snap.updatedAt).toBe('2026-08-03T12:00:02Z');
  });

  it('issue:update fills number and url when the session had none', () => {
    const snap = reduceSessionEvent(
      reduceSessionEvent(createInitialSnapshot(), {
        type: 'session:start',
        at: '2026-08-03T12:00:00Z',
        sessionId: 'abc',
        issueNumber: null,
        phases: ['init'],
      }),
      {
        type: 'issue:update',
        at: '2026-08-03T12:00:02Z',
        number: 7,
        url: 'https://github.com/test/test/issues/7',
        title: 'Resolved later',
        description: '',
        labels: [],
        state: 'closed',
      },
    );

    expect(snap.issue).toMatchObject({
      number: 7,
      url: 'https://github.com/test/test/issues/7',
      state: 'closed',
      // An empty body is a reported value, not "unknown".
      description: '',
    });
  });

  it('session:start resets an issue section enriched by a previous session', () => {
    const enriched = reduceSessionEvent(startedSnapshot(), {
      type: 'issue:update',
      at: '2026-08-03T12:00:02Z',
      number: 22,
      title: 'Old title',
      description: 'Old body',
      labels: ['stale'],
      state: 'open',
    });

    const restarted = reduceSessionEvent(enriched, {
      type: 'session:start',
      at: '2026-08-03T13:00:00Z',
      sessionId: 'def',
      issueNumber: 23,
      phases: ['init'],
    });

    expect(restarted.issue).toEqual({
      number: 23,
      url: null,
      title: null,
      description: null,
      labels: [],
      state: null,
    });
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
    expect(prd?.harnessExecutionMs).toBeNull();
    expect(prd?.orchestrationOverheadMs).toBeNull();
    expect(snap.currentPhase).toBeNull();
    expect(snap.progress.phasesCompleted).toBe(1);
    expect(snap.progress.percent).toBe(33);
  });

  it('phase:end records harness vs orchestration timing when published', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'phase:start',
      at: '2026-08-03T12:00:05Z',
      phase: 'execute',
    });
    snap = reduceSessionEvent(snap, {
      type: 'phase:end',
      at: '2026-08-03T12:09:06Z',
      phase: 'execute',
      success: true,
      harnessExecutionMs: 541_000,
      orchestrationOverheadMs: 2000,
      harnessStartupMs: 3600,
      ttftMs: 2100,
      attemptCount: 1,
      retryDurationMs: null,
    });
    expect(snap.phases.find((p) => p.name === 'execute')).toMatchObject({
      harnessExecutionMs: 541_000,
      orchestrationOverheadMs: 2000,
      harnessStartupMs: 3600,
      ttftMs: 2100,
      attemptCount: 1,
      retryDurationMs: null,
    });
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

  it('iteration:start marks the active story executing and the rest pending', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory({ id: 'US-001' }), makeStory({ id: 'US-002', priority: 2 })],
    });

    snap = reduceSessionEvent(snap, {
      type: 'iteration:start',
      at: '2026-08-03T12:02:00Z',
      iteration: 1,
      storyId: 'US-001',
    });
    expect(snap.stories.map((s) => [s.id, s.stage])).toEqual([
      ['US-001', 'executing'],
      ['US-002', 'pending'],
    ]);
    expect(snap.stories[0].stageSince).toBe('2026-08-03T12:02:00Z');

    // The turn moves to US-002 on the next iteration: US-001 reverts to
    // pending, US-002 becomes executing.
    snap = reduceSessionEvent(snap, {
      type: 'iteration:start',
      at: '2026-08-03T12:03:00Z',
      iteration: 2,
      storyId: 'US-002',
    });
    expect(snap.stories.map((s) => [s.id, s.stage])).toEqual([
      ['US-001', 'pending'],
      ['US-002', 'executing'],
    ]);
  });

  it('iteration:start on the same story again keeps its original stageSince', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory({ id: 'US-001' })],
    });
    snap = reduceSessionEvent(snap, {
      type: 'iteration:start',
      at: '2026-08-03T12:02:00Z',
      iteration: 1,
      storyId: 'US-001',
    });
    const first = snap;
    snap = reduceSessionEvent(snap, {
      type: 'iteration:start',
      at: '2026-08-03T12:05:00Z',
      iteration: 2,
      storyId: 'US-001',
    });
    expect(snap.stories[0].stage).toBe('executing');
    expect(snap.stories[0].stageSince).toBe('2026-08-03T12:02:00Z');
    // No churn: the story object itself is unchanged when the stage does not.
    expect(snap.stories[0]).toBe(first.stories[0]);
  });

  it('iteration:start never touches an already-passing story', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [
        makeStory({ id: 'US-001', passes: true }),
        makeStory({ id: 'US-002', priority: 2 }),
      ],
    });
    expect(snap.stories[0].stage).toBe('awaiting_review');

    snap = reduceSessionEvent(snap, {
      type: 'iteration:start',
      at: '2026-08-03T12:02:00Z',
      iteration: 1,
      storyId: 'US-002',
    });
    expect(snap.stories[0].stage).toBe('awaiting_review');
    expect(snap.stories[1].stage).toBe('executing');
  });

  it('iteration:start populates currentActivity.story, finally filled during execute', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory({ id: 'US-001' })],
    });
    expect(snap.currentActivity).toBeNull();

    snap = reduceSessionEvent(snap, {
      type: 'iteration:start',
      at: '2026-08-03T12:02:00Z',
      iteration: 1,
      storyId: 'US-001',
    });
    expect(snap.currentActivity).toEqual({
      story: 'US-001',
      tool: null,
      detail: null,
      since: '2026-08-03T12:02:00Z',
    });
  });

  it('iteration:start without a storyId leaves stories and currentActivity untouched', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory({ id: 'US-001' })],
    });
    const before = snap;
    snap = reduceSessionEvent(snap, {
      type: 'iteration:start',
      at: '2026-08-03T12:02:00Z',
      iteration: 1,
    });
    expect(snap.stories[0].stage).toBe('pending');
    expect(snap.currentActivity).toBeNull();
    expect(snap.stories[0]).toBe(before.stories[0]);
  });

  it('a story flips to awaiting_review the moment it starts passing', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory({ id: 'US-001' })],
    });
    snap = reduceSessionEvent(snap, {
      type: 'iteration:start',
      at: '2026-08-03T12:02:00Z',
      iteration: 1,
      storyId: 'US-001',
    });
    expect(snap.stories[0].stage).toBe('executing');

    snap = reduceSessionEvent(snap, {
      type: 'stories:update',
      at: '2026-08-03T12:03:00Z',
      stories: [makeStory({ id: 'US-001', passes: true })],
    });
    expect(snap.stories[0].stage).toBe('awaiting_review');
    expect(snap.stories[0].stageSince).toBe('2026-08-03T12:03:00Z');

    // Already passing on a later update: the stage is left alone.
    snap = reduceSessionEvent(snap, {
      type: 'stories:update',
      at: '2026-08-03T12:04:00Z',
      stories: [makeStory({ id: 'US-001', passes: true })],
    });
    expect(snap.stories[0].stage).toBe('awaiting_review');
    expect(snap.stories[0].stageSince).toBe('2026-08-03T12:03:00Z');
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
        status: 'done',
        dependencies: [],
        description: 'Test story',
        acceptanceCriteria: ['Criterion 1'],
        durationSeconds: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
        // First seen already passing: real completion moment unknown, so
        // this is treated the same as "just flipped" for stage purposes.
        stage: 'awaiting_review',
        stageSince: '2026-08-03T12:01:00Z',
        stageDetail: null,
        history: [],
      },
      {
        id: 'US-002',
        title: 'Second',
        priority: 2,
        passes: false,
        completedAt: null,
        status: 'backlog',
        dependencies: [],
        description: 'Test story',
        acceptanceCriteria: ['Criterion 1'],
        durationSeconds: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
        stage: 'pending',
        stageSince: '2026-08-03T12:01:00Z',
        stageDetail: null,
        history: [],
      },
    ]);
    expect(snap.progress.storiesCompleted).toBe(1);
    expect(snap.progress.storiesTotal).toBe(2);
  });

  it('session:start wipes the stories, so a seed only survives when published after it', () => {
    const seededTooEarly = reduceSessionEvent(createInitialSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T11:59:00Z',
      stories: [makeStory({ id: 'US-001' })],
    });
    expect(seededTooEarly.stories).toHaveLength(1);

    // session:start rebuilds from createInitialSnapshot(): anything published
    // before it is thrown away. This is why run.ts seeds the plan's stories
    // right *after* publishSessionStart().
    const restarted = reduceSessionEvent(seededTooEarly, {
      type: 'session:start',
      at: '2026-08-03T12:00:00Z',
      sessionId: 'abc',
      issueNumber: 22,
      phases: ['init', 'prd', 'execute'],
    });
    expect(restarted.stories).toEqual([]);
    expect(restarted.progress.storiesTotal).toBe(0);

    const seeded = reduceSessionEvent(restarted, {
      type: 'stories:update',
      at: '2026-08-03T12:00:01Z',
      stories: [
        makeStory({ id: 'US-001', passes: true }),
        makeStory({ id: 'US-002', priority: 2 }),
      ],
    });
    expect(seeded.stories.map((s) => s.id)).toEqual(['US-001', 'US-002']);
    expect(seeded.progress.storiesTotal).toBe(2);
    expect(seeded.progress.storiesCompleted).toBe(1);
    // Passing before the session started: the duration is unknown, not zero.
    expect(seeded.stories[0].completedAt).toBeNull();
    // The seed is stories-only; the phase counters stay where session:start
    // left them, so the percentage never regresses because of it.
    expect(seeded.progress.percent).toBe(restarted.progress.percent);
  });

  it('derives in_progress from the current activity and back to backlog when it moves on', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory({ id: 'US-001' }), makeStory({ id: 'US-002', priority: 2 })],
    });
    expect(snap.stories.map((s) => s.status)).toEqual(['backlog', 'backlog']);

    snap = reduceSessionEvent(snap, {
      type: 'activity',
      at: '2026-08-03T12:02:00Z',
      story: 'US-001',
      tool: 'Edit',
    });
    expect(snap.stories.map((s) => s.status)).toEqual(['in_progress', 'backlog']);

    // The derivation is recomputed from scratch on every reduction, so moving
    // the activity elsewhere releases the previous story instead of latching.
    snap = reduceSessionEvent(snap, {
      type: 'activity',
      at: '2026-08-03T12:03:00Z',
      story: 'US-002',
      tool: 'Edit',
    });
    expect(snap.stories.map((s) => s.status)).toEqual(['backlog', 'in_progress']);

    snap = reduceSessionEvent(snap, {
      type: 'stories:update',
      at: '2026-08-03T12:04:00Z',
      stories: [
        makeStory({ id: 'US-001', passes: true }),
        makeStory({ id: 'US-002', priority: 2 }),
      ],
    });
    expect(snap.stories.map((s) => s.status)).toEqual(['done', 'in_progress']);
  });

  it('keeps an explicit in_review but never honours an explicit done without passes', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [
        makeStory({ id: 'US-001', status: 'in_review' }),
        makeStory({ id: 'US-002', priority: 2, status: 'done' }),
      ],
    });
    // in_review has no automatic derivation, so the plan's value survives;
    // done is overruled by passes: false.
    expect(snap.stories.map((s) => s.status)).toEqual(['in_review', 'backlog']);

    // in_review outranks the activity, but not a story that starts passing.
    snap = reduceSessionEvent(snap, {
      type: 'activity',
      at: '2026-08-03T12:02:00Z',
      story: 'US-001',
      tool: 'Edit',
    });
    expect(snap.stories[0].status).toBe('in_review');

    snap = reduceSessionEvent(snap, {
      type: 'stories:update',
      at: '2026-08-03T12:03:00Z',
      stories: [
        makeStory({ id: 'US-001', status: 'in_review', passes: true }),
        makeStory({ id: 'US-002', priority: 2, status: 'done' }),
      ],
    });
    expect(snap.stories[0].status).toBe('done');
  });

  it('stories:update copies dependencies from the plan, defaulting to an empty array', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [
        makeStory({ id: 'US-001' }),
        makeStory({ id: 'US-002', priority: 2, dependencies: ['US-001'] }),
      ],
    });
    expect(snap.stories.map((s) => s.dependencies)).toEqual([[], ['US-001']]);
  });

  it('stories:update copies the description and acceptance criteria from the plan', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [
        makeStory({
          id: 'US-001',
          description: 'Render the board',
          acceptanceCriteria: ['Four columns', 'Empty state per column'],
        }),
      ],
    });
    expect(snap.stories[0]).toMatchObject({
      description: 'Render the board',
      acceptanceCriteria: ['Four columns', 'Empty state per column'],
    });
  });

  it('stories:update keeps the description and acceptance criteria across publications', () => {
    const story = makeStory({
      id: 'US-001',
      description: 'Render the board',
      acceptanceCriteria: ['Four columns'],
    });
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [story],
    });
    snap = reduceSessionEvent(snap, {
      type: 'stories:update',
      at: '2026-08-03T12:02:00Z',
      stories: [{ ...story, passes: true }],
    });
    expect(snap.stories[0]).toMatchObject({
      passes: true,
      description: 'Render the board',
      acceptanceCriteria: ['Four columns'],
    });
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

  it('projects per-invocation history and sanitized process output for detail views', () => {
    let snap = startedSnapshot();
    const execution = {
      id: 'exec-1',
      sessionId: 'abc',
      purpose: 'execute' as const,
      attempt: 1,
      trigger: 'initial' as const,
      triggerReason: null,
      agent: {
        harness: 'codex-cli',
        provider: 'openai',
        model: { requested: 'gpt-5', resolved: 'gpt-5', source: 'config' as const },
        providerSessionId: null,
      },
      startedAt: '2026-08-03T12:01:00Z',
      finishedAt: null,
      durationMs: null,
      usage: null,
      cost: { status: 'unknown' as const, reason: 'not_reported' as const },
      status: 'running' as const,
      failure: null,
      storyIds: ['US-001'],
    };
    snap = reduceSessionEvent(snap, {
      type: 'execution:update',
      at: execution.startedAt,
      execution,
    });
    snap = reduceSessionEvent(
      snap,
      {
        type: 'process:output',
        at: '2026-08-03T12:01:01Z',
        phase: 'execute',
        executionId: execution.id,
        provider: 'codex',
        stream: 'combined',
        message: '\u001b[32mrunning tests\u001b[0m',
      },
      { logLimit: 10 },
    );
    expect(snap.executions).toEqual([execution]);
    expect(snap.processLogs).toEqual([
      expect.objectContaining({ executionId: 'exec-1', message: 'running tests' }),
    ]);
  });

  it('retains each real story stage transition in order', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory()],
    });
    snap = reduceSessionEvent(snap, {
      type: 'iteration:start',
      at: '2026-08-03T12:02:00Z',
      iteration: 1,
      storyId: 'US-001',
    });
    snap = reduceSessionEvent(snap, {
      type: 'stories:update',
      at: '2026-08-03T12:03:00Z',
      stories: [makeStory({ passes: true })],
    });
    expect(snap.stories[0]?.history.map((entry) => entry.stage)).toEqual([
      'executing',
      'awaiting_review',
    ]);
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

  describe('review/correction stage transitions', () => {
    function completedSeed(): SessionSnapshot {
      // Every story already passing, as the pipeline guarantees by the time
      // `review` starts.
      return reduceSessionEvent(startedSnapshot(), {
        type: 'stories:update',
        at: '2026-08-03T12:01:00Z',
        stories: [
          makeStory({ id: 'US-001', passes: true }),
          makeStory({ id: 'US-002', priority: 2, passes: true }),
        ],
      });
    }

    it('normal completion: awaiting_review -> in_review -> done', () => {
      let snap = completedSeed();
      expect(snap.stories.map((s) => s.stage)).toEqual(['awaiting_review', 'awaiting_review']);

      snap = reduceSessionEvent(snap, {
        type: 'phase:start',
        at: '2026-08-03T12:02:00Z',
        phase: 'review',
      });
      expect(snap.stories.map((s) => s.stage)).toEqual(['in_review', 'in_review']);
      expect(snap.stories[0].stageSince).toBe('2026-08-03T12:02:00Z');

      snap = reduceSessionEvent(snap, {
        type: 'phase:end',
        at: '2026-08-03T12:03:00Z',
        phase: 'review',
        success: true,
      });
      expect(snap.stories.map((s) => s.stage)).toEqual(['done', 'done']);
      expect(snap.stories[0].stageSince).toBe('2026-08-03T12:03:00Z');
      expect(snap.stories[0].stageDetail).toBeNull();
    });

    it('one correction cycle: in_review -> in_correction (with cycle detail) -> done', () => {
      let snap = completedSeed();
      snap = reduceSessionEvent(snap, {
        type: 'phase:start',
        at: '2026-08-03T12:02:00Z',
        phase: 'review',
      });
      expect(snap.stories.map((s) => s.stage)).toEqual(['in_review', 'in_review']);

      snap = reduceSessionEvent(snap, {
        type: 'correction:cycle',
        at: '2026-08-03T12:03:00Z',
        cycle: 1,
        maxCycles: 3,
      });
      expect(snap.stories.map((s) => s.stage)).toEqual(['in_correction', 'in_correction']);
      expect(snap.stories.map((s) => s.stageDetail)).toEqual(['Cycle 1/3', 'Cycle 1/3']);

      // Re-execute publishes no new stories:update flip (every story already
      // passes), and the pipeline only ever emits one phase:start/phase:end
      // pair for the whole review+correction sequence — success arrives
      // straight from 'in_correction'.
      snap = reduceSessionEvent(snap, {
        type: 'phase:end',
        at: '2026-08-03T12:05:00Z',
        phase: 'review',
        success: true,
      });
      expect(snap.stories.map((s) => s.stage)).toEqual(['done', 'done']);
      expect(snap.stories.map((s) => s.stageDetail)).toEqual([null, null]);
    });

    it('final failure after exhausting correction cycles moves every non-done story to failed', () => {
      let snap = completedSeed();
      snap = reduceSessionEvent(snap, {
        type: 'phase:start',
        at: '2026-08-03T12:02:00Z',
        phase: 'review',
      });
      snap = reduceSessionEvent(snap, {
        type: 'correction:cycle',
        at: '2026-08-03T12:03:00Z',
        cycle: 3,
        maxCycles: 3,
      });

      snap = reduceSessionEvent(snap, {
        type: 'phase:end',
        at: '2026-08-03T12:06:00Z',
        phase: 'review',
        success: false,
        error: 'Review failed after 3 correction cycles',
      });
      expect(snap.stories.map((s) => s.stage)).toEqual(['failed', 'failed']);
      expect(snap.stories[0].stageSince).toBe('2026-08-03T12:06:00Z');
    });

    it('phase:start for a phase other than review never touches story stage', () => {
      const seed = completedSeed();
      const snap = reduceSessionEvent(seed, {
        type: 'phase:start',
        at: '2026-08-03T12:02:00Z',
        phase: 'pr',
      });
      // Every entry keeps identity — only status re-derivation may rebuild
      // the wrapping array, never the individual story objects.
      expect(snap.stories[0]).toBe(seed.stories[0]);
      expect(snap.stories[1]).toBe(seed.stories[1]);
      expect(snap.stories.map((s) => s.stage)).toEqual(['awaiting_review', 'awaiting_review']);
    });

    it('phase:end for a phase other than review never touches story stage', () => {
      let seed = completedSeed();
      seed = reduceSessionEvent(seed, {
        type: 'phase:start',
        at: '2026-08-03T12:02:00Z',
        phase: 'pr',
      });
      const snap = reduceSessionEvent(seed, {
        type: 'phase:end',
        at: '2026-08-03T12:03:00Z',
        phase: 'pr',
        success: true,
      });
      expect(snap.stories[0]).toBe(seed.stories[0]);
      expect(snap.stories[1]).toBe(seed.stories[1]);
      expect(snap.stories.map((s) => s.stage)).toEqual(['awaiting_review', 'awaiting_review']);
    });

    it('a story that never passed is the one marked failed when review gives up', () => {
      // A resumed run can reach `review` with a story still not passing.
      let snap = reduceSessionEvent(startedSnapshot(), {
        type: 'stories:update',
        at: '2026-08-03T12:01:00Z',
        stories: [
          makeStory({ id: 'US-001', passes: true }),
          makeStory({ id: 'US-002', priority: 2, passes: false }),
        ],
      });
      snap = reduceSessionEvent(snap, {
        type: 'phase:start',
        at: '2026-08-03T12:02:00Z',
        phase: 'review',
      });
      snap = reduceSessionEvent(snap, {
        type: 'phase:end',
        at: '2026-08-03T12:06:00Z',
        phase: 'review',
        success: false,
        error: 'Review failed after 3 correction cycles',
      });

      // Not just the passing ones: the story that never got there is failed too.
      expect(snap.stories.map((s) => s.stage)).toEqual(['failed', 'failed']);
    });

    it('a failing phase outside review still closes the executing stage', () => {
      let snap = reduceSessionEvent(startedSnapshot(), {
        type: 'stories:update',
        at: '2026-08-03T12:01:00Z',
        stories: [makeStory({ id: 'US-001', passes: false })],
      });
      snap = reduceSessionEvent(snap, {
        type: 'iteration:start',
        at: '2026-08-03T12:02:00Z',
        iteration: 1,
        storyId: 'US-001',
      });
      expect(snap.stories[0].stage).toBe('executing');

      snap = reduceSessionEvent(snap, {
        type: 'phase:end',
        at: '2026-08-03T12:09:00Z',
        phase: 'execute',
        success: false,
        error: 'fatal claude failure',
      });
      expect(snap.stories[0].stage).toBe('failed');
      expect(snap.stories[0].stageSince).toBe('2026-08-03T12:09:00Z');
    });

    it('session:end never leaves a story frozen mid-flight', () => {
      let snap = reduceSessionEvent(startedSnapshot(), {
        type: 'stories:update',
        at: '2026-08-03T12:01:00Z',
        stories: [
          makeStory({ id: 'US-001', passes: true }),
          makeStory({ id: 'US-002', priority: 2, passes: false }),
        ],
      });
      snap = reduceSessionEvent(snap, {
        type: 'iteration:start',
        at: '2026-08-03T12:02:00Z',
        iteration: 3,
        storyId: 'US-002',
      });
      expect(snap.stories.map((s) => s.stage)).toEqual(['awaiting_review', 'executing']);

      snap = reduceSessionEvent(snap, {
        type: 'session:end',
        at: '2026-08-03T12:20:00Z',
        status: 'failed',
        error: 'fatal claude failure',
      });
      // The panel must not keep showing "executing" for a run that is over.
      expect(snap.stories.map((s) => s.stage)).toEqual(['failed', 'failed']);
      expect(snap.stories[1].stageSince).toBe('2026-08-03T12:20:00Z');
    });

    it('session:end on a completed run settles passing stories as done', () => {
      let snap = completedSeed();
      snap = reduceSessionEvent(snap, {
        type: 'session:end',
        at: '2026-08-03T12:20:00Z',
        status: 'completed',
      });
      expect(snap.stories.map((s) => s.stage)).toEqual(['done', 'done']);
    });

    it('session:end keeps a stage that already settled', () => {
      let snap = completedSeed();
      snap = reduceSessionEvent(snap, {
        type: 'phase:start',
        at: '2026-08-03T12:02:00Z',
        phase: 'review',
      });
      snap = reduceSessionEvent(snap, {
        type: 'phase:end',
        at: '2026-08-03T12:03:00Z',
        phase: 'review',
        success: true,
      });
      const settled = snap.stories;
      snap = reduceSessionEvent(snap, {
        type: 'session:end',
        at: '2026-08-03T12:20:00Z',
        status: 'failed',
        error: 'PR creation failed',
      });
      expect(snap.stories[0]).toBe(settled[0]);
      expect(snap.stories.map((s) => s.stage)).toEqual(['done', 'done']);
    });
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

  it('metrics:update with scope phase accumulates on the phase and the aggregate', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'metrics:update',
      at: '2026-08-03T12:01:00Z',
      scope: 'phase',
      phase: 'prd',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5000,
      cacheCreationTokens: 300,
      costUsd: 0.12,
    });
    // A second invocation of the same phase sums onto the first.
    snap = reduceSessionEvent(snap, {
      type: 'metrics:update',
      at: '2026-08-03T12:02:00Z',
      scope: 'phase',
      phase: 'prd',
      inputTokens: 50,
      outputTokens: 10,
      costUsd: 0.03,
    });

    const prd = snap.phases.find((p) => p.name === 'prd');
    expect(prd?.inputTokens).toBe(150);
    expect(prd?.outputTokens).toBe(30);
    expect(prd?.cacheReadTokens).toBe(5000);
    expect(prd?.cacheCreationTokens).toBe(300);
    expect(prd?.costUsd).toBeCloseTo(0.15, 10);
    expect(snap.metrics.totalInputTokens).toBe(150);
    expect(snap.metrics.totalOutputTokens).toBe(30);
    expect(snap.metrics.totalCacheReadTokens).toBe(5000);
    expect(snap.metrics.totalCacheCreationTokens).toBe(300);
    expect(snap.metrics.totalCostUsd).toBeCloseTo(0.15, 10);

    // Untouched phases stay null — never zero.
    expect(snap.phases.find((p) => p.name === 'execute')?.inputTokens).toBeNull();
  });

  it('metrics:update with scope iteration accumulates on the named phase and the aggregate', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'metrics:update',
      at: '2026-08-03T12:05:00Z',
      scope: 'iteration',
      phase: 'execute',
      iteration: 1,
      inputTokens: 900,
      outputTokens: 120,
      costUsd: 0.5,
      durationSeconds: 42,
    });
    const execute = snap.phases.find((p) => p.name === 'execute');
    expect(execute?.inputTokens).toBe(900);
    expect(execute?.outputTokens).toBe(120);
    expect(execute?.costUsd).toBe(0.5);
    // phase:start/phase:end remain the only source of a phase's duration.
    expect(execute?.durationSeconds).toBeNull();
    expect(snap.metrics.totalInputTokens).toBe(900);
    expect(snap.metrics.totalCostUsd).toBe(0.5);
  });

  it('metrics:update with scope story touches only the story, never the phase or the aggregate', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory({ id: 'US-001' }), makeStory({ id: 'US-002', priority: 2 })],
    });
    snap = reduceSessionEvent(snap, {
      type: 'metrics:update',
      at: '2026-08-03T12:06:00Z',
      scope: 'story',
      storyId: 'US-001',
      inputTokens: 400,
      outputTokens: 60,
      costUsd: 0.25,
      durationSeconds: 21,
    });

    const story = snap.stories.find((s) => s.id === 'US-001');
    expect(story?.inputTokens).toBe(400);
    expect(story?.outputTokens).toBe(60);
    expect(story?.costUsd).toBe(0.25);
    expect(story?.durationSeconds).toBe(21);

    expect(snap.stories.find((s) => s.id === 'US-002')?.inputTokens).toBeNull();
    expect(snap.phases.every((p) => p.inputTokens === null)).toBe(true);
    expect(snap.metrics.totalInputTokens).toBeNull();
    expect(snap.metrics.totalCostUsd).toBeNull();
  });

  it('metrics:update does not double count iteration and story events of the same cycle', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory({ id: 'US-001', passes: true })],
    });
    snap = reduceSessionEvent(snap, {
      type: 'metrics:update',
      at: '2026-08-03T12:06:00Z',
      scope: 'story',
      storyId: 'US-001',
      inputTokens: 1000,
      costUsd: 1,
    });
    snap = reduceSessionEvent(snap, {
      type: 'metrics:update',
      at: '2026-08-03T12:06:01Z',
      scope: 'iteration',
      phase: 'execute',
      iteration: 1,
      inputTokens: 1000,
      costUsd: 1,
    });
    expect(snap.metrics.totalInputTokens).toBe(1000);
    expect(snap.metrics.totalCostUsd).toBe(1);
    expect(snap.phases.find((p) => p.name === 'execute')?.inputTokens).toBe(1000);
    expect(snap.stories[0].inputTokens).toBe(1000);
  });

  it('metrics:update accumulated on a story survives later stories:update events', () => {
    let snap = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory({ id: 'US-001', passes: true })],
    });
    snap = reduceSessionEvent(snap, {
      type: 'metrics:update',
      at: '2026-08-03T12:06:00Z',
      scope: 'story',
      storyId: 'US-001',
      inputTokens: 400,
      durationSeconds: 10,
    });
    snap = reduceSessionEvent(snap, {
      type: 'stories:update',
      at: '2026-08-03T12:07:00Z',
      stories: [makeStory({ id: 'US-001', passes: true })],
    });
    expect(snap.stories[0].inputTokens).toBe(400);
    expect(snap.stories[0].durationSeconds).toBe(10);
  });

  it('metrics:update whose target does not exist is ignored without error', () => {
    const base = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory({ id: 'US-001' })],
    });

    const unknownPhase = reduceSessionEvent(base, {
      type: 'metrics:update',
      at: '2026-08-03T12:06:00Z',
      scope: 'phase',
      phase: 'nonexistent',
      inputTokens: 99,
    });
    expect(unknownPhase).toBe(base);

    const unknownStory = reduceSessionEvent(base, {
      type: 'metrics:update',
      at: '2026-08-03T12:06:00Z',
      scope: 'story',
      storyId: 'US-404',
      inputTokens: 99,
    });
    expect(unknownStory).toBe(base);

    const noTarget = reduceSessionEvent(base, {
      type: 'metrics:update',
      at: '2026-08-03T12:06:00Z',
      scope: 'phase',
      inputTokens: 99,
    });
    expect(noTarget).toBe(base);
  });

  it('metrics:update leaves never-reported fields null instead of zeroing them', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'metrics:update',
      at: '2026-08-03T12:06:00Z',
      scope: 'phase',
      phase: 'prd',
      inputTokens: 0,
    });
    const prd = snap.phases.find((p) => p.name === 'prd');
    // An explicitly reported zero is a value; the rest was never reported.
    expect(prd?.inputTokens).toBe(0);
    expect(prd?.outputTokens).toBeNull();
    expect(prd?.costUsd).toBeNull();
    expect(snap.metrics.totalInputTokens).toBe(0);
    expect(snap.metrics.totalCostUsd).toBeNull();
  });

  it('metrics:update does not mutate the input snapshot', () => {
    const before = reduceSessionEvent(startedSnapshot(), {
      type: 'stories:update',
      at: '2026-08-03T12:01:00Z',
      stories: [makeStory({ id: 'US-001' })],
    });
    const frozen = JSON.parse(JSON.stringify(before));
    reduceSessionEvent(before, {
      type: 'metrics:update',
      at: '2026-08-03T12:06:00Z',
      scope: 'phase',
      phase: 'prd',
      inputTokens: 10,
      costUsd: 0.01,
    });
    reduceSessionEvent(before, {
      type: 'metrics:update',
      at: '2026-08-03T12:06:00Z',
      scope: 'story',
      storyId: 'US-001',
      inputTokens: 10,
    });
    expect(before).toEqual(frozen);
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

  it('fills the repository section from the same publication', () => {
    const snap = reduceSessionEvent(startedSnapshot(), {
      type: 'git:update',
      at: '2026-08-03T12:05:00Z',
      branch: 'issue/22-test',
      baseBranch: 'main',
      repositoryName: 'acme/repo',
      remoteUrl: 'git@github.com:acme/repo.git',
      headCommit: 'c56b163',
      repositoryRoot: '/repo/root',
    });

    expect(snap.repository).toEqual({
      name: 'acme/repo',
      remoteUrl: 'git@github.com:acme/repo.git',
      branch: 'issue/22-test',
      headCommit: 'c56b163',
      root: '/repo/root',
    });
  });

  it('distinguishes an omitted repository field from one reported as null', () => {
    const enriched = reduceSessionEvent(startedSnapshot(), {
      type: 'git:update',
      at: '2026-08-03T12:05:00Z',
      repositoryName: 'acme/repo',
      headCommit: 'c56b163',
      repositoryRoot: '/repo/root',
    });
    const snap = reduceSessionEvent(enriched, {
      type: 'git:update',
      at: '2026-08-03T12:06:00Z',
      // Collected and unavailable this time: it must overwrite.
      headCommit: null,
      // Not collected at all: the previous value stands.
    });

    expect(snap.repository).toMatchObject({
      name: 'acme/repo',
      headCommit: null,
      root: '/repo/root',
    });
  });
});
