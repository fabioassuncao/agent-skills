import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTaskPlan, saveTaskPlan } from '../../core/state-manager.js';
import { getProvider } from '../../issues/registry.js';
import { taskPlanSchema } from '../../schemas.js';
import { finishIssueClosure, persistClosureChoice } from './closure.js';

vi.mock('../../issues/registry.js', () => ({ getProvider: vi.fn() }));
vi.mock('../../ui/logger.js', () => ({ printError: vi.fn() }));
let root: string;
let path: string;
let closed: boolean;
const close = vi.fn(async () => {
  closed = true;
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'if-closure-'));
  path = join(root, 'tasks.json');
  closed = false;
  close.mockClear();
  vi.mocked(getProvider).mockReturnValue({
    get: async () => ({ state: closed ? 'closed' : 'open' }),
    close,
  } as unknown as ReturnType<typeof getProvider>);
  await saveTaskPlan(
    path,
    taskPlanSchema.parse({
      project: 'test',
      issueNumber: 42,
      issueUrl: '',
      issueStatus: 'pending',
      completedAt: null,
      lastAttemptAt: null,
      lastError: null,
      correctionCycle: 0,
      maxCorrectionCycles: 3,
      lastReviewFindings: null,
      branchName: 'main',
      noBranch: false,
      description: '',
      userStories: [
        {
          id: 'A',
          title: 'A',
          description: '',
          acceptanceCriteria: ['Test'],
          priority: 1,
          passes: true,
          notes: '',
        },
      ],
      pipeline: {
        prdCompleted: true,
        jsonCompleted: true,
        executionCompleted: true,
        reviewCompleted: true,
        prCreated: true,
      },
    }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe('explicit recoverable closure', () => {
  it('leaves unauthorized and revoked issues open', async () => {
    expect(await finishIssueClosure(path, '42', 'local')).toBe(0);
    expect(close).not.toHaveBeenCalled();
    await persistClosureChoice(path, true);
    await persistClosureChoice(path, false);
    expect(await finishIssueClosure(path, '42', 'local')).toBe(0);
    expect(close).not.toHaveBeenCalled();
  });
  it('persists authorization and confirmation; repeated completion does not close twice', async () => {
    await persistClosureChoice(path, true);
    expect(await finishIssueClosure(path, '42', 'local')).toBe(0);
    expect(await finishIssueClosure(path, '42', 'local')).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await loadTaskPlan(path)).toMatchObject({
      closeIssue: true,
      issueClosedAt: expect.any(String),
      issueStatus: 'completed',
    });
  });
  it('requires the optional review and unresolved findings to finish before closure', async () => {
    const plan = await loadTaskPlan(path);
    plan.closeIssue = true;
    plan.prReview = { enabled: true, rounds: 0 };
    await saveTaskPlan(path, plan);
    expect(await finishIssueClosure(path, '42', 'local')).toBe(1);
    expect(close).not.toHaveBeenCalled();
    plan.pipeline.prReviewCompleted = true;
    plan.lastReviewFindings = '- Fix';
    await saveTaskPlan(path, plan);
    expect(await finishIssueClosure(path, '42', 'local')).toBe(1);
    expect(close).not.toHaveBeenCalled();
  });
  it('recovers an uncertain close without repeating its side effect', async () => {
    await persistClosureChoice(path, true);
    close.mockImplementationOnce(async () => {
      closed = true;
      throw new Error('lost response');
    });
    expect(await finishIssueClosure(path, '42', 'local')).toBe(1);
    expect(await loadTaskPlan(path)).toMatchObject({
      lastError: { category: 'issue_closure' },
      completedAt: null,
    });
    expect(await finishIssueClosure(path, '42', 'local')).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
