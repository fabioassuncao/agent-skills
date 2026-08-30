import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeResult, EngineConfig, ResolvedPaths, TaskPlan, UserStory } from '../types.js';

// Instant sleep: the real one is a 2s setTimeout per loop iteration, which
// would make a "one pending-correction iteration" test take multiple real
// seconds for no benefit.
vi.mock('../utils/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/retry.js')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

// Git/gh enrichment spawns subprocesses as soon as a real publisher is
// installed; it carries no engine logic worth exercising here.
vi.mock('./session-git.js', () => ({ publishGitState: vi.fn(async () => {}) }));

// Lets a single test make one specific write fail, to prove that persisting
// story metrics can never change the outcome of an iteration.
const writeFailure = vi.hoisted(() => ({ whenContaining: null as string | null }));
vi.mock('../utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/fs.js')>();
  return {
    ...actual,
    writeFileAtomic: vi.fn(async (path: string, content: string) => {
      if (writeFailure.whenContaining !== null && content.includes(writeFailure.whenContaining)) {
        throw new Error('ENOSPC: no space left on device');
      }
      await actual.writeFileAtomic(path, content);
    }),
  };
});

const claudeResult = vi.hoisted(() => ({
  current: { exitCode: 0, output: '', cost: null } as ClaudeResult,
}));
vi.mock('./executor.js', () => ({
  executeClaude: vi.fn(async () => claudeResult.current),
}));

const { executeClaude } = await import('./executor.js');
const { commitPlaceholders, runEngine } = await import('./engine.js');
const { setSessionPublisher } = await import('./session-publisher.js');
const { MemoryPublisher } = await import('./session-state.js');
type SessionEvent = import('./session-state.js').SessionEvent;
type MetricsEvent = Extract<SessionEvent, { type: 'metrics:update' }>;

const mockExecuteClaude = vi.mocked(executeClaude);

function makePlan(overrides?: Partial<TaskPlan>): TaskPlan {
  return {
    project: 'test',
    issueNumber: 42,
    issueUrl: 'https://github.com/acme/repo/issues/42',
    branchName: 'issue/42-sample',
    description: 'Test plan',
    issueStatus: 'completed',
    completedAt: '2026-01-02T00:00:00Z',
    lastAttemptAt: '2026-01-02T00:00:00Z',
    lastError: null,
    correctionCycle: 1,
    maxCorrectionCycles: 3,
    lastReviewFindings: null,
    pipeline: {
      prdCompleted: true,
      jsonCompleted: true,
      executionCompleted: true,
      reviewCompleted: false,
      prCreated: false,
    },
    userStories: [
      {
        id: 'US-001',
        title: 'First story',
        description: 'Test story',
        acceptanceCriteria: ['Criterion 1'],
        priority: 1,
        passes: true,
        notes: '',
      },
    ],
    ...overrides,
  };
}

const baseConfig: EngineConfig = {
  issueNumber: '42',
  maxIterations: 1,
  retryLimit: 3,
  retryForever: false,
  backoffBaseSeconds: 1,
  backoffMaxSeconds: 1,
};

