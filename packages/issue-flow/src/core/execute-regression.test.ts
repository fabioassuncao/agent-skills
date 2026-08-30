import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineConfig, ResolvedPaths, TaskPlan, UserStory } from '../types.js';

/**
 * Non-regression suite for the execute loop after the token instrumentation.
 *
 * Unlike engine.test.ts, this file does **not** mock `executor.js`: it drives
 * the real `executeClaude()` with a mocked `execa`, so the assertions cover the
 * whole chain the instrumentation touched -- the flags handed to the CLI, the
 * JSON envelope being unwrapped, and everything the loop decides from the
 * result. The claim under test is that swapping `--print` alone for
 * `--print --output-format json` changed nothing observable: exit codes,
 * transient vs. fatal classification, retry counts, the completion signal and
 * the writes to tasks.json all behave exactly as before.
 */

// Instant sleep: the real one waits 2s per iteration and backs off on retries.
// The retry backoff waits on `abortableDelay` since the loop delegated to
// `resilience/retry.ts:withRetry`; mocking only `sleep` leaves it waiting for
// real. The retry decision and the computed delay stay production code.
vi.mock('../resilience/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resilience/policy.js')>();
  return { ...actual, abortableDelay: vi.fn(async () => true) };
});

vi.mock('../utils/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/retry.js')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

// Git/gh enrichment spawns subprocesses; it carries no loop logic.
vi.mock('./session-git.js', () => ({ publishGitState: vi.fn(async () => {}) }));

// Same reasoning for the repository policy: discovery shells out to git and gh,
// so with `execa` mocked it would eat the CLI results this file queues up. The
// projection it returns is the empty one, which is what a repository declaring
// no policy produces — exactly the condition this non-regression suite is about.
vi.mock('../policy/placeholders.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../policy/placeholders.js')>();
  return {
    ...actual,
    resolvePolicyPlaceholders: vi.fn(async () => actual.emptyPolicyPlaceholders()),
  };
});

// The post-commit story checkpoint (US-022) reads the branch history and the
// working tree before each iteration. Those are `git` calls through the same
// mocked `execa` this file queues CLI results on, so they are stubbed here: a
// dirty tree disables the adoption entirely, which is the pre-US-022 behaviour
// this non-regression suite is about.
vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return {
    ...actual,
    getBaseBranch: vi.fn(async () => 'main'),
    isWorkingTreeClean: vi.fn(async () => false),
    committedStoryIds: vi.fn(async () => new Set<string>()),
  };
});

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { runEngine } from './engine.js';
import { resetRunUsageTotals } from './session-metrics.js';

type ExecaResult = Awaited<ReturnType<typeof execa>>;

const mockExeca = vi.mocked(execa);

function cliResult(overrides: Partial<{ stdout: string; stderr: string; exitCode: number }>) {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides } as unknown as ExecaResult;
}

/** Payload shape of `claude --print --output-format json` (CLI 2.1.220). */
function jsonEnvelope(text: string, usage?: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    ...(usage ?? {}),
  });
}

const REPORTED_USAGE = {
  total_cost_usd: 0.5,
  usage: {
    input_tokens: 10,
    output_tokens: 4,
    cache_creation_input_tokens: 2_000,
    cache_read_input_tokens: 30_000,
  },
};

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

