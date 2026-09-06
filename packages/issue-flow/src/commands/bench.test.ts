import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASELINE_COST_P50_USD,
  BenchConfirmationError,
  confirmRealCampaign,
  estimateCampaignUsd,
  runBench,
} from './bench.js';

function promptInput(value = '', isTTY = true): PassThrough {
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: isTTY });
  Object.defineProperty(stdin, 'setRawMode', { value: () => stdin });
  if (value !== '') stdin.write(value);
  return stdin;
}

function promptOutput(isTTY = true): { stdout: Writable; written: () => string } {
  let output = '';
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  Object.defineProperty(stdout, 'isTTY', { value: isTTY });
  return { stdout, written: () => output };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

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
      stdout,
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
  it('accepts pre-buffered y input', async () => {
    const { stdout } = promptOutput();
    await expect(
      confirmRealCampaign(
        { cells: 1, repeats: 1, usd: 1 },
        { interactive: true, stdin: promptInput('y'), stdout },
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses pre-buffered n input', async () => {
    const { stdout } = promptOutput();
    await expect(
      confirmRealCampaign(
        { cells: 1, repeats: 1, usd: 1 },
        { interactive: true, stdin: promptInput('n'), stdout },
      ),
    ).rejects.toBeInstanceOf(BenchConfirmationError);
  });

  it('refuses the initially suggested no when Enter is pressed', async () => {
    const { stdout } = promptOutput();
    await expect(
      confirmRealCampaign(
        { cells: 1, repeats: 1, usd: 1 },
        { interactive: true, stdin: promptInput('\r'), stdout },
      ),
    ).rejects.toBeInstanceOf(BenchConfirmationError);
  });

  it('refuses EOF without consent', async () => {
    const stdin = promptInput();
    const { stdout } = promptOutput();
    const confirmation = confirmRealCampaign(
      { cells: 1, repeats: 1, usd: 1 },
      { interactive: true, stdin, stdout },
    );
    stdin.end();

    await expect(confirmation).rejects.toBeInstanceOf(BenchConfirmationError);
  });

  it.each([
    ['Esc', '\u001b'],
    ['Ctrl+C', '\u0003'],
  ])('refuses %s cancellation', async (_label, key) => {
    const { stdout } = promptOutput();
    await expect(
      confirmRealCampaign(
        { cells: 1, repeats: 1, usd: 1 },
        { interactive: true, stdin: promptInput(key), stdout },
      ),
    ).rejects.toBeInstanceOf(BenchConfirmationError);
  });

  it('refuses an aborted confirmation', async () => {
    const stdin = promptInput();
    const { stdout } = promptOutput();
    const controller = new AbortController();
    const confirmation = confirmRealCampaign(
      { cells: 1, repeats: 1, usd: 1 },
      { interactive: true, stdin, stdout, signal: controller.signal },
    );
    controller.abort();

    await expect(confirmation).rejects.toBeInstanceOf(BenchConfirmationError);
  });

  it.each([
    ['CI=1', true, true, '1'],
    ['non-TTY stdin', false, true, undefined],
    ['non-TTY stdout', true, false, undefined],
  ])('renders no prompt for %s and requires --yes', async (_label, stdinTty, stdoutTty, ci) => {
    if (ci !== undefined) vi.stubEnv('CI', ci);
    else vi.stubEnv('CI', '');
    const { stdout, written } = promptOutput(stdoutTty);

    await expect(
      confirmRealCampaign(
        { cells: 1, repeats: 1, usd: 1 },
        { stdin: promptInput('y', stdinTty), stdout },
      ),
    ).rejects.toThrow(/--yes/);
    expect(written()).toBe('');
  });

  it('does not start the paid runner after refused consent', async () => {
    const runner = vi.fn();
    const { stdout } = promptOutput();
    const code = await runBench({
      mode: 'real',
      task: ['trivial'],
      repeats: 1,
      interactive: true,
      stdin: promptInput('n'),
      stdout,
      harnessVersion: 'test',
      runner,
    });

    expect(code).toBe(1);
    expect(runner).not.toHaveBeenCalled();
  });
});
