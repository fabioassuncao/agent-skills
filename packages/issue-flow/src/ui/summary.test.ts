import { describe, expect, it, vi } from 'vitest';
import type { TaskPlan } from '../types.js';
import {
  buildRunSummaryLines,
  printRunSummary,
  printSummaryBox,
  type RunSummaryInfo,
} from './summary.js';

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

/**
 * Metrics lines (issue 37, US-009).
 *
 * The totals arrive already resolved from the process-owned counters in
 * `core/session-metrics.ts`; the summary only formats them. With nothing
 * reported the output must stay byte for byte what it was before metrics
 * existed — never `0 in / 0 out`, never `~$NaN`.
 */
function capture(run: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

function plan(): TaskPlan {
  return {
    project: 'issue-flow',
    issueNumber: 42,
    issueUrl: '',
    branchName: 'issue/42-sample',
    description: '',
    issueStatus: 'in_progress',
    completedAt: null,
    lastAttemptAt: null,
    lastError: null,
    correctionCycle: 0,
    maxCorrectionCycles: 3,
    lastReviewFindings: null,
    pipeline: {
      prdCompleted: true,
      jsonCompleted: true,
      executionCompleted: false,
      reviewCompleted: false,
      prCreated: false,
    },
    userStories: [
      {
        id: 'US-001',
        title: 'Story',
        description: '',
        acceptanceCriteria: [],
        priority: 1,
        passes: true,
        notes: '',
      },
    ],
  };
}

/** The label column of the box, so the assertions ignore the padding. */
function boxLine(lines: string[], label: string): string | undefined {
  return lines.find((l) => l.includes(label))?.replace(/^\S\s|\s\S$/g, '');
}

describe('buildRunSummaryLines (tokens)', () => {
  it('com custo, imprime tokens e USD entre Duration e PR', () => {
    const lines = buildRunSummaryLines(
      info({
        usage: {
          inputTokens: 2,
          outputTokens: 4,
          cacheReadTokens: 15_000,
          cacheCreationTokens: 500,
          costUsd: 0.1607,
        },
      }),
    );

    expect(lines).toEqual([
      '  Branch:   issue/42-sample',
      '  Stories:  3',
      '  Duration: 1m 30s',
      '  Tokens:   2 in / 4 out · 15.5k cache · ~$0.1607',
      '  PR:       https://github.com/acme/repo/pull/184',
    ]);
  });

  it('com tokens mas sem custo, omite o segmento de USD', () => {
    const lines = buildRunSummaryLines(info({ usage: { inputTokens: 1200, outputTokens: 300 } }));

    expect(lines).toContain('  Tokens:   1.2k in / 300 out');
    expect(lines.some((l) => l.includes('$'))).toBe(false);
  });

  it('sem dado algum, a saída é idêntica à de antes das métricas', () => {
    const expected = buildRunSummaryLines(info());

    expect(expected.some((l) => l.includes('Tokens:'))).toBe(false);
    expect(buildRunSummaryLines(info({ usage: null }))).toEqual(expected);
    expect(buildRunSummaryLines(info({ usage: {} }))).toEqual(expected);
  });
});

describe('printSummaryBox (tokens)', () => {
  it('com custo, imprime a linha de tokens abaixo de Duration', () => {
    const lines = capture(() => {
      printSummaryBox('success', 3, 1, 90, plan(), undefined, {
        inputTokens: 2,
        outputTokens: 4,
        cacheReadTokens: 15_000,
        cacheCreationTokens: 500,
        costUsd: 0.1607,
      });
    });

    expect(boxLine(lines, 'Tokens:')?.trimEnd()).toBe(
      'Tokens:      2 in / 4 out · 15.5k cache · ~$0.1607',
    );

    const labels = lines.flatMap((l) => {
      const match = l.match(/(Duration|Tokens|Retries):/);
      return match ? [match[1]] : [];
    });
    expect(labels).toEqual(['Duration', 'Tokens', 'Retries']);
  });

  it('com tokens mas sem custo, imprime só os tokens', () => {
    const lines = capture(() => {
      printSummaryBox('success', 1, 0, 10, plan(), undefined, { inputTokens: 1200 });
    });

    expect(boxLine(lines, 'Tokens:')?.trimEnd()).toBe('Tokens:      1.2k in');
    expect(lines.some((l) => l.includes('$'))).toBe(false);
  });

  it('sem dado algum, a caixa é idêntica à de antes das métricas', () => {
    const before = capture(() => {
      printSummaryBox('success', 1, 0, 10, plan());
    });

    expect(before.some((l) => l.includes('Tokens:'))).toBe(false);
    expect(capture(() => printSummaryBox('success', 1, 0, 10, plan(), undefined, null))).toEqual(
      before,
    );
    expect(capture(() => printSummaryBox('success', 1, 0, 10, plan(), undefined, {}))).toEqual(
      before,
    );
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
