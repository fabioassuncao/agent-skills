import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskPlan } from '../types.js';
import {
  PIPELINE_PHASES,
  PIPELINE_PHASES_NO_BRANCH,
  PIPELINE_PHASES_WITH_PR_REVIEW,
  PipelineManager,
} from './pipeline.js';

// Mock state-manager
vi.mock('./state-manager.js', () => ({
  loadTaskPlan: vi.fn(),
  saveTaskPlan: vi.fn(),
}));

function makePlan(overrides: Partial<TaskPlan['pipeline']> = {}): TaskPlan {
  return {
    project: 'test',
    issueNumber: 1,
    issueUrl: '',
    branchName: 'test-branch',
    description: '',
    issueStatus: 'pending',
    completedAt: null,
    lastAttemptAt: null,
    lastError: null,
    correctionCycle: 0,
    maxCorrectionCycles: 3,
    pipeline: {
      prdCompleted: false,
      jsonCompleted: false,
      executionCompleted: false,
      reviewCompleted: false,
      prCreated: false,
      ...overrides,
    },
    userStories: [],
  };
}

describe('PipelineManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getNextPhase', () => {
    it('returns prd for a fresh plan (init has no state)', () => {
      const mgr = new PipelineManager(makePlan(), '/tmp/tasks.json');
      // init is always "complete" since it has no persisted state
      expect(mgr.getNextPhase()).toBe('prd');
    });

    it('returns null when all phases are complete', () => {
      const mgr = new PipelineManager(
        makePlan({
          prdCompleted: true,
          jsonCompleted: true,
          executionCompleted: true,
          reviewCompleted: true,
          prCreated: true,
        }),
        '/tmp/tasks.json',
      );
      expect(mgr.getNextPhase()).toBeNull();
    });

    it('skips to execute when prd and plan phases are complete', () => {
      const mgr = new PipelineManager(
        makePlan({
          prdCompleted: true,
          jsonCompleted: true,
        }),
        '/tmp/tasks.json',
      );
      expect(mgr.getNextPhase()).toBe('execute');
    });

    it('handles old tasks.json with analyzeCompleted field', () => {
      const mgr = new PipelineManager(makePlan({ analyzeCompleted: true }), '/tmp/tasks.json');
      // analyzeCompleted is ignored; pipeline starts from prd
      expect(mgr.getNextPhase()).toBe('prd');
    });
  });

  describe('canResume', () => {
    it('can always resume from prd (first runnable phase)', () => {
      const mgr = new PipelineManager(makePlan(), '/tmp/tasks.json');
      expect(mgr.canResume('prd')).toBe(true);
    });

    it('can resume from execute if all prior phases are complete', () => {
      const mgr = new PipelineManager(
        makePlan({
          prdCompleted: true,
          jsonCompleted: true,
        }),
        '/tmp/tasks.json',
      );
      expect(mgr.canResume('execute')).toBe(true);
    });

    it('cannot resume from execute if plan is incomplete', () => {
      const mgr = new PipelineManager(
        makePlan({
          prdCompleted: true,
        }),
        '/tmp/tasks.json',
      );
      expect(mgr.canResume('execute')).toBe(false);
    });
  });

  describe('markPhaseComplete', () => {
    it('persists the phase completion', async () => {
      const { saveTaskPlan } = await import('./state-manager.js');
      const mgr = new PipelineManager(makePlan(), '/tmp/tasks.json');

      await mgr.markPhaseComplete('prd');

      expect(saveTaskPlan).toHaveBeenCalledWith(
        '/tmp/tasks.json',
        expect.objectContaining({
          pipeline: expect.objectContaining({ prdCompleted: true }),
        }),
      );
    });

    it('does nothing for init phase', async () => {
      const { saveTaskPlan } = await import('./state-manager.js');
      const mgr = new PipelineManager(makePlan(), '/tmp/tasks.json');

      await mgr.markPhaseComplete('init');

      expect(saveTaskPlan).not.toHaveBeenCalled();
    });
  });

  describe('isPhaseComplete', () => {
    it('init is always complete', () => {
      const mgr = new PipelineManager(makePlan(), '/tmp/tasks.json');
      expect(mgr.isPhaseComplete('init')).toBe(true);
    });

    it('prd is incomplete by default', () => {
      const mgr = new PipelineManager(makePlan(), '/tmp/tasks.json');
      expect(mgr.isPhaseComplete('prd')).toBe(false);
    });
  });

  it('defines 6 pipeline phases in order', () => {
    expect(PIPELINE_PHASES).toEqual(['init', 'prd', 'plan', 'execute', 'review', 'pr']);
  });

  describe('pr-review phase', () => {
    const allDefaultPhasesComplete = {
      prdCompleted: true,
      jsonCompleted: true,
      executionCompleted: true,
      reviewCompleted: true,
      prCreated: true,
    };

    it('appends pr-review to the default set without mutating it', () => {
      expect(PIPELINE_PHASES_WITH_PR_REVIEW).toEqual([...PIPELINE_PHASES, 'pr-review']);
      expect(PIPELINE_PHASES).not.toContain('pr-review');
    });

    it('is excluded from the --no-branch set', () => {
      expect(PIPELINE_PHASES_NO_BRANCH).toEqual(['init', 'prd', 'plan', 'execute', 'review']);
    });

    it('does not reopen the pipeline when prReviewCompleted is absent', () => {
      const mgr = new PipelineManager(makePlan(allDefaultPhasesComplete), '/tmp/tasks.json');
      expect(mgr.getNextPhase()).toBeNull();
    });

    it('does not reopen the pipeline when prReviewCompleted is false', () => {
      const mgr = new PipelineManager(
        makePlan({ ...allDefaultPhasesComplete, prReviewCompleted: false }),
        '/tmp/tasks.json',
      );
      expect(mgr.getNextPhase()).toBeNull();
    });

    it('is the next phase when the opt-in set is active', () => {
      const mgr = new PipelineManager(
        makePlan({ ...allDefaultPhasesComplete, prReviewCompleted: false }),
        '/tmp/tasks.json',
        PIPELINE_PHASES_WITH_PR_REVIEW,
      );
      expect(mgr.getNextPhase()).toBe('pr-review');
      expect(mgr.canResume('pr-review')).toBe(true);
    });

    it('cannot resume from pr-review while pr is incomplete', () => {
      const mgr = new PipelineManager(
        makePlan({ ...allDefaultPhasesComplete, prCreated: false }),
        '/tmp/tasks.json',
        PIPELINE_PHASES_WITH_PR_REVIEW,
      );
      expect(mgr.canResume('pr-review')).toBe(false);
    });

    it('persists prReviewCompleted through markPhaseComplete', async () => {
      const { saveTaskPlan } = await import('./state-manager.js');
      const mgr = new PipelineManager(
        makePlan(allDefaultPhasesComplete),
        '/tmp/tasks.json',
        PIPELINE_PHASES_WITH_PR_REVIEW,
      );

      await mgr.markPhaseComplete('pr-review');

      expect(saveTaskPlan).toHaveBeenCalledWith(
        '/tmp/tasks.json',
        expect.objectContaining({
          pipeline: expect.objectContaining({ prReviewCompleted: true }),
        }),
      );
    });
  });
});
