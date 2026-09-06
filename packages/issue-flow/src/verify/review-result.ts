/** Portable issue-review protocol. No host, filesystem or orchestration dependencies. */
export type IssueReviewParse =
  | { ok: true; status: 'PASS' | 'FAIL'; findings?: string }
  | { ok: false; error: string };

export function parseIssueReviewResult(output: string): IssueReviewParse {
  const blocks = [...output.matchAll(/<review-result>([\s\S]*?)<\/review-result>/g)];
  if (
    blocks.length !== 1 ||
    (output.match(/<\/?review-result>/g)?.length ?? 0) !== 2 ||
    !output.trimEnd().endsWith('</review-result>')
  ) {
    return { ok: false, error: 'Expected exactly one final <review-result> block.' };
  }
  const body = blocks[0][1].trim();
  if (body === 'STATUS: PASS') return { ok: true, status: 'PASS' };
  const failure = body.match(/^STATUS: FAIL\s*\r?\nFINDINGS:\s*\r?\n([\s\S]+)$/);
  if (failure && !/^STATUS:/m.test(failure[1])) {
    const lines = failure[1].trim().split(/\r?\n/);
    if (lines.every((line) => /^-\s+\S/.test(line))) {
      return { ok: true, status: 'FAIL', findings: lines.join('\n') };
    }
  }
  return { ok: false, error: 'Invalid review status or findings; no approval inferred.' };
}
