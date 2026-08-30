import { describe, expect, it } from 'vitest';
import type { TaskPlan, UserStory } from '../types.js';
import {
  assessDecomposition,
  buildDecompositionReport,
  DECOMPOSITION_THRESHOLDS,
  proposeSubIssues,
} from './decompose.js';

function story(id: string, priority: number, passes = false): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: '',
    acceptanceCriteria: [],
    priority,
    passes,
    notes: '',
  };
}

function plan(stories: UserStory[]): TaskPlan {
  return {
    project: 'widgets',
    issueNumber: 63,
    issueUrl: '',
    branchName: 'issue/63-work',
    description: 'Resilience epic',
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
  } as TaskPlan;
}

function journal(events: Record<string, unknown>[]): string {
  return `${events.map((event, index) => JSON.stringify({ seq: index + 1, event })).join('\n')}\n`;
}

const manyStories = Array.from({ length: 20 }, (_, index) =>
  story(`US-${String(index + 1).padStart(3, '0')}`, index + 1),
);

describe('one signal is never enough', () => {
  it('does not call an issue oversized on a long plan alone', () => {
    const assessment = assessDecomposition({ plan: plan(manyStories) });

    expect(assessment.signals.map((signal) => signal.id)).toEqual(['story-count']);
    expect(assessment.oversized).toBe(false);
  });

  it('does not call an issue oversized on repeated timeouts alone', () => {
    const assessment = assessDecomposition({
      journal: journal([
        { type: 'phase:start', at: 'a', phase: 'prd' },
        { type: 'retry', at: 'b', attempt: 1, kind: 'timeout', reason: 'claude timed out' },
        { type: 'retry', at: 'c', attempt: 2, kind: 'timeout', reason: 'claude timed out' },
      ]),
    });

    expect(assessment.signals.map((signal) => signal.id)).toEqual(['repeated-timeouts']);
    expect(assessment.oversized).toBe(false);
  });
});

describe('two signals agreeing', () => {
  it('is what makes an issue oversized', () => {
    const assessment = assessDecomposition({
      plan: plan(manyStories),
      journal: journal([
        { type: 'phase:start', at: 'a', phase: 'execute' },
        { type: 'retry', at: 'b', attempt: 1, kind: 'timeout', reason: 'timed out' },
        { type: 'retry', at: 'c', attempt: 2, kind: 'timeout', reason: 'timed out' },
      ]),
    });

    expect(assessment.oversized).toBe(true);
    expect(assessment.signals).toHaveLength(2);
    // Every signal names the number that crossed the line: "this is too big" is
    // not an argument, "the execute phase timed out twice" is.
    expect(assessment.signals[0]?.detail).toContain('2 times');
    expect(assessment.signals[1]?.detail).toContain('20 user stories');
  });

  it('counts a big diff and a big issue body', () => {
    const assessment = assessDecomposition({
      filesTouched: DECOMPOSITION_THRESHOLDS.filesTouched + 1,
      issueBody: 'x'.repeat(DECOMPOSITION_THRESHOLDS.issueBodyChars + 1),
    });

    expect(assessment.oversized).toBe(true);
    expect(assessment.signals.map((signal) => signal.id)).toEqual(['files-touched', 'issue-size']);
  });

  it('counts iterations in a row that completed nothing', () => {
    const iterations = Array.from({ length: 6 }, (_, index) => ({
      type: 'iteration:start',
      at: `t${index}`,
      iteration: index + 1,
    }));

    const assessment = assessDecomposition({
      journal: journal(iterations),
      plan: plan(manyStories),
    });

    const barren = assessment.signals.find((signal) => signal.id === 'barren-iterations');
    expect(barren?.detail).toContain('6 iterations');
  });

  it('resets the barren run whenever a story starts passing', () => {
    const assessment = assessDecomposition({
      journal: journal([
        { type: 'iteration:start', at: 'a', iteration: 1 },
        { type: 'iteration:start', at: 'b', iteration: 2 },
        { type: 'stories:update', at: 'c', stories: [story('US-001', 1, true)] },
        { type: 'iteration:start', at: 'd', iteration: 3 },
        { type: 'iteration:start', at: 'e', iteration: 4 },
      ]),
    });

    // Four iterations, but never five in a row without progress.
    expect(assessment.signals.some((signal) => signal.id === 'barren-iterations')).toBe(false);
  });
});

