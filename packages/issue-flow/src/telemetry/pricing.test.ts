import { describe, expect, it } from 'vitest';
import { estimateCost, PRICING_TABLE_VERSION, resolveCost } from './pricing.js';

const usage = {
  source: 'provider' as const,
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
};

describe('pricing', () => {
  it('passes a reported cost through unchanged', () => {
    expect(
      resolveCost({
        reportedUsd: 0,
        usage,
        modelKey: 'claude-sonnet-4',
        estimate: true,
      }),
    ).toEqual({ status: 'reported', amount: 0, currency: 'USD' });
  });

  it('estimates and stores the snapshot used', () => {
    const cost = estimateCost(usage, 'claude-sonnet-4');
    expect(cost.status).toBe('estimated');
    if (cost.status !== 'estimated') return;
    expect(cost.amount).toBe(18);
    expect(cost.pricing.tableVersion).toBe(PRICING_TABLE_VERSION);
    expect(cost.pricing.inputPerMillion).toBe(3);
    expect(cost.pricing.outputPerMillion).toBe(15);
  });

  it('does not estimate unless asked', () => {
    expect(
      resolveCost({
        usage,
        modelKey: 'claude-sonnet-4',
        estimate: false,
      }),
    ).toEqual({ status: 'unknown', reason: 'not_reported' });
  });

  it('marks an unknown model', () => {
    expect(estimateCost(usage, 'not-a-model')).toEqual({
      status: 'unknown',
      reason: 'unknown_model',
    });
  });

  it('does not rewrite a historical snapshot when the table would differ', () => {
    const historical = estimateCost(usage, 'claude-sonnet-4');
    expect(historical.status).toBe('estimated');
    if (historical.status !== 'estimated') return;
    const later = resolveCost({
      usage,
      modelKey: 'claude-sonnet-4',
      estimate: true,
      overrides: { 'claude-sonnet-4': { inputPerMillion: 99, outputPerMillion: 99 } },
    });
    expect(later.status).toBe('estimated');
    if (later.status !== 'estimated') return;
    expect(later.amount).not.toBe(historical.amount);
    expect(historical.pricing.inputPerMillion).toBe(3);
  });

  it('lets overrides beat the table', () => {
    const cost = estimateCost(usage, 'claude-sonnet-4', {
      'claude-sonnet-4': { inputPerMillion: 1, outputPerMillion: 2 },
    });
    expect(cost.status).toBe('estimated');
    if (cost.status !== 'estimated') return;
    expect(cost.amount).toBe(3);
    expect(cost.pricing.inputPerMillion).toBe(1);
  });
});
