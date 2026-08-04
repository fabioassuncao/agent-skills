import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskPlan } from '../types.js';

// resolveIssuePaths() and the `gh pr view` metadata lookup both go through
// execa; the mock answers with the temporary repo root, a stable remote (so the
// derived project id is deterministic) and a fixed Pull Request payload, so no
// test touches the network or the real repository.
const mockRepo = vi.hoisted(() => ({ root: '', remote: 'https://github.com/acme/widgets.git' }));
const mockBranch = vi.hoisted(() => ({ current: '' }));
vi.mock('execa', () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: mockRepo.root, exitCode: 0 };
    }
    if (file === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: mockRepo.remote, exitCode: 0 };
    }
    if (file === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
      return { stdout: mockBranch.current, exitCode: 0 };
    }
    if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return {
        stdout: JSON.stringify({
          title: 'Add the pr-review phase',
          url: 'https://github.com/acme/repo/pull/128',
          headRefName: 'issue/25-pr-review-phase',
          headRefOid: 'abc1234',
        }),
        exitCode: 0,
      };
    }
    return { stdout: '', exitCode: 0 };
  }),
}));

const headless = vi.hoisted(() => ({
  output: '',
  success: true,
  error: null as string | null,
  options: null as Record<string, unknown> | null,
}));
vi.mock('../core/headless.js', () => ({
  runHeadless: vi.fn(async (options: Record<string, unknown>) => {
    headless.options = options;
    return { success: headless.success, result: headless.output, error: headless.error };
  }),
}));

import type { PrReviewIndex } from '../core/pr-review/report.js';
import { setGlobalTimeout } from '../core/verbose.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { resetStorageResolutionCache, resolveIssuePaths } from '../storage/resolve.js';
import { runPrReview } from './pr-review.js';

function agentOutput(recommendation: string, extra = ''): string {
  return [
    '## Executive summary',
    'The change is coherent.',
    '',
    '## Issues found',
    '- [high] src/commands/pr-review.ts:42 — Timeout is not configurable',
    '',
    '## Required before merge',
    extra === '' ? '_None._' : extra,
    '',
    '## Final recommendation',
    recommendation,
    '',
    '<pr-review-result>',
    `RECOMMENDATION: ${recommendation}`,
    'BLOCKERS:',
    extra === '' ? '- None' : '- Fix the broken timeout',
    '</pr-review-result>',
  ].join('\n');
}

function makePlan(): TaskPlan {
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
    pipeline: {
      prdCompleted: true,
      jsonCompleted: true,
      executionCompleted: true,
      reviewCompleted: true,
      prCreated: true,
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
  };
}