describe('runEngine — pending-correction guard', () => {
  let tmpDir: string;
  let paths: ResolvedPaths;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'issue-flow-engine-'));
    await mkdir(join(tmpDir, 'archive'), { recursive: true });
    paths = {
      prdFile: join(tmpDir, 'tasks.json'),
      progressFile: join(tmpDir, 'progress.txt'),
      archiveDir: join(tmpDir, 'archive'),
      lastBranchFile: join(tmpDir, '.last-branch'),
      projectRoot: tmpDir,
    };
    mockExecuteClaude.mockClear();
    writeFailure.whenContaining = null;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writePlan(plan: TaskPlan): Promise<void> {
    await writeFile(paths.prdFile, JSON.stringify(plan, null, 2), 'utf-8');
  }

  async function readPlan(): Promise<TaskPlan> {
    return JSON.parse(await readFile(paths.prdFile, 'utf-8'));
  }

  it('exits immediately without invoking Claude when the issue is complete and there is no pending correction', async () => {
    await writePlan(makePlan({ lastReviewFindings: null }));

    const code = await runEngine(baseConfig, paths);

    expect(code).toBe(0);
    expect(mockExecuteClaude).not.toHaveBeenCalled();
  });

  it('invokes Claude when every story passes but a review failure is still pending', async () => {
    await writePlan(
      makePlan({ lastReviewFindings: 'getRemoteUrl() ignores the projectRoot argument' }),
    );
    claudeResult.current = { exitCode: 0, output: 'working on it', cost: null };

    const code = await runEngine(baseConfig, paths);

    expect(mockExecuteClaude).toHaveBeenCalledTimes(1);
    // maxIterations: 1 and the mock never clears lastReviewFindings nor signals
    // completion, so the run correctly reports "not done yet" rather than 0.
    expect(code).toBe(1);
  });

  it('does not mark the issue completed on <promise>COMPLETE</promise> while lastReviewFindings is still set', async () => {
    await writePlan(makePlan({ lastReviewFindings: 'stale finding the agent forgot to clear' }));
    claudeResult.current = { exitCode: 0, output: '<promise>COMPLETE</promise>', cost: null };

    const code = await runEngine(baseConfig, paths);

    expect(code).toBe(1);
    const plan = await readPlan();
    expect(plan.issueStatus).not.toBe('completed');
    expect(plan.lastError?.category).toBe('invalid_completion_signal');
  });

  it('marks the issue completed on <promise>COMPLETE</promise> once lastReviewFindings is cleared', async () => {
    // Simulate the agent picking up a pending-correction plan, fixing it, and
    // clearing the field itself before signaling completion.
    await writePlan(makePlan({ lastReviewFindings: 'will be cleared by the mocked agent' }));
    claudeResult.current = {
      exitCode: 0,
      output: '<promise>COMPLETE</promise>',
      cost: null,
    };
    mockExecuteClaude.mockImplementationOnce(async () => {
      const plan = await readPlan();
      plan.lastReviewFindings = null;
      await writePlan(plan);
      return claudeResult.current;
    });

    const code = await runEngine(baseConfig, paths);

    expect(code).toBe(0);
    const plan = await readPlan();
    expect(plan.issueStatus).toBe('completed');
    expect(plan.lastReviewFindings).toBeNull();
  });
});

/** Keeps every published event so the tests can assert on payload and order. */
class RecordingPublisher extends MemoryPublisher {
  readonly events: SessionEvent[] = [];

  protected override afterPublish(event: SessionEvent): void {
    this.events.push(event);
  }
}

function makeStory(id: string, priority: number, passes: boolean): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: '',
    acceptanceCriteria: ['Criterion 1'],
    priority,
    passes,
    notes: '',
  };
}

