import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// prReviewDir() resolves the repository root through `git rev-parse`, which
// goes through execa — the mock answers with the temporary root.
const mockProjectRoot = vi.hoisted(() => ({ current: '' }));
vi.mock('execa', () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: mockProjectRoot.current, exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  }),
}));

import {
  buildReportMarkdown,
  parseFindings,
  parsePrReviewResult,
  prReviewDir,
  REPORT_SECTIONS,
  readPrReviewIndex,
  reportFileName,
  resolveRound,
  upsertRound,
} from './report.js';

function block(body: string): string {
  return `Some prose from the agent.\n\n<pr-review-result>\n${body}\n</pr-review-result>\n`;
}

describe('parsePrReviewResult', () => {
  it('parses APPROVE', () => {
    const parsed = parsePrReviewResult(block('RECOMMENDATION: APPROVE\nBLOCKERS:\n- none'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.recommendation).toBe('APPROVE');
    expect(parsed.result.blockers).toEqual([]);
  });

  it('parses APPROVE_WITH_SUGGESTIONS', () => {
    const parsed = parsePrReviewResult(
      block('RECOMMENDATION: APPROVE_WITH_SUGGESTIONS\nBLOCKERS:'),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.recommendation).toBe('APPROVE_WITH_SUGGESTIONS');
  });

  it('parses REQUEST_CHANGES with its blockers', () => {
    const parsed = parsePrReviewResult(
      block('RECOMMENDATION: REQUEST_CHANGES\nBLOCKERS:\n- Missing tests\n- Broken migration'),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.recommendation).toBe('REQUEST_CHANGES');
    expect(parsed.result.blockers).toEqual(['Missing tests', 'Broken migration']);
  });

  it('accepts the recommendation spelled with spaces', () => {
    const parsed = parsePrReviewResult(block('RECOMMENDATION: Approve with suggestions'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.recommendation).toBe('APPROVE_WITH_SUGGESTIONS');
  });

  it('falls back to a bare RECOMMENDATION line when the block is missing', () => {
    const parsed = parsePrReviewResult('The review is done.\nRECOMMENDATION: REQUEST_CHANGES\n');

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.recommendation).toBe('REQUEST_CHANGES');
  });

  it('fails instead of defaulting to APPROVE on malformed output', () => {
    const parsed = parsePrReviewResult('The agent rambled and never reached a verdict.');

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('RECOMMENDATION');
  });

  it('fails on an unknown recommendation', () => {
    const parsed = parsePrReviewResult(block('RECOMMENDATION: LOOKS_FINE_TO_ME'));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('LOOKS_FINE_TO_ME');
  });

  it('fails when the block carries no RECOMMENDATION line', () => {
    const parsed = parsePrReviewResult(block('BLOCKERS:\n- Something'));

    expect(parsed.ok).toBe(false);
  });
});

describe('parseFindings', () => {
  const body = [
    '## Issues found',
    '- [high] src/core/pipeline.ts:42 — Phase order is not validated',
    '- [nit] README.md — Stale command name',
    '- A prose bullet with no severity marker',
    '',
    '## Required before merge',
    '- [critical] Restore the migration rollback',
    '- [high] src/core/pipeline.ts:42 — Phase order is not validated',
    '',
    '## Strengths',
    '- [high] not-a-finding.ts:1 — Outside the scanned sections',
  ].join('\n');

  it('extracts severity, file, line and title', () => {
    const findings = parseFindings(body);

    expect(findings[0]).toEqual({
      severity: 'high',
      file: 'src/core/pipeline.ts',
      line: 42,
      title: 'Phase order is not validated',
    });
    expect(findings[1]).toEqual({
      severity: 'low',
      file: 'README.md',
      line: null,
      title: 'Stale command name',
    });
  });

  it('keeps items without a location and normalizes the severity', () => {
    const findings = parseFindings(body);
    const blocker = findings.find((finding) => finding.severity === 'blocker');

    expect(blocker).toEqual({
      severity: 'blocker',
      file: null,
      line: null,
      title: 'Restore the migration rollback',
    });
  });

  it('ignores unrelated sections and deduplicates repeated findings', () => {
    const findings = parseFindings(body);

    expect(findings).toHaveLength(3);
    expect(findings.some((finding) => finding.file === 'not-a-finding.ts')).toBe(false);
  });

  it('returns nothing when the body has no findings section', () => {
    expect(parseFindings('## Executive summary\n\nAll good.')).toEqual([]);
  });
});

describe('buildReportMarkdown', () => {
  const pullRequest = {
    number: 184,
    url: 'https://github.com/acme/repo/pull/184',
    title: 'Add the pr-review phase',
    headBranch: 'issue/25-pr-review-phase',
  };

  it('contains every required section, in order', () => {
    const markdown = buildReportMarkdown({
      pullRequest,
      round: 1,
      at: '2026-08-03T21:00:00Z',
      headSha: 'abc1234',
      recommendation: 'APPROVE',
      body: '## Executive summary\n\nThe change is focused.\n',
    });

    let cursor = -1;
    for (const section of REPORT_SECTIONS) {
      const index = markdown.indexOf(`## ${section}`);
      expect(index, `missing section ${section}`).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(markdown).toContain('The change is focused.');
    expect(markdown).toContain('_Not reported._');
    expect(markdown).toContain('- **Recommendation:** APPROVE');
    expect(markdown).toContain('- **Head SHA:** abc1234');
  });

  it('maps alternative headings onto the canonical sections', () => {
    const markdown = buildReportMarkdown({
      pullRequest,
      round: 2,
      at: '2026-08-03T21:00:00Z',
      headSha: null,
      recommendation: 'REQUEST_CHANGES',
      body: '## Summary\n\nToo much at once.\n\n## Risks\n\nMigration is irreversible.\n',
    });

    const summary = markdown.slice(markdown.indexOf('## Executive summary'));
    expect(summary.slice(0, summary.indexOf('## Strengths'))).toContain('Too much at once.');
    const risks = markdown.slice(markdown.indexOf('## Risks identified'));
    expect(risks.slice(0, risks.indexOf('## Required before merge'))).toContain(
      'Migration is irreversible.',
    );
  });

  it('preserves content that matches no known section', () => {
    const markdown = buildReportMarkdown({
      pullRequest,
      round: 1,
      at: '2026-08-03T21:00:00Z',
      headSha: null,
      recommendation: 'APPROVE',
      body: 'A preamble.\n\n## Performance notes\n\nThe hot loop is untouched.\n',
    });

    expect(markdown).toContain('## Additional notes');
    expect(markdown).toContain('A preamble.');
    expect(markdown).toContain('The hot loop is untouched.');
  });

  it('preserves the raw output when the verdict could not be parsed', () => {
    const markdown = buildReportMarkdown({
      pullRequest,
      round: 1,
      at: '2026-08-03T21:00:00Z',
      headSha: null,
      recommendation: null,
      body: 'The agent rambled and never reached a verdict.',
      parseError: 'No <pr-review-result> block and no RECOMMENDATION line in the output.',
    });

    expect(markdown).toContain('- **Recommendation:** UNPARSED');
    expect(markdown).toContain('> Verdict could not be parsed:');
    expect(markdown).toContain('## Raw agent output');
    expect(markdown).toContain('The agent rambled and never reached a verdict.');
  });
});

describe('artifact directory', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'issue-flow-pr-review-'));
    mockProjectRoot.current = root;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses issues/<N>/pr-review/ when an issue is associated', async () => {
    expect(await prReviewDir({ issue: '25', pullRequest: 184 })).toBe(
      join(root, 'issues', '25', 'pr-review'),
    );
  });

  it('uses issues/pr-<N>/pr-review/ when there is no issue', async () => {
    expect(await prReviewDir({ pullRequest: 184 })).toBe(
      join(root, 'issues', 'pr-184', 'pr-review'),
    );
  });
});

