import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineConfig, ResolvedPaths, TaskPlan } from '../types.js';

// Instant sleep: the real one is a 2s setTimeout per loop iteration, which
// would make a "one pending-correction iteration" test take multiple real
// seconds for no benefit.
vi.mock('../utils/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/retry.js')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

const claudeResult = vi.hoisted(() => ({ current: { exitCode: 0, output: '' } }));
vi.mock('./executor.js', () => ({
  executeClaude: vi.fn(async () => claudeResult.current),
}));

const { executeClaude } = await import('./executor.js');
const { runEngine } = await import('./engine.js');

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
    claudeResult.current = { exitCode: 0, output: 'working on it' };

    const code = await runEngine(baseConfig, paths);

    expect(mockExecuteClaude).toHaveBeenCalledTimes(1);
    // maxIterations: 1 and the mock never clears lastReviewFindings nor signals
    // completion, so the run correctly reports "not done yet" rather than 0.
    expect(code).toBe(1);
  });

  it('does not mark the issue completed on <promise>COMPLETE</promise> while lastReviewFindings is still set', async () => {
    await writePlan(makePlan({ lastReviewFindings: 'stale finding the agent forgot to clear' }));
    claudeResult.current = { exitCode: 0, output: '<promise>COMPLETE</promise>' };

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
