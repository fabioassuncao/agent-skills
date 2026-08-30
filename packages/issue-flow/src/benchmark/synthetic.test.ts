import { describe, expect, it } from 'vitest';
import { CORPUS, TASK_CLASSES } from './corpus.js';
import {
  p50,
  p95,
  runSyntheticCorpus,
  SYNTHETIC_BUDGETS,
  timeParse,
  timeReduce,
} from './synthetic.js';

describe('synthetic benchmark', () => {
  it('covers the four task classes on the documented axes', () => {
    const results = runSyntheticCorpus();
    expect(results.map((row) => row.task)).toEqual([...TASK_CLASSES]);
    expect(CORPUS).toHaveLength(4);
    for (const row of results) {
      expect(row.mode).toBe('synthetic');
      expect(row.harness).toBe('mocked');
      expect(row.verdict).toBe('unverified');
      expect(row.harnessExecutionDurationMs).toBeGreaterThan(0);
      expect(row.orchestrationOverheadMs).toBeGreaterThanOrEqual(0);
      expect(row.orchestrationOverheadMs).toBeLessThan(row.taskDurationMs * 0.05 + 50);
      expect(row.timeToFirstOutputMs).toBeNull();
      expect(row.attemptCount).toBe(1);
    }
  });

  it('fails CI when reducing a scripted session regresses past the budget', () => {
    const samples = timeReduce();
    expect(p95(samples)).toBeLessThan(SYNTHETIC_BUDGETS.reduceP95Ms);
    expect(p50(samples)).toBeLessThan(SYNTHETIC_BUDGETS.reduceP95Ms);
  });

  it('fails CI when snapshot parse regresses past the budget', () => {
    const samples = timeParse();
    expect(p95(samples)).toBeLessThan(SYNTHETIC_BUDGETS.parseP95Ms);
  });
});
