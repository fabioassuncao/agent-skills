import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTransientFailure } from '../utils/retry.js';
import { DEFAULT_HEADLESS_TIMEOUT_MS, runHeadless } from './headless.js';
import { setVerbose } from './verbose.js';

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';

type ExecaResult = Awaited<ReturnType<typeof execa>>;

const mockExeca = vi.mocked(execa);

describe('runHeadless', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed JSON result on success', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Analysis complete',
        total_cost_usd: 0.1607,
        usage: {
          input_tokens: 2,
          output_tokens: 4,
          cache_creation_input_tokens: 15_000,
          cache_read_input_tokens: 500,
        },
      }),
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    const result = await runHeadless({ prompt: 'test prompt' });

    expect(result.success).toBe(true);
    expect(result.result).toBe('Analysis complete');
    expect(result.cost).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 500,
      cacheCreationTokens: 15_000,
      costUsd: 0.1607,
    });
    expect(result.error).toBeNull();

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      ['-p', 'test prompt', '--output-format', 'json', '--max-turns', '10'],
      expect.objectContaining({ reject: false }),
    );
  });

  it('still extracts metrics from the legacy JSON payload', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({
        result: 'Analysis complete',
        cost_usd: 0.05,
        num_input_tokens: 1000,
        num_output_tokens: 500,
      }),
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    const result = await runHeadless({ prompt: 'test prompt' });

    expect(result.success).toBe(true);
    expect(result.result).toBe('Analysis complete');
    expect(result.cost).toEqual({ inputTokens: 1000, outputTokens: 500, costUsd: 0.05 });
  });

  it('returns a null cost when the payload carries no metrics', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({ result: 'Analysis complete' }),
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    const result = await runHeadless({ prompt: 'test prompt' });

    expect(result.success).toBe(true);
    expect(result.result).toBe('Analysis complete');
    expect(result.cost).toBeNull();
  });

  it('returns error result on non-zero exit code', async () => {
    mockExeca.mockResolvedValue({
      stdout: '',
      stderr: 'Authentication required',
      exitCode: 1,
    } as unknown as ExecaResult);

    const result = await runHeadless({ prompt: 'test prompt' });

    expect(result.success).toBe(false);
    expect(result.result).toBe('');
    expect(result.error).toBe('Authentication required');
  });

  it('handles timeout gracefully', async () => {
    mockExeca.mockRejectedValue(new Error('timed out after 5000ms'));

    const result = await runHeadless({ prompt: 'test', timeout: 5000 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  // A rejection carries no process to inspect, so the clock decides. One that
  // arrives nowhere near the limit — or with no limit set at all — is not our
  // timeout, and telling the user to raise a limit they already removed would
  // bury the real diagnosis. The original message already says 'timed out', so
  // the phase keeps its retries either way.
  it('keeps the original message when a rejection is not our own timeout', async () => {
    mockExeca.mockRejectedValue(new Error('connect ETIMEDOUT 10.0.0.1:443'));

    const result = await runHeadless({ prompt: 'test', timeout: 0 });

    expect(result.success).toBe(false);
    expect(result.error).toBe('connect ETIMEDOUT 10.0.0.1:443');
    expect(result.error).not.toContain('--timeout');
    expect(isTransientFailure(1, result.error ?? '')).toBe(true);
  });

  // `reject: false` means execa resolves on a timeout instead of throwing, so
  // the rejection above is not how a real one arrives — this is. The CLI
  // handles the SIGTERM itself and leaves 143, which used to be reported as a
  // bare `claude exited with code 143`: the cause was invisible and, because
  // isTransientFailure() matches on the text, the phase lost every retry.
  it('reports a resolved timeout as a timeout, not as exit code 143', async () => {
    mockExeca.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 143,
      timedOut: true,
    } as unknown as ExecaResult);

    const result = await runHeadless({ prompt: 'test', timeout: 300_000 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.error).toContain('5m 0s');
    expect(result.error).toContain('--timeout');
    expect(isTransientFailure(1, result.error ?? '')).toBe(true);
  });

  it('reports a timeout the CLI absorbed, with no timedOut flag left behind', async () => {
    mockExeca.mockImplementation((async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { stdout: '', stderr: '', exitCode: 143 } as unknown as ExecaResult;
    }) as unknown as typeof execa);

    const result = await runHeadless({ prompt: 'test', timeout: 10 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('does not mistake an unrelated 143 for a timeout', async () => {
    mockExeca.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 143,
    } as unknown as ExecaResult);

    const result = await runHeadless({ prompt: 'test', timeout: 300_000 });

    expect(result.success).toBe(false);
    expect(result.error).toBe('claude exited with code 143');
    expect(isTransientFailure(1, result.error ?? '')).toBe(false);
  });

  it('keeps the stderr diagnostics of a plain failure', async () => {
    mockExeca.mockResolvedValue({
      stdout: '',
      stderr: 'Authentication required',
      exitCode: 1,
      timedOut: false,
    } as unknown as ExecaResult);

    const result = await runHeadless({ prompt: 'test' });

    expect(result.error).toBe('Authentication required');
  });

  it('defaults the timeout to the shared phase budget', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok' }),
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    await runHeadless({ prompt: 'test' });

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      expect.anything(),
      expect.objectContaining({ timeout: DEFAULT_HEADLESS_TIMEOUT_MS }),
    );
  });

  it('passes allowedTools when specified', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok' }),
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    await runHeadless({
      prompt: 'test',
      allowedTools: ['Read', 'Write'],
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--allowedTools', 'Read', '--allowedTools', 'Write']),
      expect.anything(),
    );
  });

  it('passes one --add-dir pair per directory', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok' }),
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    await runHeadless({
      prompt: 'test',
      addDirs: ['/home/u/.issue-flow/projects/p/issues/42', '/tmp/extra'],
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      [
        '-p',
        'test',
        '--output-format',
        'json',
        '--max-turns',
        '10',
        '--add-dir',
        '/home/u/.issue-flow/projects/p/issues/42',
        '--add-dir',
        '/tmp/extra',
      ],
      expect.anything(),
    );
  });

  it('omits --add-dir entirely when addDirs is absent or empty', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok' }),
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    const baseline = ['-p', 'test', '--output-format', 'json', '--max-turns', '10'];

    await runHeadless({ prompt: 'test' });
    expect(mockExeca).toHaveBeenLastCalledWith('claude', baseline, expect.anything());

    await runHeadless({ prompt: 'test', addDirs: [] });
    expect(mockExeca).toHaveBeenLastCalledWith('claude', baseline, expect.anything());
  });

  it('handles non-JSON output gracefully', async () => {
    mockExeca.mockResolvedValue({
      stdout: 'plain text output',
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    const result = await runHeadless({ prompt: 'test' });

    expect(result.success).toBe(true);
    expect(result.result).toBe('plain text output');
  });

  it('returns raw output when outputFormat is text', async () => {
    mockExeca.mockResolvedValue({
      stdout: 'raw text output',
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    const result = await runHeadless({ prompt: 'test', outputFormat: 'text' });

    expect(result.success).toBe(true);
    expect(result.result).toBe('raw text output');
  });
});

describe('runHeadless (verbose)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setVerbose(true);
    mockExeca.mockResolvedValue({
      stdout: undefined,
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);
  });

  afterEach(() => {
    setVerbose(false);
  });

  const noop = () => {};

  /**
   * A stand-in for the execa subprocess: awaitable like the real one, but also
   * carrying a readable `stdout` so the stream-json branch has lines to consume.
   */
  function streamProcess(events: unknown[]): unknown {
    const proc = Promise.resolve({ exitCode: 0, stderr: '' });
    Object.defineProperty(proc, 'stdout', {
      value: Readable.from(events.map((e) => `${JSON.stringify(e)}\n`)),
    });
    return proc;
  }

  it('captures cost and cache tokens from the stream result event', async () => {
    mockExeca.mockReturnValue(
      streamProcess([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'all done',
          total_cost_usd: 0.1607,
          usage: {
            input_tokens: 2,
            output_tokens: 4,
            cache_creation_input_tokens: 15_000,
            cache_read_input_tokens: 500,
          },
        },
      ]) as ReturnType<typeof execa>,
    );

    const result = await runHeadless({ prompt: 'test', onOutput: noop });

    expect(result.success).toBe(true);
    expect(result.result).toBe('all done');
    expect(result.cost).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 500,
      cacheCreationTokens: 15_000,
      costUsd: 0.1607,
    });
  });

  it('returns a null cost when the stream result event carries no metrics', async () => {
    mockExeca.mockReturnValue(
      streamProcess([
        { type: 'result', subtype: 'success', is_error: false, result: 'all done' },
      ]) as ReturnType<typeof execa>,
    );

    const result = await runHeadless({ prompt: 'test', onOutput: noop });

    expect(result.success).toBe(true);
    expect(result.result).toBe('all done');
    expect(result.cost).toBeNull();
  });

  it('passes one --add-dir pair per directory', async () => {
    await runHeadless({
      prompt: 'test',
      addDirs: ['/home/u/.issue-flow/projects/p/issues/42'],
      onOutput: noop,
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      [
        '-p',
        'test',
        '--output-format',
        'stream-json',
        '--verbose',
        '--max-turns',
        '10',
        '--add-dir',
        '/home/u/.issue-flow/projects/p/issues/42',
      ],
      expect.anything(),
    );
  });

  it('omits --add-dir entirely when addDirs is absent', async () => {
    await runHeadless({ prompt: 'test', onOutput: noop });

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      ['-p', 'test', '--output-format', 'stream-json', '--verbose', '--max-turns', '10'],
      expect.anything(),
    );
  });

  // execa escalates to SIGKILL when the CLI does not die on the SIGTERM, and
  // then reports no exit code at all — a shape the old `signalName` check
  // (a property execa 9 does not have) never recognised.
  it('reports a stream run killed by the timeout as a timeout', async () => {
    const proc = Promise.resolve({
      exitCode: undefined,
      signal: 'SIGKILL',
      timedOut: true,
      stderr: '',
    });
    Object.defineProperty(proc, 'stdout', { value: Readable.from([]) });
    mockExeca.mockReturnValue(proc as ReturnType<typeof execa>);

    const result = await runHeadless({ prompt: 'test', timeout: 60_000, onOutput: noop });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.error).toContain('--timeout');
  });
});
