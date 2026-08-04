import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskPlan } from '../types.js';

// getIssueDir() shells out to `git rev-parse --show-toplevel`, which goes
// through execa — the mock answers with the temporary repo root so tasksPath
// resolves inside it.
const mockProjectRoot = vi.hoisted(() => ({ current: '' }));
vi.mock('execa', () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: mockProjectRoot.current, exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  }),
}));

const headlessOutput = vi.hoisted(() => ({ current: '' }));
vi.mock('../core/headless.js', () => ({
  runHeadless: vi.fn(async () => ({ success: true, result: headlessOutput.current })),
}));

import type { Issue, ResolvedIssue } from '../issues/types.js';
import { runReview } from './review.js';

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
  let tasksPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'issue-flow-review-'));
    mockProjectRoot.current = tmpDir;
    tasksPath = join(tmpDir, 'issues', '42', 'tasks.json');
    await mkdir(join(tmpDir, 'issues', '42'), { recursive: true });
    await writeFile(tasksPath, JSON.stringify(makePlan(), null, 2), 'utf-8');
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
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
});