describe('runEngine — execute-phase metrics', () => {
  let tmpDir: string;
  let paths: ResolvedPaths;
  let publisher: RecordingPublisher;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'issue-flow-engine-metrics-'));
    await mkdir(join(tmpDir, 'archive'), { recursive: true });
    paths = {
      prdFile: join(tmpDir, 'tasks.json'),
      progressFile: join(tmpDir, 'progress.txt'),
      archiveDir: join(tmpDir, 'archive'),
      lastBranchFile: join(tmpDir, '.last-branch'),
      projectRoot: tmpDir,
    };
    mockExecuteClaude.mockClear();
    writeFailure.whenContaining = null;

    publisher = new RecordingPublisher({ onWarn: () => {} });
    setSessionPublisher(publisher);
    publisher.publish({
      type: 'session:start',
      at: '2026-01-01T00:00:00Z',
      sessionId: 's1',
      issueNumber: 42,
      phases: ['execute'],
    });
  });

  afterEach(async () => {
    setSessionPublisher(undefined);
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writePlan(plan: TaskPlan): Promise<void> {
    await writeFile(paths.prdFile, JSON.stringify(plan, null, 2), 'utf-8');
  }

  async function readPlan(): Promise<TaskPlan> {
    return JSON.parse(await readFile(paths.prdFile, 'utf-8'));
  }

  function metricsEvents(): MetricsEvent[] {
    return publisher.events.filter((e): e is MetricsEvent => e.type === 'metrics:update');
  }

  function pendingPlan(...stories: UserStory[]): TaskPlan {
    return makePlan({
      issueStatus: 'in_progress',
      completedAt: null,
      pipeline: {
        prdCompleted: true,
        jsonCompleted: true,
        executionCompleted: false,
        reviewCompleted: false,
        prCreated: false,
      },
      userStories: stories,
    });
  }

  /** Mocked agent: flips the given stories to passing, then answers `output`. */
  function agentCompleting(ids: string[], output: string, cost: ClaudeResult['cost']): void {
    mockExecuteClaude.mockImplementationOnce(async () => {
      const plan = await readPlan();
      for (const story of plan.userStories) {
        if (ids.includes(story.id)) story.passes = true;
      }
      await writePlan(plan);
      return { exitCode: 0, output, cost };
    });
  }

  it('publishes iteration:start with the highest-priority pending story, regardless of array order', async () => {
    // US-002 (priority 1, highest) is listed second in the plan on purpose —
    // selectActiveStory must sort by priority, not rely on array order.
    await writePlan(pendingPlan(makeStory('US-001', 2, false), makeStory('US-002', 1, false)));
    agentCompleting(['US-002'], '', { inputTokens: 1 });

    await runEngine(baseConfig, paths);

    const startEvents = publisher.events.filter(
      (e): e is Extract<SessionEvent, { type: 'iteration:start' }> => e.type === 'iteration:start',
    );
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].storyId).toBe('US-002');
  });

  it('omits storyId once every story already passes (pending-correction re-run)', async () => {
    // Every story already passes, but a pending correction still forces the
    // loop to run — selectActiveStory correctly finds nothing to hand off.
    await writePlan(
      makePlan({
        issueStatus: 'in_progress',
        completedAt: null,
        lastReviewFindings: 'stale finding the mocked agent will not clear',
        pipeline: {
          prdCompleted: true,
          jsonCompleted: true,
          executionCompleted: true,
          reviewCompleted: false,
          prCreated: false,
        },
        userStories: [makeStory('US-001', 1, true)],
      }),
    );
    mockExecuteClaude.mockImplementationOnce(async () => ({
      exitCode: 0,
      output: 'working on it',
      cost: null,
    }));

    await runEngine(baseConfig, paths);

    const startEvents = publisher.events.filter(
      (e): e is Extract<SessionEvent, { type: 'iteration:start' }> => e.type === 'iteration:start',
    );
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].storyId).toBeUndefined();
  });

  it('splits the iteration metrics evenly across the stories completed in it', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false), makeStory('US-002', 2, false)));
    agentCompleting(['US-001', 'US-002'], '<promise>COMPLETE</promise>', {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 100,
      costUsd: 1,
    });

    const code = await runEngine(baseConfig, paths);

    expect(code).toBe(0);

    const [first, second, third] = metricsEvents();
    expect(metricsEvents()).toHaveLength(3);
    expect(first).toMatchObject({
      scope: 'story',
      storyId: 'US-001',
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 50,
      costUsd: 0.5,
    });
    expect(second).toMatchObject({
      scope: 'story',
      storyId: 'US-002',
      inputTokens: 5,
      costUsd: 0.5,
    });
    expect(third).toMatchObject({
      scope: 'iteration',
      phase: 'execute',
      iteration: 1,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 100,
      costUsd: 1,
    });

    // Story events are a rateio of what the iteration already counted: the
    // phase and the aggregate must hold the iteration figures, not double.
    const snapshot = publisher.snapshot();
    expect(snapshot.metrics).toMatchObject({
      totalInputTokens: 10,
      totalOutputTokens: 4,
      totalCacheReadTokens: 100,
      totalCostUsd: 1,
    });
    expect(snapshot.phases.find((p) => p.name === 'execute')).toMatchObject({ inputTokens: 10 });
    expect(snapshot.stories.map((s) => s.inputTokens)).toEqual([5, 5]);
  });

  it('publishes story metrics after stories:update and before iteration:end', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    agentCompleting(['US-001'], '<promise>COMPLETE</promise>', { inputTokens: 8 });

    await runEngine(baseConfig, paths);

    const order = publisher.events
      .filter((e) =>
        ['stories:update', 'metrics:update', 'iteration:end'].includes(e.type as string),
      )
      .map((e) => (e.type === 'metrics:update' ? `metrics:${e.scope}` : e.type));
    expect(order).toEqual([
      'stories:update',
      'metrics:story',
      'iteration:end',
      'metrics:iteration',
    ]);
  });

  it('attributes nothing to any story when none completed in the iteration', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    claudeResult.current = { exitCode: 0, output: 'still working', cost: { inputTokens: 7 } };

    const code = await runEngine(baseConfig, paths);

    expect(code).toBe(1);
    expect(metricsEvents()).toHaveLength(1);
    expect(metricsEvents()[0]).toMatchObject({ scope: 'iteration', inputTokens: 7 });
    expect(publisher.snapshot().stories[0].inputTokens).toBeNull();
  });

  it('does not attribute a story that was already passing before the iteration', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, true), makeStory('US-002', 2, false)));
    agentCompleting(['US-002'], '<promise>COMPLETE</promise>', { inputTokens: 6 });

    await runEngine(baseConfig, paths);

    const stories = metricsEvents().filter((e) => e.scope === 'story');
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({ storyId: 'US-002', inputTokens: 6 });
  });

  it('publishes iteration metrics for a fatal failure, without touching any story', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    claudeResult.current = { exitCode: 2, output: 'boom', cost: { inputTokens: 3, costUsd: 0.01 } };

    const code = await runEngine(baseConfig, paths);

    // Flow control unchanged: the CLI's exit code is still what comes back.
    expect(code).toBe(2);
    expect(metricsEvents()).toHaveLength(1);
    expect(metricsEvents()[0]).toMatchObject({
      scope: 'iteration',
      phase: 'execute',
      inputTokens: 3,
      costUsd: 0.01,
    });
    expect((await readPlan()).lastError?.category).toBe('fatal_claude_failure');
  });

  it('keeps the transient retry flow intact and reports one iteration event per attempt', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    claudeResult.current = { exitCode: 75, output: 'rate limit', cost: { inputTokens: 2 } };

    const code = await runEngine({ ...baseConfig, retryLimit: 1 }, paths);

    // Exit code, retry count and error classification are exactly what they
    // were before the instrumentation.
    expect(code).toBe(75);
    expect(mockExecuteClaude).toHaveBeenCalledTimes(2);
    expect(publisher.events.filter((e) => e.type === 'retry')).toHaveLength(1);
    expect((await readPlan()).lastError?.category).toBe('transient_claude_failure');

    expect(metricsEvents()).toHaveLength(2);
    expect(metricsEvents().every((e) => e.scope === 'iteration')).toBe(true);
    expect(publisher.snapshot().metrics.totalInputTokens).toBe(4);
  });

  it('completes the iteration normally when the CLI reported no usage at all', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    agentCompleting(['US-001'], '<promise>COMPLETE</promise>', null);

    const code = await runEngine(baseConfig, paths);

    expect(code).toBe(0);
    expect((await readPlan()).issueStatus).toBe('completed');
    // No usage means no tokens to report, but the story duration is still known.
    const stories = metricsEvents().filter((e) => e.scope === 'story');
    expect(stories).toHaveLength(1);
    expect(stories[0].inputTokens).toBeUndefined();
    expect(stories[0].durationSeconds).toBeGreaterThanOrEqual(0);
    expect(metricsEvents().filter((e) => e.scope === 'iteration')).toHaveLength(0);
    expect(publisher.snapshot().metrics.totalInputTokens).toBeNull();
  });

  it('persists the story shares to tasks.json', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false), makeStory('US-002', 2, false)));
    agentCompleting(['US-001', 'US-002'], '<promise>COMPLETE</promise>', {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 100,
      costUsd: 1,
    });

    await runEngine(baseConfig, paths);

    const [first, second] = (await readPlan()).userStories;
    expect(first).toMatchObject({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 50,
      costUsd: 0.5,
    });
    expect(first?.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(second).toMatchObject({ inputTokens: 5, costUsd: 0.5 });
  });

  it('accumulates onto metrics a story already carried from an earlier run', async () => {
    await writePlan(
      pendingPlan({ ...makeStory('US-001', 1, false), inputTokens: 100, durationSeconds: 60 }),
    );
    agentCompleting(['US-001'], '<promise>COMPLETE</promise>', { inputTokens: 8, costUsd: 0.2 });

    await runEngine(baseConfig, paths);

    const story = (await readPlan()).userStories[0]!;
    expect(story.inputTokens).toBe(108);
    expect(story.costUsd).toBe(0.2);
    expect(story.durationSeconds).toBeGreaterThanOrEqual(60);
  });

  it('writes no metric fields when no story completed in the iteration', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    claudeResult.current = { exitCode: 0, output: 'still working', cost: { inputTokens: 7 } };

    await runEngine(baseConfig, paths);

    const story = (await readPlan()).userStories[0]!;
    expect(story).not.toHaveProperty('inputTokens');
    expect(story).not.toHaveProperty('durationSeconds');
  });

  it('leaves the iteration outcome intact when persisting the metrics fails', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    agentCompleting(['US-001'], '<promise>COMPLETE</promise>', { inputTokens: 8, costUsd: 0.2 });
    // Only the metrics write carries this field; every other save goes through.
    writeFailure.whenContaining = '"inputTokens"';

    const code = await runEngine(baseConfig, paths);

    expect(code).toBe(0);
    const plan = await readPlan();
    expect(plan.issueStatus).toBe('completed');
    expect(plan.userStories[0]!.passes).toBe(true);
    expect(plan.userStories[0]).not.toHaveProperty('inputTokens');
    // The session events are unaffected: only the file write failed.
    expect(metricsEvents().filter((e) => e.scope === 'story')).toHaveLength(1);
  });
});

