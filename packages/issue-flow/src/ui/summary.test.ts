import { describe, expect, it, vi } from 'vitest';
import { buildRunSummaryLines, printRunSummary, type RunSummaryInfo } from './summary.js';

/**
 * The final `run` summary (issue 25, US-011).
 *
 * The lines below are a behavioural contract: without the optional `pr-review`
 * phase they must stay byte for byte what the pipeline has always printed.
 */
function info(overrides: Partial<RunSummaryInfo> = {}): RunSummaryInfo {
  return {
    issueNumber: '42',
    branchName: 'issue/42-sample',
    noBranch: false,
    storyCount: 3,
    elapsedSeconds: 90,
    prUrl: 'https://github.com/acme/repo/pull/184',
    ...overrides,
  };
}

describe('buildRunSummaryLines', () => {
  it('sem a fase pr-review, as linhas são as de sempre', () => {
    expect(buildRunSummaryLines(info())).toEqual([
      '  Branch:   issue/42-sample',
      '  Stories:  3',
      '  Duration: 1m 30s',
      '  PR:       https://github.com/acme/repo/pull/184',
    ]);
  });

  it('--no-branch marca a branch como current e omite a linha do PR', () => {
    const lines = buildRunSummaryLines(info({ noBranch: true }));

    expect(lines[0]).toBe('  Branch:   issue/42-sample (current)');
    expect(lines.some((l) => l.includes('PR:'))).toBe(false);
  });

  it('exibe a recomendação e o caminho do relatório quando a fase rodou', () => {
    const lines = buildRunSummaryLines(
      info({
        prReview: {
          requestedChanges: false,
          recommendation: 'APPROVE_WITH_SUGGESTIONS',
          reportPath: '/repo/issues/42/pr-review/pr-184-round-1.md',
        },
      }),
    );

    expect(lines).toContain('  Review:   APPROVE_WITH_SUGGESTIONS');
    expect(lines).toContain('  Report:   /repo/issues/42/pr-review/pr-184-round-1.md');
  });

  it('sem recomendação legível, o veredito vem do exit code (REQUEST_CHANGES)', () => {
    const lines = buildRunSummaryLines(
      info({ prReview: { requestedChanges: true, recommendation: null, reportPath: null } }),
    );

    expect(lines).toContain('  Review:   REQUEST_CHANGES');
    expect(lines.some((l) => l.includes('Report:'))).toBe(false);
  });

  it('sem recomendação e sem changes pedidas, o veredito é unknown', () => {
    const lines = buildRunSummaryLines(
      info({ prReview: { requestedChanges: false, recommendation: null, reportPath: null } }),
    );

    expect(lines).toContain('  Review:   unknown');
  });
});

describe('printRunSummary', () => {
  it('imprime a linha de sucesso seguida das linhas de detalhe', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      printRunSummary(info());
    } finally {
      spy.mockRestore();
    }

    expect(lines[0]).toBe('');
    expect(lines[1]).toContain('Pipeline complete for issue #42!');
    expect(lines.slice(2)).toEqual(buildRunSummaryLines(info()));
  });

  it('não declara Pipeline complete quando o PR review pediu mudanças', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const withChanges = info({
      prReview: { requestedChanges: true, recommendation: 'REQUEST_CHANGES', reportPath: null },
    });
    try {
      printRunSummary(withChanges);
    } finally {
      spy.mockRestore();
    }

    expect(lines[1]).toContain('requested changes');
    expect(lines[1]).not.toContain('Pipeline complete');
    expect(lines.slice(2)).toEqual(buildRunSummaryLines(withChanges));
  });
});
