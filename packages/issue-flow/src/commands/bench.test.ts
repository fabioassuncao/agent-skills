import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  BASELINE_COST_P50_USD,
  BenchConfirmationError,
  confirmRealCampaign,
  estimateCampaignUsd,
  runBench,
} from './bench.js';

describe('bench command', () => {
  it('runs the synthetic corpus without invoking a harness', async () => {
    const info = vi.spyOn(await import('../ui/logger.js'), 'printInfo');
    const code = await runBench({ mode: 'synthetic' });
    expect(code).toBe(0);
    expect(info.mock.calls.some((call) => String(call[0]).includes('Synthetic corpus'))).toBe(true);
    info.mockRestore();
  });

  it('estimates from the #79 baseline p50 and never invents a zero for unknown', () => {
    const usd = estimateCampaignUsd(['small', 'medium'], 2, 5);
    expect(usd).toBe((BASELINE_COST_P50_USD.small + BASELINE_COST_P50_USD.medium) * 2 * 5);
    expect(usd).toBeGreaterThan(0);
  });

  it('requires --yes when there is no TTY', async () => {
    await expect(
      confirmRealCampaign({ cells: 2, repeats: 5, usd: 10 }, { interactive: false }),
    ).rejects.toBeInstanceOf(BenchConfirmationError);
  });

  it('skips the prompt with --yes', async () => {
    await expect(
      confirmRealCampaign({ cells: 1, repeats: 1, usd: 1 }, { yes: true, interactive: false }),
    ).resolves.toBeUndefined();
  });

  it('writes a redacted markdown report from a mocked campaign', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'issue-flow-bench-out-'));
    const out = join(outDir, 'report.md');
    const code = await runBench({
      mode: 'real',
      task: ['trivial'],
      arm: ['baseline'],
      repeats: 2,
      yes: true,
      harnessVersion: '2.1.251',
      out,
      runner: async () => ({
        records: [],
        verdict: 'unverified',
        taskDurationMs: 50,
        harnessExecutionMs: 40,
        orchestrationOverheadMs: 10,
        attemptCount: 1,
        cost: { status: 'unknown', reason: 'not_reported' },
      }),
    });
    expect(code).toBe(0);
    const markdown = await readFile(out, 'utf-8');
    expect(markdown).toContain('n');
    expect(markdown).toContain('trivial');
    expect(markdown).toContain('unverified');
    expect(markdown).not.toMatch(/sk-ant-|ghp_/);
  });

  it('exits 2 when a ceiling stops the campaign', async () => {
    const stdoutChunks: string[] = [];
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        stdoutChunks.push(String(chunk));
        cb();
      },
    });
    const code = await runBench({
      mode: 'real',
      task: ['trivial'],
      arm: ['baseline'],
      repeats: 4,
      maxCost: 1,
      yes: true,
      harnessVersion: 'test',
      stdout: stdout as unknown as NodeJS.WritableStream,
      runner: async () => ({
        records: [],
        verdict: 'passed',
        taskDurationMs: 10,
        harnessExecutionMs: 8,
        orchestrationOverheadMs: 2,
        attemptCount: 1,
        cost: { status: 'reported', amount: 0.8, currency: 'USD' },
      }),
    });
    expect(code).toBe(2);
    expect(stdoutChunks.join('')).toContain('partial');
  });
});

describe('confirmRealCampaign prompt', () => {
  it('cancels on a non-yes answer', async () => {
    const stdin = Readable.from(['n\n']);
    const stdout = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    await expect(
      confirmRealCampaign({ cells: 1, repeats: 1, usd: 1 }, { interactive: true, stdin, stdout }),
    ).rejects.toBeInstanceOf(BenchConfirmationError);
  });
});
