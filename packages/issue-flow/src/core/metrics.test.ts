import { describe, expect, it } from 'vitest';
import {
  divideUsage,
  formatTokens,
  hasUsageData,
  parseCodexUsage,
  parseUsage,
  sumUsage,
} from './metrics.js';

/** Shape emitted by `claude --output-format json` (CLI 2.1.220), trimmed. */
const CURRENT_CLI_PAYLOAD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 8123,
  num_turns: 3,
  result: 'Done.',
  session_id: '1f4e2c60-0000-4000-8000-000000000000',
  total_cost_usd: 0.16072345,
  usage: {
    input_tokens: 2,
    output_tokens: 4,
    cache_read_input_tokens: 15_000,
    cache_creation_input_tokens: 500,
    service_tier: 'standard',
  },
};

/** Shape the old parser expected — flat keys, no nested `usage`. */
const LEGACY_PAYLOAD = {
  result: 'Analysis complete',
  cost_usd: 0.05,
  num_input_tokens: 1000,
  num_output_tokens: 500,
};

describe('parseUsage', () => {
  it('parses the current CLI payload including cache tokens and cost', () => {
    expect(parseUsage(CURRENT_CLI_PAYLOAD)).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 15_000,
      cacheCreationTokens: 500,
      costUsd: 0.16072345,
    });
  });

  it('falls back to the legacy flat keys', () => {
    expect(parseUsage(LEGACY_PAYLOAD)).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.05,
    });
  });

  it('prefers the modern keys over the legacy ones when both are present', () => {
    const usage = parseUsage({
      total_cost_usd: 0.9,
      cost_usd: 0.1,
      num_input_tokens: 111,
      num_output_tokens: 222,
      usage: { input_tokens: 7, output_tokens: 8 },
    });

    expect(usage).toEqual({ inputTokens: 7, outputTokens: 8, costUsd: 0.9 });
  });

  it('returns a partial object when only some fields exist', () => {
    expect(parseUsage({ usage: { input_tokens: 42 } })).toEqual({ inputTokens: 42 });
    expect(parseUsage({ total_cost_usd: 0.25 })).toEqual({ costUsd: 0.25 });
  });

  it('returns null when the payload has no usage information', () => {
    expect(parseUsage({ result: 'no metrics here', is_error: false })).toBeNull();
    expect(parseUsage({ usage: {} })).toBeNull();
  });

  it('returns null for malformed payloads instead of throwing', () => {
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage(undefined)).toBeNull();
    expect(parseUsage('not an object')).toBeNull();
    expect(parseUsage(42)).toBeNull();
    expect(parseUsage([])).toBeNull();
    expect(parseUsage({ usage: 'broken', total_cost_usd: 'free' })).toBeNull();
  });

  it('ignores non-finite and non-numeric values', () => {
    expect(parseUsage({ usage: { input_tokens: Number.NaN, output_tokens: '5' } })).toBeNull();
    expect(parseUsage({ total_cost_usd: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('keeps explicit zeros, which are reported values rather than absences', () => {
    expect(parseUsage({ usage: { input_tokens: 0 } })).toEqual({ inputTokens: 0 });
  });
});

describe('parseCodexUsage', () => {
  it('subtracts cached tokens from input and never reports cost', () => {
    expect(
      parseCodexUsage({
        input_tokens: 21924,
        cached_input_tokens: 11008,
        cache_write_input_tokens: 4,
        output_tokens: 194,
        reasoning_output_tokens: 10,
      }),
    ).toEqual({
      inputTokens: 21924 - 11008,
      outputTokens: 194,
      cacheReadTokens: 11008,
      cacheCreationTokens: 4,
    });
  });

  it('returns null when usage is absent, never zeros', () => {
    expect(parseCodexUsage(null)).toBeNull();
    expect(parseCodexUsage({})).toBeNull();
  });
});

describe('sumUsage', () => {
  it('sums field by field', () => {
    const total = sumUsage(
      { inputTokens: 10, outputTokens: 5, costUsd: 0.1 },
      { inputTokens: 3, outputTokens: 2, costUsd: 0.2 },
    );

    expect(total.inputTokens).toBe(13);
    expect(total.outputTokens).toBe(7);
    expect(total.costUsd).toBeCloseTo(0.3, 10);
  });

  it('preserves undefined when both sides are undefined', () => {
    const total = sumUsage({ inputTokens: 10 }, { inputTokens: 3 });

    expect(total).toEqual({ inputTokens: 13 });
    expect('outputTokens' in total).toBe(false);
    expect('costUsd' in total).toBe(false);
  });

  it('carries a one-sided field over untouched', () => {
    expect(sumUsage({ inputTokens: 10 }, { cacheReadTokens: 4 })).toEqual({
      inputTokens: 10,
      cacheReadTokens: 4,
    });
  });

  it('accepts null and undefined operands', () => {
    expect(sumUsage(null, { inputTokens: 5 })).toEqual({ inputTokens: 5 });
    expect(sumUsage({ inputTokens: 5 }, undefined)).toEqual({ inputTokens: 5 });
    expect(sumUsage(null, null)).toEqual({});
  });

  it('does not mutate its operands', () => {
    const a = { inputTokens: 1 };
    const b = { inputTokens: 2 };

    sumUsage(a, b);

    expect(a).toEqual({ inputTokens: 1 });
    expect(b).toEqual({ inputTokens: 2 });
  });
});

describe('divideUsage', () => {
  it('splits every reported field evenly, rounding tokens to integers', () => {
    expect(
      divideUsage(
        {
          inputTokens: 10,
          outputTokens: 7,
          cacheReadTokens: 5,
          cacheCreationTokens: 4,
          costUsd: 1,
        },
        3,
      ),
    ).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
      costUsd: 1 / 3,
    });
  });

  it('keeps the cost at full precision instead of rounding it', () => {
    expect(divideUsage({ costUsd: 0.1607 }, 2)).toEqual({ costUsd: 0.08035 });
  });

  it('returns the usage unchanged for one part or fewer', () => {
    const usage = { inputTokens: 9, costUsd: 0.5 };

    expect(divideUsage(usage, 1)).toEqual(usage);
    expect(divideUsage(usage, 0)).toEqual(usage);
    expect(divideUsage(usage, Number.NaN)).toEqual(usage);
  });

  it('leaves unreported fields absent rather than turning them into zeros', () => {
    expect(divideUsage({ inputTokens: 4 }, 2)).toEqual({ inputTokens: 2 });
  });

  it('returns an empty usage for null and undefined', () => {
    expect(divideUsage(null, 2)).toEqual({});
    expect(divideUsage(undefined, 2)).toEqual({});
  });

  it('does not mutate its operand', () => {
    const usage = { inputTokens: 10 };

    divideUsage(usage, 2);

    expect(usage).toEqual({ inputTokens: 10 });
  });
});

describe('formatTokens', () => {
  it('formats a full usage', () => {
    expect(formatTokens(parseUsage(CURRENT_CLI_PAYLOAD))).toBe(
      '2 in / 4 out · 15.5k cache · ~$0.1607',
    );
  });

  it('omits the cost segment when there is no cost', () => {
    expect(formatTokens({ inputTokens: 1200, outputTokens: 340 })).toBe('1.2k in / 340 out');
  });

  it('omits the token segments when only cost is known', () => {
    expect(formatTokens({ costUsd: 1.5 })).toBe('~$1.5000');
  });

  it('sums both cache counters into a single segment', () => {
    expect(formatTokens({ cacheReadTokens: 1_000_000, cacheCreationTokens: 400_000 })).toBe(
      '1.4M cache',
    );
    expect(formatTokens({ cacheCreationTokens: 250 })).toBe('250 cache');
  });

  it('returns an empty string when there is nothing to show', () => {
    expect(formatTokens(null)).toBe('');
    expect(formatTokens(undefined)).toBe('');
    expect(formatTokens({})).toBe('');
  });
});

describe('hasUsageData', () => {
  it('detects presence of any reported field', () => {
    expect(hasUsageData({ inputTokens: 0 })).toBe(true);
    expect(hasUsageData({ costUsd: 0.1 })).toBe(true);
  });

  it('is false for empty, null and undefined usages', () => {
    expect(hasUsageData({})).toBe(false);
    expect(hasUsageData(null)).toBe(false);
    expect(hasUsageData(undefined)).toBe(false);
  });
});
