import { describe, expect, it } from 'vitest';
import {
  compactTokens,
  formatCost,
  formatDuration,
  formatTotals,
  formatUsage,
  itemSideText,
  metric,
  parseIso,
  repoUrlFromIssueUrl,
  truncateText,
} from './format';

/**
 * **U13** (metrics) and half of **U18** (backwards compatibility).
 *
 * `formatUsage` has a contract outside this file: it mirrors `formatTokens()`
 * in `packages/issue-flow/src/core/metrics.ts` — same segment order, same
 * compaction. The one deliberate divergence is the cost, and it is asserted
 * here so it stays deliberate.
 */

describe('metric', () => {
  it('treats undefined, null and NaN alike, and keeps zero', () => {
    // The trap `web/AGENTS.md` names: `undefined` ≠ `null` ≠ `0`. The first two
    // mean "not reported"; the third is a value.
    expect(metric(undefined)).toBeNull();
    expect(metric(null)).toBeNull();
    expect(metric(Number.NaN)).toBeNull();
    expect(metric(Number.POSITIVE_INFINITY)).toBeNull();
    expect(metric('12')).toBeNull();
    expect(metric(0)).toBe(0);
    expect(metric(-3)).toBe(-3);
  });
});

describe('compactTokens', () => {
  it('compacts thousands and millions the way the terminal summary does', () => {
    expect(compactTokens(999)).toBe('999');
    expect(compactTokens(1523)).toBe('1.5k');
    expect(compactTokens(2_400_000)).toBe('2.4M');
  });
});

describe('formatCost', () => {
  it('uses four decimals below a cent and two above it', () => {
    expect(formatCost(0.0042)).toBe('~$0.0042');
    expect(formatCost(0.42)).toBe('~$0.42');
    expect(formatCost(1.5, false)).toBe('$1.50');
  });
});

describe('formatUsage', () => {
  it('produces the same segments, in the same order, as core/metrics.ts', () => {
    expect(
      formatUsage({
        inputTokens: 12_400,
        outputTokens: 3100,
        cacheReadTokens: 80_000,
        cacheCreationTokens: 8000,
        costUsd: 0.42,
      }),
    ).toBe('12.4k in / 3.1k out · 88.0k cache · ~$0.42');
  });

  it('omits a segment with no data, and returns "" with none at all', () => {
    expect(formatUsage({ inputTokens: 10 })).toBe('10 in');
    expect(formatUsage({})).toBe('');
    expect(formatUsage(null)).toBe('');
    expect(formatUsage(undefined)).toBe('');
  });

  it('never renders a missing count as zero (U18)', () => {
    // An old session.json has none of these fields. Nothing may reach the
    // screen as `0 in / 0 out` or as NaN.
    const rendered = formatUsage({
      inputTokens: undefined,
      outputTokens: null,
      costUsd: null,
    });
    expect(rendered).toBe('');
    expect(rendered).not.toContain('NaN');
  });

  it('counts a cache half that is present even when the other is not', () => {
    expect(formatUsage({ cacheReadTokens: 1000, cacheCreationTokens: null })).toBe('1.0k cache');
  });
});

describe('formatTotals', () => {
  it('translates the issue-wide total* names before formatting', () => {
    expect(
      formatTotals({
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        totalCostUsd: 3,
      }),
    ).toBe('1.0k in / 2.0k out · ~$3.00');
  });

  it('returns "" for a snapshot with no metrics section (U18)', () => {
    expect(formatTotals(null)).toBe('');
    expect(formatTotals({})).toBe('');
  });
});

describe('formatDuration', () => {
  it('scales from seconds to hours and refuses to invent a value', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(125)).toBe('2min 05s');
    expect(formatDuration(3725)).toBe('1h 02min');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('parseIso', () => {
  it('rejects everything that is not a parseable timestamp', () => {
    expect(parseIso('2026-09-06T10:00:00.000Z')).toBe(Date.parse('2026-09-06T10:00:00.000Z'));
    expect(parseIso('')).toBeNull();
    expect(parseIso(null)).toBeNull();
    expect(parseIso(undefined)).toBeNull();
    expect(parseIso('nope')).toBeNull();
  });
});

describe('itemSideText', () => {
  it('drops empty parts, because "" is the signal not to render the slot', () => {
    expect(itemSideText(['12s', '', null, '1.0k in'])).toBe('12s · 1.0k in');
    expect(itemSideText(['', null, undefined])).toBe('');
  });
});

describe('truncateText', () => {
  it('normalises whitespace and ellipsises past the limit', () => {
    expect(truncateText('  a   b  ', 10)).toBe('a b');
    expect(truncateText('abcdefghij', 5)).toBe('abcd…');
    expect(truncateText(null, 5)).toBe('');
  });
});

describe('repoUrlFromIssueUrl', () => {
  it('derives the repository root only from a real issue URL', () => {
    expect(repoUrlFromIssueUrl('https://github.com/a/b/issues/42')).toBe('https://github.com/a/b');
    expect(repoUrlFromIssueUrl('https://github.com/a/b/pull/42')).toBeNull();
    expect(repoUrlFromIssueUrl(null)).toBeNull();
  });
});