describe('runPrReview', () => {
  let tmpDir: string;
  let globalHome: string;
  let previousHome: string | undefined;
  let issueDir: string;
  let tasksPath: string;
  let prdPath: string;
  let reviewDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'issue-flow-pr-review-'));
    globalHome = await mkdtemp(join(tmpdir(), 'issue-flow-home-'));
    mockRepo.root = tmpDir;
    mockBranch.current = '';

    // runPrReview calls resolveIssuePaths() with no options, so the override
    // has to reach it through the real process environment.
    previousHome = process.env[GLOBAL_ROOT_ENV];
    process.env[GLOBAL_ROOT_ENV] = globalHome;
    resetStorageResolutionCache();

    const paths = await resolveIssuePaths('42');
    issueDir = paths.issueDir;
    tasksPath = paths.tasksFile;
    prdPath = paths.prdFile;
    reviewDir = paths.prReviewDir;
    await mkdir(issueDir, { recursive: true });
    await writeFile(tasksPath, JSON.stringify(makePlan(), null, 2), 'utf-8');
    headless.success = true;
    headless.error = null;
    headless.options = null;
    headless.output = agentOutput('APPROVE');
  });

  afterEach(async () => {
    resetStorageResolutionCache();
    if (previousHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
    else process.env[GLOBAL_ROOT_ENV] = previousHome;

    await rm(tmpDir, { recursive: true, force: true });
    await rm(globalHome, { recursive: true, force: true });
    // There is no "unset"; the cast restores the module's initial state so the
    // phase default applies again in the next test.
    setGlobalTimeout(undefined as unknown as number);
    vi.clearAllMocks();
  });

  async function readPlan(): Promise<TaskPlan> {
    return JSON.parse(await readFile(tasksPath, 'utf-8'));
  }

  async function readIndex(dir = reviewDir): Promise<PrReviewIndex> {
    return JSON.parse(await readFile(join(dir, 'index.json'), 'utf-8'));
  }

  it('runs the review read-only, with the phase budget', async () => {
    await runPrReview('128', { issue: '42' });

    expect(headless.options).toMatchObject({
      maxTurns: 40,
      timeout: 900_000,
      outputFormat: 'text',
      allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
    });
  });

  it('lets the global --timeout override the phase default', async () => {
    setGlobalTimeout(120_000);

    await runPrReview('128', { issue: '42' });

    expect(headless.options?.timeout).toBe(120_000);
  });

  it('fills the prompt placeholders with the resolved context', async () => {
    await runPrReview('128', { issue: '42' });

    const prompt = String(headless.options?.prompt);
    expect(prompt).toContain('Pull Request #128');
    expect(prompt).toContain(tasksPath);
    expect(prompt).toContain(prdPath);
    expect(prompt).toContain(join(reviewDir, 'pr-128-round-1.md'));
    expect(prompt).not.toMatch(/__[A-Z_]+__/);
  });

  it('writes every artifact under the global storage, never under <repoRoot>/issues/', async () => {
    const code = await runPrReview('128', { issue: '42' });

    expect(code).toBe(0);
    expect(reviewDir.startsWith(globalHome)).toBe(true);
    // The parent covers the report destination plus tasks.json and prd.md.
    expect(headless.options?.addDirs).toEqual([issueDir]);
    await expect(
      readFile(join(tmpDir, 'issues', '42', 'pr-review', 'index.json')),
    ).rejects.toThrow();
  });

  it('writes the report and the index, and records the round on the plan', async () => {
    const code = await runPrReview('128', { issue: '42' });

    expect(code).toBe(0);

    const markdown = await readFile(join(reviewDir, 'pr-128-round-1.md'), 'utf-8');
    expect(markdown).toContain('# Pull Request Review — #128 (round 1)');
    expect(markdown).toContain('**Recommendation:** APPROVE');
    expect(markdown).toContain('Add the pr-review phase');

    const index = await readIndex();
    expect(index.schemaVersion).toBe(1);
    expect(index.pullRequest.number).toBe(128);
    expect(index.rounds).toHaveLength(1);
    expect(index.rounds[0]).toMatchObject({
      round: 1,
      recommendation: 'APPROVE',
      headSha: 'abc1234',
    });
    expect(index.rounds[0]?.findings[0]).toMatchObject({
      severity: 'high',
      file: 'src/commands/pr-review.ts',
      line: 42,
    });

    const plan = await readPlan();
    expect(plan.pipeline.prReviewCompleted).toBe(true);
    expect(plan.prReview).toMatchObject({
      pullRequestNumber: 128,
      rounds: 1,
      lastRecommendation: 'APPROVE',
    });
    expect(plan.prReview?.lastReviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Only the pr-review phase state is touched.
    expect(plan.pipeline.reviewCompleted).toBe(true);
    expect(plan.pipeline.prCreated).toBe(true);
  });

  it('returns 0 and marks the phase complete on APPROVE_WITH_SUGGESTIONS', async () => {
    headless.output = agentOutput('APPROVE_WITH_SUGGESTIONS');

    const code = await runPrReview('128', { issue: '42' });

    expect(code).toBe(0);
    const plan = await readPlan();
    expect(plan.pipeline.prReviewCompleted).toBe(true);
    expect(plan.prReview?.lastRecommendation).toBe('APPROVE_WITH_SUGGESTIONS');
  });

  it('returns 2 and leaves the phase incomplete on REQUEST_CHANGES', async () => {
    headless.output = agentOutput(
      'REQUEST_CHANGES',
      '- [blocker] src/commands/pr-review.ts:10 — Missing timeout handling',
    );

    const code = await runPrReview('128', { issue: '42' });

    expect(code).toBe(2);
    const plan = await readPlan();
    expect(plan.pipeline.prReviewCompleted).toBe(false);
    expect(plan.prReview?.lastRecommendation).toBe('REQUEST_CHANGES');
    // The report is still written: a rejected review is the useful one.
    await expect(readFile(join(reviewDir, 'pr-128-round-1.md'), 'utf-8')).resolves.toContain(
      'REQUEST_CHANGES',
    );
  });

  it('forces 0 on REQUEST_CHANGES with --fail-on none', async () => {
    headless.output = agentOutput('REQUEST_CHANGES', '- [blocker] a.ts:1 — Broken');

    await expect(runPrReview('128', { issue: '42', failOn: 'none' })).resolves.toBe(0);
  });

  it('fails on APPROVE_WITH_SUGGESTIONS with --fail-on suggestions', async () => {
    headless.output = agentOutput('APPROVE_WITH_SUGGESTIONS');

    await expect(runPrReview('128', { issue: '42', failOn: 'suggestions' })).resolves.toBe(2);
  });

  it('rejects an unknown --fail-on level before doing any work', async () => {
    const code = await runPrReview('128', { issue: '42', failOn: 'whatever' });

    expect(code).toBe(1);
    expect(headless.options).toBeNull();
  });

  it('rejects a non-positive --round before doing any work', async () => {
    const code = await runPrReview('128', { issue: '42', round: '0' });

    expect(code).toBe(1);
    expect(headless.options).toBeNull();
  });

  it('returns 1 when the headless run fails, without writing artifacts', async () => {
    headless.success = false;
    headless.error = 'agent crashed';

    const code = await runPrReview('128', { issue: '42' });

    expect(code).toBe(1);
    await expect(readFile(join(reviewDir, 'index.json'), 'utf-8')).rejects.toThrow();
    const plan = await readPlan();
    expect(plan.pipeline.prReviewCompleted).toBeUndefined();
  });

  it('returns 1 on a malformed verdict, keeping the raw output in the report', async () => {
    headless.output = 'I reviewed everything and it looks fine to me.';

    const code = await runPrReview('128', { issue: '42' });

    expect(code).toBe(1);
    const markdown = await readFile(join(reviewDir, 'pr-128-round-1.md'), 'utf-8');
    expect(markdown).toContain('**Recommendation:** UNPARSED');
    expect(markdown).toContain('## Raw agent output');
    expect(markdown).toContain('it looks fine to me');

    const plan = await readPlan();
    expect(plan.pipeline.prReviewCompleted).toBe(false);
    expect(plan.prReview?.lastRecommendation).toBeUndefined();
  });

  it('appends rounds instead of overwriting the previous report', async () => {
    await runPrReview('128', { issue: '42' });
    headless.output = agentOutput('APPROVE_WITH_SUGGESTIONS');
    const code = await runPrReview('128', { issue: '42' });

    expect(code).toBe(0);
    await expect(readFile(join(reviewDir, 'pr-128-round-1.md'), 'utf-8')).resolves.toContain(
      '**Recommendation:** APPROVE',
    );
    await expect(readFile(join(reviewDir, 'pr-128-round-2.md'), 'utf-8')).resolves.toContain(
      '**Recommendation:** APPROVE_WITH_SUGGESTIONS',
    );

    const index = await readIndex();
    expect(index.rounds.map((entry) => entry.round)).toEqual([1, 2]);
    expect((await readPlan()).prReview?.rounds).toBe(2);
  });

  it('rewrites a specific round with --round, without shrinking the round count', async () => {
    await runPrReview('128', { issue: '42' });
    await runPrReview('128', { issue: '42' });

    headless.output = agentOutput('REQUEST_CHANGES', '- [blocker] a.ts:1 — Broken');
    const code = await runPrReview('128', { issue: '42', round: 1 });

    expect(code).toBe(2);
    await expect(readFile(join(reviewDir, 'pr-128-round-1.md'), 'utf-8')).resolves.toContain(
      '**Recommendation:** REQUEST_CHANGES',
    );
    const index = await readIndex();
    expect(index.rounds.map((entry) => entry.round)).toEqual([1, 2]);
    expect((await readPlan()).prReview?.rounds).toBe(2);
  });

  it('reviews a Pull Request with no associated issue', async () => {
    const code = await runPrReview('128');

    expect(code).toBe(0);
    // No issue means no paths to resolve: the report lands under the synthetic
    // `pr-<N>` slug and the path placeholders stay empty.
    const standaloneDir = (await resolveIssuePaths('pr-128')).prReviewDir;
    expect(standaloneDir.startsWith(globalHome)).toBe(true);
    await expect(readFile(join(standaloneDir, 'pr-128-round-1.md'), 'utf-8')).resolves.toContain(
      '#128',
    );
    expect((await readIndex(standaloneDir)).rounds).toHaveLength(1);
    // The unrelated plan on disk is left untouched.
    expect((await readPlan()).prReview).toBeUndefined();
    expect(String(headless.options?.prompt)).toContain('#none');
    expect(String(headless.options?.prompt)).toContain('(none)');
    expect(headless.options?.addDirs).toEqual([standaloneDir]);
  });

  it('publishes through the injected publisher instead of the local one', async () => {
    const publish = vi.fn(async () => {});

    const code = await runPrReview('128', { issue: '42', publisher: { publish } });

    expect(code).toBe(0);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      round: 1,
      recommendation: 'APPROVE',
      pullRequest: { number: 128 },
    });
    // Nothing was written locally.
    await expect(readFile(join(reviewDir, 'index.json'), 'utf-8')).rejects.toThrow();
  });

  it('honours the publisher configured in .issue-flow.json', async () => {
    await writeFile(
      join(tmpDir, '.issue-flow.json'),
      JSON.stringify({ prReview: { publisher: 'local' } }),
      'utf-8',
    );

    const code = await runPrReview('128', { issue: '42' });

    expect(code).toBe(0);
    const index = JSON.parse(
      await readFile(join(reviewDir, 'index.json'), 'utf-8'),
    ) as PrReviewIndex;
    expect(index.rounds).toHaveLength(1);
  });

  it('falls back to the local publisher when the configured one is unknown', async () => {
    await writeFile(
      join(tmpDir, '.issue-flow.json'),
      JSON.stringify({ prReview: { publisher: 'github' } }),
      'utf-8',
    );

    const code = await runPrReview('128', { issue: '42' });

    // An unusable publisher key degrades to a warning, never to a failed review.
    expect(code).toBe(0);
    const index = JSON.parse(
      await readFile(join(reviewDir, 'index.json'), 'utf-8'),
    ) as PrReviewIndex;
    expect(index.rounds).toHaveLength(1);
  });

  it('fails with an actionable message when no Pull Request can be found', async () => {
    const code = await runPrReview(undefined, { issue: '42', yes: true });

    expect(code).toBe(1);
    expect(headless.options).toBeNull();
  });

  it('reviews the Pull Request persisted by the pr phase when none is given', async () => {
    const plan = makePlan();
    plan.pullRequest = {
      number: 77,
      url: 'https://github.com/acme/repo/pull/77',
      headBranch: 'issue/42-sample',
      createdAt: '2026-01-01T00:00:00Z',
    };
    await writeFile(tasksPath, JSON.stringify(plan, null, 2), 'utf-8');

    const code = await runPrReview(undefined, { issue: '42', yes: true });

    expect(code).toBe(0);
    expect(String(headless.options?.prompt)).toContain('Pull Request #77');
    expect((await readPlan()).prReview?.pullRequestNumber).toBe(77);
  });
});
