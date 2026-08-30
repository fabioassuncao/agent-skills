import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskPlan } from '../types.js';

// resolveIssuePaths() shells out to `git rev-parse --show-toplevel` and
// `git remote get-url origin`, both through execa — the mock answers with the
// temporary repo root and a stable remote, so the derived project id is
// deterministic.
const mockRepo = vi.hoisted(() => ({ root: '', remote: 'https://github.com/acme/widgets.git' }));
vi.mock('execa', () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: mockRepo.root, exitCode: 0 };
    }
    if (file === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: mockRepo.remote, exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  }),
}));

const headlessOutput = vi.hoisted(() => ({ current: '' }));
const headlessOptions = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
const headlessCost = vi.hoisted(() => ({ current: null as Record<string, number> | null }));
vi.mock('../core/headless.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/headless.js')>()),
  runHeadless: vi.fn(async (options: Record<string, unknown>) => {
    headlessOptions.last = options;
    return { success: true, result: headlessOutput.current, cost: headlessCost.current };
  }),
}));

import { setSessionPublisher } from '../core/session-publisher.js';
import { MemoryPublisher, type SessionEvent } from '../core/session-state.js';
import type { Issue, ResolvedIssue } from '../issues/types.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { resetStorageResolutionCache, resolveIssuePaths } from '../storage/resolve.js';
import { runReview } from './review.js';

/** Publisher that keeps every event, so the metrics payload can be asserted. */
class RecordingPublisher extends MemoryPublisher {
  readonly events: SessionEvent[] = [];

  protected override afterPublish(event: SessionEvent): void {
    this.events.push(event);
  }
}

function makeResolved(): ResolvedIssue {
  const issue: Issue = {
    id: '42',
    number: 42,
    title: 'Sample issue',
    body: 'Body',
    labels: [],
    state: 'open',
    source: 'github',
    remoteRef: 'https://github.com/acme/repo/issues/42',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    contentHash: 'sha256:abc',
  };
  return { issue, source: 'github', local: null, github: issue, divergent: false };
}

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
    correctionCycle: 0,
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

