import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalReportPublisher, type PrReviewReport } from './publisher.js';
import { type PrReviewIndex, readPrReviewIndex } from './report.js';

function makeReport(overrides?: Partial<PrReviewReport>): PrReviewReport {
  return {
    pullRequest: {
      number: 184,
      url: 'https://github.com/acme/repo/pull/184',
      title: 'Add the pr-review phase',
      headBranch: 'issue/25-pr-review-phase',
    },
    round: 1,
    at: '2026-08-03T21:00:00Z',
    headSha: 'abc1234',
    recommendation: 'REQUEST_CHANGES',
    blockers: ['Missing tests'],
    findings: [{ severity: 'high', file: 'src/a.ts', line: 10, title: 'Missing tests' }],
    markdown: '# Pull Request Review — #184 (round 1)\n',
    ...overrides,
  };
}

describe('LocalReportPublisher', () => {
  let dir = '';

  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'issue-flow-publisher-')), 'pr-review');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the directory, the report and the index', async () => {
    await new LocalReportPublisher(dir).publish(makeReport());

    expect(await readFile(join(dir, 'pr-184-round-1.md'), 'utf-8')).toContain(
      '# Pull Request Review',
    );

    const index = (await readPrReviewIndex(dir)) as PrReviewIndex;
    expect(index.schemaVersion).toBe(1);
    expect(index.pullRequest.number).toBe(184);
    expect(index.rounds).toEqual([
      {
        round: 1,
        at: '2026-08-03T21:00:00Z',
        recommendation: 'REQUEST_CHANGES',
        headSha: 'abc1234',
        reportPath: 'pr-184-round-1.md',
        findings: [{ severity: 'high', file: 'src/a.ts', line: 10, title: 'Missing tests' }],
      },
    ]);
  });

  it('keeps earlier rounds when publishing the next one', async () => {
    const publisher = new LocalReportPublisher(dir);
    await publisher.publish(makeReport());
    await publisher.publish(
      makeReport({
        round: 2,
        at: '2026-08-03T22:00:00Z',
        recommendation: 'APPROVE',
        blockers: [],
        findings: [],
        markdown: '# Pull Request Review — #184 (round 2)\n',
      }),
    );

    const files = (await readdir(dir)).sort();
    expect(files).toEqual(['index.json', 'pr-184-round-1.md', 'pr-184-round-2.md']);

    const index = (await readPrReviewIndex(dir)) as PrReviewIndex;
    expect(index.rounds.map((entry) => entry.round)).toEqual([1, 2]);
    expect(index.rounds[0].recommendation).toBe('REQUEST_CHANGES');
    expect(index.rounds[1].recommendation).toBe('APPROVE');
  });

  it('rewrites a specific round without adding an entry', async () => {
    const publisher = new LocalReportPublisher(dir);
    await publisher.publish(makeReport());
    await publisher.publish(
      makeReport({ recommendation: 'APPROVE', markdown: '# Rewritten round 1\n' }),
    );

    const index = (await readPrReviewIndex(dir)) as PrReviewIndex;
    expect(index.rounds).toHaveLength(1);
    expect(index.rounds[0].recommendation).toBe('APPROVE');
    expect(await readFile(join(dir, 'pr-184-round-1.md'), 'utf-8')).toBe('# Rewritten round 1\n');
  });

  it('records an unparsed round as null instead of an approval', async () => {
    await new LocalReportPublisher(dir).publish(
      makeReport({ recommendation: null, blockers: [], findings: [] }),
    );

    const index = (await readPrReviewIndex(dir)) as PrReviewIndex;
    expect(index.rounds[0].recommendation).toBeNull();
  });
});
