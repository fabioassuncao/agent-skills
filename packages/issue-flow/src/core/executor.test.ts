import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeClaude } from './executor.js';
import { setOutputCallback } from './verbose.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';

type ExecaResult = Awaited<ReturnType<typeof execa>>;

const mockExeca = vi.mocked(execa);

function cliResult(overrides: Partial<{ stdout: string; stderr: string; exitCode: number }>) {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    ...overrides,
  } as unknown as ExecaResult;
}

/** Payload shape of `claude --print --output-format json` (CLI 2.1.220). */
function jsonEnvelope(text: string) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    total_cost_usd: 0.4212,
    usage: {
      input_tokens: 7,
      output_tokens: 913,
      cache_creation_input_tokens: 24_000,
      cache_read_input_tokens: 1_200,
    },
  });
}

describe('executeClaude', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setOutputCallback(undefined);
  });

  it('requests the JSON output format while keeping the prompt on stdin', async () => {
    mockExeca.mockResolvedValue(cliResult({ stdout: jsonEnvelope('done') }));

    await executeClaude('do the thing');

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      ['--dangerously-skip-permissions', '--print', '--output-format', 'json'],
      {
        input: 'do the thing',
        reject: false,
        timeout: 0,
        stripFinalNewline: false,
      },
    );
  });

  it('unwraps the result text and captures metrics on valid JSON', async () => {
    mockExeca.mockResolvedValue(cliResult({ stdout: jsonEnvelope('Story US-003 implemented') }));

    const result = await executeClaude('prompt');

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('Story US-003 implemented');
    expect(result.cost).toEqual({
      inputTokens: 7,
      outputTokens: 913,
      cacheReadTokens: 1_200,
      cacheCreationTokens: 24_000,
      costUsd: 0.4212,
    });
  });

  it('reports no metrics when the JSON envelope carries no usage data', async () => {
    mockExeca.mockResolvedValue(
      cliResult({ stdout: JSON.stringify({ type: 'result', result: 'plain' }) }),
    );

    const result = await executeClaude('prompt');

    expect(result.output).toBe('plain');
    expect(result.cost).toBeNull();
  });

  it('falls back to the raw combined output when stdout is not JSON', async () => {
    mockExeca.mockResolvedValue(cliResult({ stdout: 'free-form text', stderr: 'a warning' }));

    const result = await executeClaude('prompt');

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('free-form text\na warning');
    expect(result.cost).toBeNull();
  });

  it('falls back to stdout when the JSON envelope has no result field', async () => {
    mockExeca.mockResolvedValue(cliResult({ stdout: '{"type":"result"}' }));

    const result = await executeClaude('prompt');

    expect(result.output).toBe('{"type":"result"}');
    expect(result.cost).toBeNull();
  });

  it('keeps stdout+stderr verbatim and reports no metrics on a non-zero exit code', async () => {
    mockExeca.mockResolvedValue(
      cliResult({
        stdout: jsonEnvelope('partial'),
        stderr: 'Overloaded (529)',
        exitCode: 1,
      }),
    );

    const result = await executeClaude('prompt');

    expect(result.exitCode).toBe(1);
    // The engine's trimErrorMessage()/isTransientFailure() must still see the
    // untouched CLI diagnostics.
    expect(result.output).toBe(`${jsonEnvelope('partial')}\nOverloaded (529)`);
    expect(result.cost).toBeNull();
  });

  it('defaults a null exit code to 1', async () => {
    mockExeca.mockResolvedValue(cliResult({ stdout: 'boom', exitCode: null as unknown as number }));

    const result = await executeClaude('prompt');

    expect(result.exitCode).toBe(1);
  });

  it('exposes the completion signal through the unwrapped result text', async () => {
    mockExeca.mockResolvedValue(
      cliResult({ stdout: jsonEnvelope('All done.\n<promise>COMPLETE</promise>') }),
    );

    const result = await executeClaude('prompt');

    expect(result.output.includes('<promise>COMPLETE</promise>')).toBe(true);
  });

  it('forwards the result text to the output callback, not the raw JSON', async () => {
    const lines: string[] = [];
    setOutputCallback((line) => lines.push(line));
    mockExeca.mockResolvedValue(cliResult({ stdout: jsonEnvelope('  human readable  ') }));

    await executeClaude('prompt');

    expect(lines).toEqual(['human readable']);
  });

  it('does not invoke the output callback when the result text is empty', async () => {
    const onOutput = vi.fn();
    setOutputCallback(onOutput);
    mockExeca.mockResolvedValue(cliResult({ stdout: jsonEnvelope('   ') }));

    await executeClaude('prompt');

    expect(onOutput).not.toHaveBeenCalled();
  });
});