describe('commit message format', () => {
  it('keeps the historical format when no scope is given', () => {
    expect(commitPlaceholders()).toEqual({
      __COMMIT_MESSAGE__: 'feat: [Story ID] - [Story Title]',
      __FIX_COMMIT_MESSAGE__: 'fix: address review findings',
    });
    expect(commitPlaceholders('')).toEqual(commitPlaceholders());
  });

  it('scopes both messages by issue inside a queue', () => {
    expect(commitPlaceholders('issue-71')).toEqual({
      __COMMIT_MESSAGE__: 'feat(issue-71): [Story ID] - [Story Title]',
      __FIX_COMMIT_MESSAGE__: 'fix(issue-71): address review findings',
    });
  });
});

describe('runEngine — commit scope in the prompt', () => {
  let tmpDir: string;
  let paths: ResolvedPaths;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'issue-flow-engine-scope-'));
    await mkdir(join(tmpDir, 'archive'), { recursive: true });
    paths = {
      prdFile: join(tmpDir, 'tasks.json'),
      progressFile: join(tmpDir, 'progress.txt'),
      archiveDir: join(tmpDir, 'archive'),
      lastBranchFile: join(tmpDir, '.last-branch'),
      projectRoot: tmpDir,
    };
    mockExecuteClaude.mockClear();
    claudeResult.current = { exitCode: 0, output: 'working', cost: null };
    await writeFile(
      paths.prdFile,
      JSON.stringify(
        makePlan({
          issueStatus: 'pending',
          completedAt: null,
          userStories: [
            {
              id: 'US-001',
              title: 'First story',
              description: 'Test story',
              acceptanceCriteria: [],
              priority: 1,
              passes: false,
              notes: '',
            },
          ],
        }),
        null,
        2,
      ),
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('hands the plain commit format to a standalone run', async () => {
    await runEngine(baseConfig, paths);

    const prompt = mockExecuteClaude.mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('feat: [Story ID] - [Story Title]');
    expect(prompt).not.toContain('__COMMIT_MESSAGE__');
  });

  it('hands the scoped commit format to an issue of a queue', async () => {
    await runEngine({ ...baseConfig, commitScope: 'issue-42' }, paths);

    const prompt = mockExecuteClaude.mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('feat(issue-42): [Story ID] - [Story Title]');
    expect(prompt).toContain('fix(issue-42): address review findings');
  });
});

