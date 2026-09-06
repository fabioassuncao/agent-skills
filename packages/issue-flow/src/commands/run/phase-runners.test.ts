import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryPublisher } from '../../core/session-state.js';
import { type BuildRunnersInput, buildInstrumentedPhaseRunners } from './phase-runners.js';

const state = vi.hoisted(() => ({ cycle: 2, reviews: 0 }));
const execute = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../execute.js', () => ({ runExecute: execute }));
vi.mock('../prd.js', () => ({ runPrd: vi.fn() }));
vi.mock('../plan.js', () => ({ runPlan: vi.fn() }));
vi.mock('../pr.js', () => ({ runPr: vi.fn() }));
vi.mock('../pr-review.js', () => ({ runPrReview: vi.fn() }));
vi.mock('../review.js', () => ({ runReview: async () => (++state.reviews === 1 ? 1 : 0) }));
vi.mock('../../core/state-manager.js', async (original) => ({
  ...(await original<typeof import('../../core/state-manager.js')>()),
  loadTaskPlan: async () => ({
    correctionCycle: state.cycle,
    maxCorrectionCycles: 3,
    lastError: null,
  }),
  saveTaskPlan: async (_path: string, plan: { correctionCycle: number }) => {
    state.cycle = plan.correctionCycle;
  },
}));
vi.mock('../../core/session-git.js', () => ({ publishGitState: async () => {} }));
vi.mock('./publish.js', () => ({ publishInstrumentedPhaseEnd: async () => {} }));

beforeEach(() => {
  state.cycle = 2;
  state.reviews = 0;
  execute.mockClear();
});

function review() {
  const { instrumentedRunners } = buildInstrumentedPhaseRunners({
    issueNumber: '42',
    tasksPath: '/fixture/tasks.json',
    publisher: new MemoryPublisher(),
    executeRetry: {},
    branchState: {},
  } as BuildRunnersInput);
  return instrumentedRunners.review!();
}

it('resumes the remaining correction budget instead of resetting it', async () => {
  await review();
  expect(state.cycle).toBe(3);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('does not execute another correction after the persisted budget is exhausted', async () => {
  state.cycle = 3;
  await expect(review()).rejects.toThrow('after 3 correction cycles');
  expect(execute).not.toHaveBeenCalled();
});
