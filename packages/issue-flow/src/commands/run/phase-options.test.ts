import { describe, expect, it } from 'vitest';
import {
  PIPELINE_PHASES,
  PIPELINE_PHASES_NO_BRANCH,
  PIPELINE_PHASES_WITH_PR_REVIEW,
} from '../../core/pipeline.js';
import {
  resolveBranchAndReviewModes,
  resolveExecuteRetry,
  resolveStoryNumbering,
  selectPhaseLists,
} from './phase-options.js';
import {
  QUEUE_PR_PHASES,
  QUEUE_PR_PHASES_WITH_REVIEW,
  RUNNABLE_PHASES,
  RUNNABLE_PHASES_NO_BRANCH,
  RUNNABLE_PHASES_WITH_PR_REVIEW,
  RUNNABLE_QUEUE_PR_PHASES,
  RUNNABLE_QUEUE_PR_PHASES_WITH_REVIEW,
} from './types.js';

describe('resolveBranchAndReviewModes — --no-branch precedence', () => {
  it('persisted no-branch wins over a conflicting CLI flag on resume', () => {
    const result = resolveBranchAndReviewModes({
      noBranch: false,
      prReview: undefined,
      persisted: {
        noBranch: true,
        prReviewEnabled: false,
        userStories: [],
      },
    });

    expect(result.effectiveNoBranch).toBe(true);
    expect(result.warnings).toEqual([
      'This pipeline was started with --no-branch. Ignoring current flag; using persisted mode.',
    ]);
  });

  it('persisted without no-branch wins when the CLI passes --no-branch on resume', () => {
    const result = resolveBranchAndReviewModes({
      noBranch: true,
      prReview: undefined,
      persisted: {
        noBranch: false,
        prReviewEnabled: false,
        userStories: [],
      },
    });

    expect(result.effectiveNoBranch).toBe(false);
    expect(result.warnings).toEqual([
      'This pipeline was started without --no-branch. Ignoring current flag; using persisted mode.',
    ]);
  });

  it('uses the CLI flag as-is when there is no persisted plan', () => {
    expect(
      resolveBranchAndReviewModes({
        noBranch: true,
        prReview: undefined,
        persisted: null,
      }).effectiveNoBranch,
    ).toBe(true);
  });
});

describe('resolveBranchAndReviewModes — --pr-review precedence', () => {
  it('CLI flag wins over a persisted disabled opt-in (unlike --no-branch)', () => {
    const result = resolveBranchAndReviewModes({
      noBranch: undefined,
      prReview: true,
      persisted: {
        noBranch: false,
        prReviewEnabled: false,
        userStories: [],
      },
    });

    expect(result.effectivePrReview).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('persisted enabled survives a resume without the flag', () => {
    const result = resolveBranchAndReviewModes({
      noBranch: undefined,
      prReview: undefined,
      persisted: {
        noBranch: false,
        prReviewEnabled: true,
        userStories: [],
      },
    });

    expect(result.effectivePrReview).toBe(true);
  });

  it('drops pr-review when persisted no-branch is on, instead of failing', () => {
    const result = resolveBranchAndReviewModes({
      noBranch: undefined,
      prReview: true,
      persisted: {
        noBranch: true,
        prReviewEnabled: true,
        userStories: [],
      },
    });

    expect(result.effectiveNoBranch).toBe(true);
    expect(result.effectivePrReview).toBe(false);
    expect(result.warnings).toContain(
      'This pipeline runs with --no-branch and opens no PR. Skipping the pr-review phase.',
    );
  });
});

describe('resolveExecuteRetry / resolveStoryNumbering', () => {
  it('leaves retry fields undefined when flags are absent', () => {
    expect(resolveExecuteRetry({})).toEqual({
      retryLimit: undefined,
      retryForever: undefined,
    });
  });

  it('forwards start-us and continue flags', () => {
    expect(resolveStoryNumbering({ startUs: 27, continueNumbering: true })).toEqual({
      continueNumbering: true,
      startUs: 27,
    });
  });
});

describe('selectPhaseLists', () => {
  it('uses the pr-review list for a standalone run', () => {
    expect(
      selectPhaseLists({
        finalPr: false,
        inQueue: false,
        effectiveNoBranch: false,
        effectivePrReview: true,
      }),
    ).toEqual({
      activePhases: PIPELINE_PHASES_WITH_PR_REVIEW,
      phaseOrder: RUNNABLE_PHASES_WITH_PR_REVIEW,
    });
  });

  it('drops pr from per-issue queue members', () => {
    expect(
      selectPhaseLists({
        finalPr: false,
        inQueue: true,
        effectiveNoBranch: false,
        effectivePrReview: true,
      }),
    ).toEqual({
      activePhases: PIPELINE_PHASES_NO_BRANCH,
      phaseOrder: RUNNABLE_PHASES_NO_BRANCH,
    });
  });

  it('uses the queue closing-pass lists', () => {
    expect(
      selectPhaseLists({
        finalPr: true,
        inQueue: true,
        effectiveNoBranch: false,
        effectivePrReview: true,
      }),
    ).toEqual({
      activePhases: QUEUE_PR_PHASES_WITH_REVIEW,
      phaseOrder: RUNNABLE_QUEUE_PR_PHASES_WITH_REVIEW,
    });
    expect(
      selectPhaseLists({
        finalPr: true,
        inQueue: true,
        effectiveNoBranch: false,
        effectivePrReview: false,
      }),
    ).toEqual({
      activePhases: QUEUE_PR_PHASES,
      phaseOrder: RUNNABLE_QUEUE_PR_PHASES,
    });
  });

  it('keeps the default list otherwise', () => {
    expect(
      selectPhaseLists({
        finalPr: false,
        inQueue: false,
        effectiveNoBranch: false,
        effectivePrReview: false,
      }),
    ).toEqual({
      activePhases: PIPELINE_PHASES,
      phaseOrder: RUNNABLE_PHASES,
    });
  });
});