describe('commitPlaceholders — repository commit convention', () => {
  it('keeps the historical format when the repository declares no convention', () => {
    expect(commitPlaceholders()).toEqual({
      __COMMIT_MESSAGE__: 'feat: [Story ID] - [Story Title]',
      __FIX_COMMIT_MESSAGE__: 'fix: address review findings',
    });
  });

  it('keeps the scoped format unchanged too', () => {
    expect(commitPlaceholders('issue-51').__COMMIT_MESSAGE__).toBe(
      'feat(issue-51): [Story ID] - [Story Title]',
    );
  });

  it('lets the agent choose the type when a convention is declared', () => {
    // A bug fix committed as `feat:` corrupts the changelog and any semver bump
    // computed from the history — so the type stops being hard-coded.
    const vars = commitPlaceholders(undefined, 'conventional commits');

    expect(vars.__COMMIT_MESSAGE__).toBe('<type>: [Story ID] - [Story Title]');
  });

  it('keeps the scope alongside the chosen type', () => {
    expect(commitPlaceholders('issue-51', 'conventional commits').__COMMIT_MESSAGE__).toBe(
      '<type>(issue-51): [Story ID] - [Story Title]',
    );
  });

  it('treats an empty or null convention as none', () => {
    expect(commitPlaceholders(undefined, null).__COMMIT_MESSAGE__).toBe(
      'feat: [Story ID] - [Story Title]',
    );
    expect(commitPlaceholders(undefined, '').__COMMIT_MESSAGE__).toBe(
      'feat: [Story ID] - [Story Title]',
    );
  });
});
