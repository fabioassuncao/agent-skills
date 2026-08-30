import { describe, expect, it } from 'vitest';
import {
  independenceLabel,
  parseStructuredReview,
  reviewerPermission,
  selectReviewer,
} from './reviewer.js';

describe('selectReviewer', () => {
  it('prefers a different harness and vendor', () => {
    const pick = selectReviewer('claude', ['claude', 'codex']);
    expect(pick.provider).toBe('codex');
    expect(pick.independence).toBe('harness-and-vendor');
    expect(pick.degraded).toBe(false);
  });

  it('degrades with a label when only one harness is installed', () => {
    const pick = selectReviewer('claude', ['claude']);
    expect(pick.provider).toBe('claude');
    expect(pick.independence).toBe('none');
    expect(pick.degraded).toBe(true);
    expect(independenceLabel(pick.independence)).toMatch(/no independent/);
  });

  it('honours a configured pairing when that harness is installed', () => {
    const pick = selectReviewer('claude', ['claude', 'cursor'], { claude: 'cursor' });
    expect(pick.provider).toBe('cursor');
    expect(pick.reason).toMatch(/pairing/);
  });

  it('is always read-only', () => {
    expect(reviewerPermission()).toBe('read-only');
  });
});

describe('parseStructuredReview', () => {
  it('accepts a valid structured payload', () => {
    const parsed = parseStructuredReview(
      JSON.stringify({
        status: 'failed',
        findings: [
          {
            file: 'src/a.ts',
            line: 4,
            severity: 'error',
            category: 'bug',
            claim: 'off-by-one',
          },
        ],
      }),
    );
    expect(parsed.status).toBe('failed');
    expect(parsed.findings).toHaveLength(1);
  });

  it('treats invalid structure as unverified, never green by omission', () => {
    expect(parseStructuredReview('looks good to me')).toEqual({
      status: 'unverified',
      findings: [],
    });
    expect(parseStructuredReview('{"status":"passed"}')).toEqual({
      status: 'unverified',
      findings: [],
    });
  });
});
