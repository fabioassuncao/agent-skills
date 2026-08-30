import { describe, expect, it } from 'vitest';
import { groupBy, summarize } from './aggregate.js';
import type { ExecutionRecord } from './types.js';

function record(
  overrides: Partial<ExecutionRecord> & Pick<ExecutionRecord, 'id' | 'cost'>,
): ExecutionRecord {
  return {
    sessionId: null,
    purpose: 'prd',
    attempt: 1,
    trigger: 'initial',
    triggerReason: null,
    agent: {
      harness: 'claude-code',
      provider: 'anthropic',
      model: { requested: null, resolved: 'claude-sonnet-4', source: 'provider' },
      providerSessionId: null,
    },
    startedAt: '2026-08-30T00:00:00Z',
    finishedAt: '2026-08-30T00:01:00Z',
    durationMs: 60_000,
    usage: { source: 'provider', inputTokens: 100, outputTokens: 20 },
    status: 'completed',
    failure: null,
    ...overrides,
  };
}

describe('aggregate', () => {
  it('keeps reported and estimated totals apart', () => {
    const summary = summarize([
      record({ id: 'a', cost: { status: 'reported', amount: 1.5, currency: 'USD' } }),
      record({
        id: 'b',
        cost: {
          status: 'estimated',
          amount: 2,
          currency: 'USD',
          pricing: {
            tableVersion: 'x',
            modelKey: 'claude-sonnet-4',
            inputPerMillion: 3,
            outputPerMillion: 15,
            capturedAt: '2026-08-30T00:00:00Z',
          },
        },
      }),
      record({ id: 'c', cost: { status: 'unknown', reason: 'not_reported' } }),
    ]);
    expect(summary.totalCost).toEqual({ reported: 1.5, estimated: 2, unknownExecutions: 1 });
    expect(summary.count).toBe(3);
    expect(summary.usage.inputTokens).toBe(300);
  });

  it('groups by harness, provider, model, purpose and status', () => {
    const records = [
      record({
        id: 'a',
        purpose: 'prd',
        cost: { status: 'reported', amount: 1, currency: 'USD' },
      }),
      record({
        id: 'b',
        purpose: 'execute',
        agent: {
          harness: 'codex-cli',
          provider: 'openai',
          model: { requested: 'gpt-5', resolved: 'gpt-5', source: 'config' },
          providerSessionId: null,
        },
        status: 'failed',
        cost: { status: 'unknown', reason: 'not_reported' },
      }),
    ];
    expect(groupBy(records, 'harness').size).toBe(2);
    expect(groupBy(records, 'provider').get('openai')?.count).toBe(1);
    expect(groupBy(records, 'model').get('gpt-5')?.count).toBe(1);
    expect(groupBy(records, 'purpose').get('prd')?.count).toBe(1);
    expect(groupBy(records, 'status').get('failed')?.count).toBe(1);
  });

  it('counts discarded executions without summing them', () => {
    const summary = summarize(
      [record({ id: 'kept', cost: { status: 'reported', amount: 1, currency: 'USD' } })],
      4,
    );
    expect(summary.count).toBe(1);
    expect(summary.discarded).toBe(4);
    expect(summary.totalCost.reported).toBe(1);
  });
});
