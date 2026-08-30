import { describe, expect, it } from 'vitest';
import { canLeaveBlocked, evaluateCeilings, spendFromCost } from './budget.js';

describe('evaluateCeilings', () => {
  it('treats null as no ceiling', () => {
    expect(
      evaluateCeilings({
        spent: { reportedUsd: 99, costStatus: 'reported', durationMs: 99_000, executions: 99 },
      }).ok,
    ).toBe(true);
  });

  it('blocks on a reported cost ceiling and never treats unknown as $0', () => {
    const hit = evaluateCeilings({
      ceilings: { maxCostUsdPerIssue: 1 },
      spent: { reportedUsd: 1.5, costStatus: 'reported', durationMs: 10, executions: 1 },
    });
    expect(hit.ok).toBe(false);
    if (hit.ok) return;
    expect(hit.stopReason).toBe('max_cost');
    expect(hit.onCeiling).toBe('block');
    expect(hit.numbers).toEqual({ spent: 1.5, ceiling: 1 });

    const unknown = evaluateCeilings({
      ceilings: { maxCostUsdPerIssue: 1 },
      spent: { reportedUsd: 0, costStatus: 'unknown', durationMs: 10, executions: 1 },
    });
    expect(unknown.ok).toBe(true);
    expect(spendFromCost({ status: 'unknown', reason: 'subscription' })).toEqual({
      reportedUsd: 0,
      costStatus: 'unknown',
    });
    expect(spendFromCost({ status: 'reported', amount: 0, currency: 'USD' }).reportedUsd).toBe(0);
  });

  it('enforces duration and executions when cost is unknown', () => {
    const duration = evaluateCeilings({
      ceilings: { maxCostUsdPerIssue: 1, maxDurationMsPerIssue: 1_000 },
      spent: { reportedUsd: 0, costStatus: 'unknown', durationMs: 2_000, executions: 1 },
    });
    expect(duration.ok).toBe(false);
    if (duration.ok) return;
    expect(duration.binding).toBe('duration');
    expect(duration.enforced).toEqual(['duration']);

    const executions = evaluateCeilings({
      ceilings: { maxExecutionsPerIssue: 2 },
      spent: { reportedUsd: 0, costStatus: 'unknown', durationMs: 10, executions: 2 },
    });
    expect(executions.ok).toBe(false);
    if (executions.ok) return;
    expect(executions.binding).toBe('executions');
  });

  it('is enforced here, not by a harness flag', () => {
    const ignoredHarnessFlag = evaluateCeilings({
      ceilings: { maxCostUsdPerIssue: 0.01 },
      spent: { reportedUsd: 5, costStatus: 'reported', durationMs: 1, executions: 1 },
    });
    expect(ignoredHarnessFlag.ok).toBe(false);
    if (ignoredHarnessFlag.ok) return;
    expect(ignoredHarnessFlag.stopReason).toBe('max_cost');
  });
});

describe('canLeaveBlocked', () => {
  it('leaves blocked only for a human', () => {
    expect(canLeaveBlocked('human')).toBe(true);
    expect(canLeaveBlocked('agent')).toBe(false);
    expect(canLeaveBlocked('pipeline')).toBe(false);
  });
});