function pendingPlan(...stories: UserStory[]): TaskPlan {
  return {
    project: 'test',
    issueNumber: 42,
    issueUrl: 'https://github.com/acme/repo/issues/42',
    branchName: 'issue/42-sample',
    description: 'Test plan',
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
    userStories: stories,
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

describe('execute loop — non-regression of the JSON output format', () => {
  let tmpDir: string;
  let paths: ResolvedPaths;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'issue-flow-regression-'));
    await mkdir(join(tmpDir, 'archive'), { recursive: true });
    paths = {
      prdFile: join(tmpDir, 'tasks.json'),
      progressFile: join(tmpDir, 'progress.txt'),
      archiveDir: join(tmpDir, 'archive'),
      lastBranchFile: join(tmpDir, '.last-branch'),
      projectRoot: tmpDir,
    };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    resetRunUsageTotals();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writePlan(plan: TaskPlan): Promise<void> {
    await writeFile(paths.prdFile, JSON.stringify(plan, null, 2), 'utf-8');
  }

  async function readPlan(): Promise<TaskPlan> {
    return JSON.parse(await readFile(paths.prdFile, 'utf-8'));
  }

  /** Mocked CLI: flips the given stories to passing, then answers `stdout`. */
  function agentCompleting(ids: string[], stdout: string): void {
    mockExeca.mockImplementationOnce(async () => {
      const plan = await readPlan();
      for (const story of plan.userStories) {
        if (ids.includes(story.id)) story.passes = true;
      }
      await writePlan(plan);
      return cliResult({ stdout });
    });
  }

  it('asks the CLI for the JSON envelope while keeping the prompt on stdin', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    agentCompleting(['US-001'], jsonEnvelope('<promise>COMPLETE</promise>', REPORTED_USAGE));

    await runEngine(baseConfig, paths);

    expect(mockExeca).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockExeca.mock.calls[0]!;
    expect(command).toBe('claude');
    expect(args).toEqual(['--dangerously-skip-permissions', '--print', '--output-format', 'json']);
    expect(options).toMatchObject({ reject: false, timeout: 0, stripFinalNewline: false });
    // The prompt still travels on stdin, never as an argument.
    expect(typeof (options as { input?: unknown }).input).toBe('string');
    expect((options as { input: string }).input.length).toBeGreaterThan(0);
  });

  it('detects the completion signal inside the envelope and writes tasks.json as before', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    agentCompleting(
      ['US-001'],
      jsonEnvelope('All done.\n<promise>COMPLETE</promise>', REPORTED_USAGE),
    );

    const code = await runEngine(baseConfig, paths);

    expect(code).toBe(0);
    const plan = await readPlan();
    expect(plan.issueStatus).toBe('completed');
    expect(plan.completedAt).not.toBeNull();
    expect(plan.lastError).toBeNull();
    expect(plan.userStories[0]!.passes).toBe(true);
    // Additive only: the metrics land next to the untouched story fields.
    expect(plan.userStories[0]).toMatchObject({
      id: 'US-001',
      notes: '',
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 30_000,
      cacheCreationTokens: 2_000,
      costUsd: 0.5,
    });
  });

  it('still honours a completion signal from a CLI that prints plain text', async () => {
    // A `claude` build that ignores --output-format must behave as it always did.
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    agentCompleting(['US-001'], 'All done.\n<promise>COMPLETE</promise>');

    const code = await runEngine(baseConfig, paths);

    expect(code).toBe(0);
    const plan = await readPlan();
    expect(plan.issueStatus).toBe('completed');
    expect(plan.userStories[0]).not.toHaveProperty('inputTokens');
  });

  it('completes normally when the envelope carries no usage nor cost', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    agentCompleting(['US-001'], jsonEnvelope('<promise>COMPLETE</promise>'));

    const code = await runEngine(baseConfig, paths);

    expect(code).toBe(0);
    const plan = await readPlan();
    expect(plan.issueStatus).toBe('completed');
    expect(plan.userStories[0]!.passes).toBe(true);
    // No metrics reported means no metric fields -- never artificial zeros.
    for (const field of [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheCreationTokens',
      'costUsd',
    ]) {
      expect(plan.userStories[0]).not.toHaveProperty(field);
    }
    // The duration is measured by the engine, so it is known regardless.
    expect(plan.userStories[0]!.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('keeps a fatal exit code, its classification and the absence of retries', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    mockExeca.mockResolvedValue(cliResult({ stdout: '', stderr: 'Invalid API key', exitCode: 2 }));

    const code = await runEngine(baseConfig, paths);

    expect(code).toBe(2);
    expect(mockExeca).toHaveBeenCalledTimes(1);
    const plan = await readPlan();
    expect(plan.lastError?.category).toBe('fatal_claude_failure');
    expect(plan.lastError?.message).toContain('Invalid API key');
    expect(plan.userStories[0]!.passes).toBe(false);
  });

  it('keeps the transient classification, the retry count and the exit code', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    // Diagnostics on stderr: the failure path never unwraps the envelope, so
    // isTransientFailure() sees the raw text exactly as it used to.
    mockExeca.mockResolvedValue(
      cliResult({ stdout: '', stderr: 'API Error: Overloaded (529)', exitCode: 1 }),
    );

    const code = await runEngine({ ...baseConfig, retryLimit: 2 }, paths);

    expect(code).toBe(1);
    // retryLimit attempts plus the one that exceeds it.
    expect(mockExeca).toHaveBeenCalledTimes(3);
    const plan = await readPlan();
    expect(plan.lastError?.category).toBe('transient_claude_failure');
    expect(plan.lastError?.message).toContain('Overloaded');
  });

  it('classifies a transient failure reported inside a JSON envelope the same way', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false)));
    // is_error is deliberately ignored: only the exit code and the raw text
    // drive the decision, exactly as before the instrumentation.
    mockExeca.mockResolvedValue(
      cliResult({
        stdout: JSON.stringify({ type: 'result', is_error: true, result: 'rate limit exceeded' }),
        exitCode: 1,
      }),
    );

    const code = await runEngine({ ...baseConfig, retryLimit: 1 }, paths);

    expect(code).toBe(1);
    expect(mockExeca).toHaveBeenCalledTimes(2);
    expect((await readPlan()).lastError?.category).toBe('transient_claude_failure');
  });

  it('ignores a completion signal while stories are still pending', async () => {
    await writePlan(pendingPlan(makeStory('US-001', 1, false), makeStory('US-002', 2, false)));
    agentCompleting(['US-001'], jsonEnvelope('<promise>COMPLETE</promise>', REPORTED_USAGE));

    const code = await runEngine(baseConfig, paths);

    expect(code).toBe(1);
    const plan = await readPlan();
    expect(plan.issueStatus).not.toBe('completed');
    expect(plan.lastError?.category).toBe('invalid_completion_signal');
  });
});