describe('round numbering', () => {
  let dir = '';

  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'issue-flow-rounds-')), 'pr-review');
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts at 1 on an empty directory', async () => {
    expect(await resolveRound(dir, 184)).toBe(1);
  });

  it('continues past the highest round in the index', async () => {
    await writeFile(
      join(dir, 'index.json'),
      JSON.stringify({
        schemaVersion: 1,
        pullRequest: { number: 184, url: null, title: null, headBranch: null },
        rounds: [
          { round: 1, at: '', recommendation: 'REQUEST_CHANGES', headSha: null, reportPath: '' },
          { round: 2, at: '', recommendation: 'REQUEST_CHANGES', headSha: null, reportPath: '' },
        ],
      }),
    );

    expect(await resolveRound(dir, 184)).toBe(3);
  });

  it('never overwrites a report when the index is corrupt', async () => {
    await writeFile(join(dir, reportFileName(184, 1)), '# round 1\n');
    await writeFile(join(dir, reportFileName(184, 2)), '# round 2\n');
    await writeFile(join(dir, 'index.json'), '{ not json');

    expect(await readPrReviewIndex(dir)).toBeNull();
    expect(await resolveRound(dir, 184)).toBe(3);
  });

  it('ignores reports of other Pull Requests in the same directory', async () => {
    await writeFile(join(dir, reportFileName(999, 7)), '# other pr\n');

    expect(await resolveRound(dir, 184)).toBe(1);
  });

  it('honours an explicit round, which rewrites it', async () => {
    await writeFile(join(dir, reportFileName(184, 1)), '# round 1\n');
    await writeFile(join(dir, reportFileName(184, 2)), '# round 2\n');

    expect(await resolveRound(dir, 184, 2)).toBe(2);
  });
});

describe('upsertRound', () => {
  const base = {
    schemaVersion: 1 as const,
    pullRequest: { number: 184, url: null, title: null, headBranch: null },
    rounds: [
      {
        round: 1,
        at: '2026-08-03T20:00:00Z',
        recommendation: 'REQUEST_CHANGES' as const,
        headSha: 'aaa',
        reportPath: 'pr-184-round-1.md',
        findings: [],
      },
    ],
  };

  it('appends a new round without touching the previous ones', () => {
    const updated = upsertRound(base, {
      round: 2,
      at: '2026-08-03T21:00:00Z',
      recommendation: 'APPROVE',
      headSha: 'bbb',
      reportPath: 'pr-184-round-2.md',
      findings: [],
    });

    expect(updated.rounds.map((entry) => entry.round)).toEqual([1, 2]);
    expect(updated.rounds[0]).toEqual(base.rounds[0]);
  });

  it('replaces exactly the round being rewritten', () => {
    const updated = upsertRound(base, {
      round: 1,
      at: '2026-08-03T22:00:00Z',
      recommendation: 'APPROVE',
      headSha: 'ccc',
      reportPath: 'pr-184-round-1.md',
      findings: [],
    });

    expect(updated.rounds).toHaveLength(1);
    expect(updated.rounds[0].recommendation).toBe('APPROVE');
  });
});
