import { describe, expect, it, vi } from 'vitest';
import { runHeadless } from '../core/headless.js';
import {
  buildReviewContext,
  independenceLabel,
  parseStructuredReview,
  reviewerPermission,
  runIndependentReview,
  selectReviewer,
} from './reviewer.js';

vi.mock('../core/headless.js', async (original) => ({
  ...(await original<typeof import('../core/headless.js')>()),
  runHeadless: vi.fn(),
}));

it('never adopts approval text from a failed reviewer invocation', async () => {
  vi.mocked(runHeadless).mockResolvedValueOnce({
    success: false,
    result: '{"status":"passed","findings":[]}',
    error: 'timeout',
    cost: null,
  });
  expect(
    await runIndependentReview({
      producer: 'claude',
      available: ['claude', 'codex'],
      promptContext: 'Fixture work',
    }),
  ).toMatchObject({ status: 'unverified' });
  expect(runHeadless).toHaveBeenCalledWith(
    expect.objectContaining({
      permission: 'read-only',
      purpose: 'verify',
      forceProvider: 'codex',
    }),
  );
});

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
  it.each([
    '{"status":"passed","findings":[{"severity":"error","category":"bug","claim":"broken"}]}',
    '{"status":"failed","findings":[]}',
    '{"status":"failed","findings":[{"severity":"error","category":"bug","claim":" "}]}',
    '{"status":"failed","findings":[{"severity":"error","category":"bug","claim":"broken","line":-1}]}',
    'prefix {"status":"passed","findings":[]}',
  ])('does not approve an invalid or contradictory review: %s', (text) => {
    expect(parseStructuredReview(text).status).toBe('unverified');
  });

  it('identifies the work and evidence without embedding check output', () => {
    const prompt = buildReviewContext({
      cwd: '/repo',
      head: 'abc',
      tasksPath: '/state/tasks.json',
      prdPath: '/state/prd.md',
      evidencePath: '/state/verify.json',
      contract: {
        verdict: 'passed',
        level: 'L1',
        results: [
          {
            id: 'test',
            command: 'npm test',
            status: 'passed',
            fatal: true,
            exitCode: 0,
            durationMs: 1,
            output: 'unneeded full log',
          },
        ],
      },
    });
    expect(prompt).toContain('/state/tasks.json');
    expect(prompt).toContain('npm test');
    expect(prompt).toContain('unverified');
    expect(prompt).not.toContain('unneeded full log');
  });
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