describe('an infrastructural failure is not an oversized issue', () => {
  it('ignores a run that failed only because the network went down', () => {
    // Eight network retries and a plan of normal size: the run died of the
    // outage, and "have you considered splitting this issue?" would be the
    // worst possible response.
    const assessment = assessDecomposition({
      plan: plan([story('US-001', 1), story('US-002', 2)]),
      journal: journal([
        { type: 'phase:start', at: 'a', phase: 'prd' },
        ...Array.from({ length: 8 }, (_, index) => ({
          type: 'retry',
          at: `t${index}`,
          attempt: index + 1,
          kind: 'network',
          reason: 'dial tcp: lookup api.github.com: no such host',
        })),
        { type: 'phase:end', at: 'z', phase: 'prd', success: false, error: 'network' },
      ]),
      filesTouched: 3,
    });

    expect(assessment.signals).toEqual([]);
    expect(assessment.oversized).toBe(false);
  });

  it('ignores rate-limit retries too', () => {
    const assessment = assessDecomposition({
      journal: journal([
        { type: 'phase:start', at: 'a', phase: 'prd' },
        { type: 'retry', at: 'b', attempt: 1, kind: 'rate_limit', reason: 'API rate limit' },
        { type: 'retry', at: 'c', attempt: 2, kind: 'rate_limit', reason: 'API rate limit' },
      ]),
    });

    expect(assessment.oversized).toBe(false);
  });
});

describe('proposeSubIssues', () => {
  it('cuts the pending stories in priority order, five at a time', () => {
    const proposals = proposeSubIssues(plan(manyStories));

    expect(proposals).toHaveLength(4);
    expect(proposals[0]?.stories.map((s) => s.id)).toEqual([
      'US-001',
      'US-002',
      'US-003',
      'US-004',
      'US-005',
    ]);
    // Each piece waits for the one before it — the only dependency shape that
    // can be derived from the plan alone.
    expect(proposals[0]?.dependsOn).toEqual([]);
    expect(proposals[1]?.dependsOn).toEqual([proposals[0]?.title]);
  });

  it('ignores the stories that already pass', () => {
    const proposals = proposeSubIssues(
      plan([story('US-001', 1, true), story('US-002', 2), story('US-003', 3)]),
    );

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.stories.map((s) => s.id)).toEqual(['US-002', 'US-003']);
  });

  it('proposes nothing when there is nothing pending', () => {
    expect(proposeSubIssues(plan([story('US-001', 1, true)]))).toEqual([]);
    expect(proposeSubIssues(null)).toEqual([]);
  });
});

describe('the report', () => {
  it('states the signals, the cut and what to do — and never acts', () => {
    const assessment = assessDecomposition({
      plan: plan(manyStories),
      filesTouched: 100,
    });

    const report = buildDecompositionReport({
      issueNumber: '63',
      assessment,
      plan: plan(manyStories),
      at: '2026-08-30T03:00:00.000Z',
    });

    expect(report).toContain('# Issue #63 looks larger than one run');
    expect(report).toContain('This is a report, not an action.');
    expect(report).toContain('## What was detected');
    expect(report).toContain('20 user stories');
    expect(report).toContain('100 files');
    expect(report).toContain('## Proposed split');
    expect(report).toContain('US-001');
    expect(report).toContain('Depends on:');
    expect(report).toContain('## What to do next');
  });

  it('says so plainly when there is nothing left to cut', () => {
    const finished = plan([story('US-001', 1, true)]);

    const report = buildDecompositionReport({
      issueNumber: '63',
      assessment: assessDecomposition({
        plan: finished,
        filesTouched: 100,
        hitMaxIterations: true,
      }),
      plan: finished,
      at: '2026-08-30T03:00:00.000Z',
    });

    expect(report).toContain('nothing to cut here');
  });
});
