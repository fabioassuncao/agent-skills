import { describe, expect, it } from 'vitest';
import type { TaskPlan } from '../types.js';
import { buildUsageReport, formatUsageReport } from './usage.js';

function planWith(records: TaskPlan['executions']): TaskPlan {
  return {
    project: 'test',
    issueNumber: 63,
    issueUrl: '',
    branchName: 'feat/63-x',
    description: '',
    issueStatus: 'completed',
    completedAt: null,
    lastAttemptAt: null,
    lastError: null,
    correctionCycle: 0,
    maxCorrectionCycles: 3,
    lastReviewFindings: null,
    pipeline: {
      prdCompleted: true,
      jsonCompleted: true,
      executionCompleted: true,
      reviewCompleted: true,
      prCreated: true,
    },
    userStories: [],
    executions: records,
  };
}

const mixed = planWith([
  {
    id: '1',
    sessionId: null,
    purpose: 'prd',
    attempt: 1,
    trigger: 'initial',
    triggerReason: null,
    agent: {
      harness: 'claude-code',
      provider: 'anthropic',
      model: { requested: null, resolved: null, source: 'unavailable' },
      providerSessionId: null,
    },
    startedAt: '2026-08-30T00:00:00Z',
    finishedAt: '2026-08-30T00:01:00Z',
    durationMs: 1000,
    usage: { source: 'provider', inputTokens: 10, outputTokens: 2 },
    cost: { status: 'reported', amount: 1.25, currency: 'USD' },
    status: 'completed',
    failure: null,
  },
  {
    id: '2',
    sessionId: null,
    purpose: 'execute',
    attempt: 1,
    trigger: 'fallback',
    triggerReason: 'rate_limit',
    agent: {
      harness: 'codex-cli',
      provider: 'openai',
      model: { requested: 'gpt-5', resolved: 'gpt-5', source: 'config' },
      providerSessionId: null,
    },
    startedAt: '2026-08-30T00:02:00Z',
    finishedAt: '2026-08-30T00:03:00Z',
    durationMs: 1000,
    usage: { source: 'provider', inputTokens: 20, outputTokens: 4 },
    cost: { status: 'unknown', reason: 'not_reported' },
    status: 'completed',
    failure: null,
  },
]);

describe('usage', () => {
  it('aggregates by each grouping key without mixing reported and estimated', () => {
    for (const by of ['harness', 'provider', 'model', 'purpose', 'status'] as const) {
      const report = buildUsageReport([{ id: '63', plan: mixed }], { by, issue: '63' });
      expect(report.total.totalCost.reported).toBe(1.25);
      expect(report.total.totalCost.estimated).toBe(0);
      expect(report.total.totalCost.unknownExecutions).toBe(1);
      expect(report.groups.length).toBeGreaterThan(0);
      const json = JSON.stringify(report);
      expect(json).toContain('"reported":1.25');
    }
  });

  it('degrades with a message when nothing was recorded', () => {
    const report = buildUsageReport([{ id: '63', plan: planWith(undefined) }], { issue: '63' });
    expect(formatUsageReport(report)).toBe('No execution telemetry recorded yet.');
  });

  it('filters by --since', () => {
    const report = buildUsageReport([{ id: '63', plan: mixed }], {
      issue: '63',
      since: '2026-08-30T00:01:30Z',
    });
    expect(report.total.count).toBe(1);
    expect(report.total.totalCost.unknownExecutions).toBe(1);
  });
});