describe('runReview — persisting review outcome to tasks.json', () => {
  let tmpDir: string;
  let globalHome: string;
  let previousHome: string | undefined;
  let issueDir: string;
  let tasksPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'issue-flow-review-'));
    globalHome = await mkdtemp(join(tmpdir(), 'issue-flow-home-'));
    mockRepo.root = tmpDir;

    // runReview calls resolveIssuePaths() with no options, so the override has
    // to reach it through the real process environment.
    previousHome = process.env[GLOBAL_ROOT_ENV];
    process.env[GLOBAL_ROOT_ENV] = globalHome;
    resetStorageResolutionCache();
    headlessOptions.last = null;
    headlessCost.current = null;

    const paths = await resolveIssuePaths('42');
    issueDir = paths.issueDir;
    tasksPath = paths.tasksFile;
    await mkdir(issueDir, { recursive: true });
    await writeFile(tasksPath, JSON.stringify(makePlan(), null, 2), 'utf-8');
  });

  afterEach(async () => {
    resetStorageResolutionCache();
    if (previousHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
    else process.env[GLOBAL_ROOT_ENV] = previousHome;

    await rm(tmpDir, { recursive: true, force: true });
    await rm(globalHome, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function readPlan(): Promise<TaskPlan> {
    return JSON.parse(await readFile(tasksPath, 'utf-8'));
  }

  it('on FAIL, persists the findings and flips reviewCompleted to false', async () => {
    headlessOutput.current = [
      '<review-result>',
      'STATUS: FAIL',
      'FINDINGS:',
      '- getRemoteUrl() ignores the projectRoot passed to getProjectId()',
      '</review-result>',
    ].join('\n');

    const code = await runReview('42', makeResolved());

    expect(code).toBe(1);
    const plan = await readPlan();
    expect(plan.pipeline.reviewCompleted).toBe(false);
    expect(plan.lastReviewFindings).toContain('getRemoteUrl() ignores the projectRoot');
  });

  it('on PASS, clears a previously persisted lastReviewFindings', async () => {
    await writeFile(
      tasksPath,
      JSON.stringify(
        makePlan({ lastReviewFindings: 'stale finding from a previous cycle' }),
        null,
        2,
      ),
      'utf-8',
    );
    headlessOutput.current = '<review-result>\nSTATUS: PASS\n</review-result>';

    const code = await runReview('42', makeResolved());

    expect(code).toBe(0);
    const plan = await readPlan();
    expect(plan.pipeline.reviewCompleted).toBe(true);
    expect(plan.lastReviewFindings).toBeNull();
  });

  it('does not fail the phase when tasks.json is missing', async () => {
    await rm(tasksPath);
    headlessOutput.current = '<review-result>\nSTATUS: FAIL\nFINDINGS:\n- x\n</review-result>';

    await expect(runReview('42', makeResolved())).resolves.toBe(1);
  });

  it('points the prompt and the headless session at the global issue directory', async () => {
    headlessOutput.current = '<review-result>\nSTATUS: PASS\n</review-result>';

    await runReview('42', makeResolved());

    expect(tasksPath.startsWith(globalHome)).toBe(true);
    expect(String(headlessOptions.last?.prompt)).toContain(tasksPath);
    expect(headlessOptions.last?.addDirs).toEqual([issueDir]);
    // Nothing was written under the legacy tree.
    await expect(readFile(join(tmpDir, 'issues', '42', 'tasks.json'), 'utf-8')).rejects.toThrow();
  });

  describe('metrics', () => {
    let publisher: RecordingPublisher;

    beforeEach(() => {
      publisher = new RecordingPublisher({ onWarn: () => {} });
      setSessionPublisher(publisher);
      publisher.publish({
        type: 'session:start',
        at: '2026-01-01T00:00:00Z',
        sessionId: 's1',
        issueNumber: 42,
        phases: ['review'],
      });
    });

    afterEach(() => {
      setSessionPublisher(undefined);
    });

    function metricsEvents(): Extract<SessionEvent, { type: 'metrics:update' }>[] {
      return publisher.events.filter(
        (e): e is Extract<SessionEvent, { type: 'metrics:update' }> => e.type === 'metrics:update',
      );
    }

    it('asks the CLI for usage by running in json output format', async () => {
      headlessOutput.current = '<review-result>\nSTATUS: PASS\n</review-result>';

      await runReview('42', makeResolved());

      expect(headlessOptions.last?.outputFormat).toBe('json');
    });

    it('publishes the invocation usage against the review phase', async () => {
      headlessOutput.current = '<review-result>\nSTATUS: PASS\n</review-result>';
      headlessCost.current = { inputTokens: 12, outputTokens: 34, costUsd: 0.25 };

      const code = await runReview('42', makeResolved());

      expect(code).toBe(0);
      expect(metricsEvents()).toHaveLength(1);
      expect(metricsEvents()[0]).toMatchObject({
        scope: 'phase',
        phase: 'review',
        inputTokens: 12,
        outputTokens: 34,
        costUsd: 0.25,
      });
      const phase = publisher.snapshot().phases.find((p) => p.name === 'review');
      expect(phase).toMatchObject({ inputTokens: 12, costUsd: 0.25 });
    });

    it('publishes nothing, and still returns 0, when the CLI reports no usage', async () => {
      headlessOutput.current = '<review-result>\nSTATUS: PASS\n</review-result>';
      headlessCost.current = null;

      const code = await runReview('42', makeResolved());

      expect(code).toBe(0);
      expect(metricsEvents()).toHaveLength(0);
      const phase = publisher.snapshot().phases.find((p) => p.name === 'review');
      expect(phase?.inputTokens).toBeNull();
    });

    it('sums one event per invocation across a correction cycle', async () => {
      headlessOutput.current = '<review-result>\nSTATUS: FAIL\nFINDINGS:\n- x\n</review-result>';
      headlessCost.current = { inputTokens: 10, costUsd: 0.1 };
      await runReview('42', makeResolved());

      headlessOutput.current = '<review-result>\nSTATUS: PASS\n</review-result>';
      headlessCost.current = { inputTokens: 4, costUsd: 0.05 };
      await runReview('42', makeResolved());

      expect(metricsEvents()).toHaveLength(2);
      const phase = publisher.snapshot().phases.find((p) => p.name === 'review');
      expect(phase).toMatchObject({ inputTokens: 14 });
      expect(phase?.costUsd).toBeCloseTo(0.15, 10);
      expect(publisher.snapshot().metrics.totalInputTokens).toBe(14);
    });
  });
});
