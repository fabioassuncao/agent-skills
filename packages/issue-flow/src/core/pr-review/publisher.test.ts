import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../../utils/fs.js';
import {
  createPrReviewPublisher,
  GitHubCommentPublisher,
  LocalReportPublisher,
  type PrReviewReport,
  reviewCommentMarker,
} from './publisher.js';
import { type PrReviewIndex, readPrReviewIndex } from './report.js';

function makeReport(overrides?: Partial<PrReviewReport>): PrReviewReport {
  return {
    pullRequest: {
      number: 184,
      url: 'https://github.com/acme/repo/pull/184',
      title: 'Add the pr-review phase',
      headBranch: 'feat/25-pr-review-phase',
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

/** Every `gh` invocation of a publication, as `gh <argv>`. */
async function ghCalls(): Promise<string[]> {
  const { run } = await import('../../utils/shell.js');
  return vi
    .mocked(run)
    .mock.calls.filter(([command]) => command === 'gh')
    .map(([command, args]) => `${command} ${(args ?? []).join(' ')}`);
}

vi.mock('../../utils/shell.js', () => ({ run: vi.fn() }));

describe('GitHubCommentPublisher — a republication updates, never duplicates (US-023)', () => {
  let comments: { id: number; body: string }[];

  beforeEach(async () => {
    comments = [];
    const { run } = await import('../../utils/shell.js');
    vi.mocked(run).mockReset();
    vi.mocked(run).mockImplementation(async (_command: string, args: string[] = []) => {
      if (args[0] === 'api' && args[1]?.endsWith('/comments')) {
        return { stdout: JSON.stringify(comments), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
  });

  it('posts a new comment carrying the round marker', async () => {
    await new GitHubCommentPublisher().publish(makeReport());

    const calls = await ghCalls();
    expect(calls.some((call) => call.includes('pr comment 184'))).toBe(true);
    expect(calls.some((call) => call.includes(reviewCommentMarker(1)))).toBe(true);
  });

  it('updates the existing comment of the same round instead of adding a second', async () => {
    comments = [
      { id: 555, body: `${reviewCommentMarker(1)}\n# Pull Request Review — #184 (round 1)` },
    ];

    await new GitHubCommentPublisher().publish(makeReport());

    const calls = await ghCalls();
    // The whole point: no second comment.
    expect(calls.some((call) => call.includes('pr comment'))).toBe(false);
    expect(
      calls.some((call) => call.includes('--method PATCH') && call.includes('issues/comments/555')),
    ).toBe(true);
  });

  it('gives a later round its own comment', async () => {
    comments = [{ id: 555, body: `${reviewCommentMarker(1)}\nround one` }];

    await new GitHubCommentPublisher().publish(makeReport({ round: 2 }));

    const calls = await ghCalls();
    // Round 2 is a different statement, not an edit of round 1.
    expect(calls.some((call) => call.includes('pr comment 184'))).toBe(true);
    expect(calls.some((call) => call.includes('--method PATCH'))).toBe(false);
  });

  it('posts rather than staying silent when gh cannot list the comments', async () => {
    const { run } = await import('../../utils/shell.js');
    vi.mocked(run).mockImplementation(async (_command: string, args: string[] = []) => {
      if (args[0] === 'api' && args[1]?.endsWith('/comments')) {
        return { stdout: '', stderr: 'boom', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await new GitHubCommentPublisher().publish(makeReport());

    expect((await ghCalls()).some((call) => call.includes('pr comment 184'))).toBe(true);
  });

  it('is composed with the local publisher, never in its place', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'issue-flow-publisher-gh-')), 'pr-review');
    try {
      await createPrReviewPublisher(dir, 'github').publish(makeReport());

      // The artifacts the correction cycle and `resume` read are still written.
      expect(await readFile(join(dir, 'pr-184-round-1.md'), 'utf-8')).toContain(
        '# Pull Request Review',
      );
      expect((await ghCalls()).some((call) => call.includes('pr comment 184'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('operations that were already idempotent (US-023)', () => {
  it('writeFileAtomic overwrites, which is the wanted behaviour', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'issue-flow-idempotent-'));
    try {
      const file = join(dir, 'index.json');

      await writeFileAtomic(file, 'first\n');
      await writeFileAtomic(file, 'second\n');
      await writeFileAtomic(file, 'second\n');

      // Overwriting is the contract: the second and third writes leave exactly
      // one file with the last content, never an appended or duplicated one.
      expect(await readFile(file, 'utf-8')).toBe('second\n');
      expect(await readdir(dir)).toEqual(['index.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('publishing the same round twice locally leaves one report and one round', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'issue-flow-idempotent-local-')), 'pr-review');
    try {
      const publisher = new LocalReportPublisher(dir);
      await publisher.publish(makeReport());
      await publisher.publish(makeReport());

      expect((await readdir(dir)).sort()).toEqual(['index.json', 'pr-184-round-1.md']);
      const index = (await readPrReviewIndex(dir)) as PrReviewIndex;
      expect(index.rounds).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
