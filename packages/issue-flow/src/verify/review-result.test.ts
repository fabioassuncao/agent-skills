import { describe, expect, it } from 'vitest';
import { parseIssueReviewResult } from './review-result.js';

const block = (body: string) => `<review-result>\n${body}\n</review-result>`;
describe('issue review protocol', () => {
  it('accepts final explicit approval and actionable failures', () => {
    expect(parseIssueReviewResult(`Evidence before result\n${block('STATUS: PASS')}\n`)).toEqual({
      ok: true,
      status: 'PASS',
    });
    expect(
      parseIssueReviewResult(block('STATUS: FAIL\nFINDINGS:\n- Missing test\n- Broken route')),
    ).toEqual({ ok: true, status: 'FAIL', findings: '- Missing test\n- Broken route' });
  });
  it.each([
    '',
    'Everything looks fine',
    block(''),
    block('STATUS: MAYBE'),
    block('STATUS: FAIL'),
    block('STATUS: FAIL\nFINDINGS:\n- '),
    block('STATUS: PASS\nSTATUS: FAIL'),
    `${block('STATUS: PASS')} trailing`,
    `${block('STATUS: PASS')}\n${block('STATUS: PASS')}`,
    block('STATUS: PASS\nFINDINGS:\n- broken'),
  ])('never infers approval from malformed output: %s', (output) => {
    expect(parseIssueReviewResult(output).ok).toBe(false);
  });
});
