import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeClaude } from './executor.js';
import { setOutputCallback, setVerbose } from './verbose.js';

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

/**
 * An execa subprocess: a promise for the finished result that also carries the
 * live `stdout` stream, which is what `--output-format stream-json` writes to.
 *
 * `lines` are the stream-json events; `finished` is what the process resolves
 * to once it exits. They are separate because they are separate in reality —
 * the stream is consumed while the process runs, and `result.stdout` is what is
 * left over (nothing, for a consumed stream).
 */
function claudeSubprocess(
  lines: string[],
  finished: Partial<{ stdout: string; stderr: string; exitCode: number }> = {},
) {
  const subprocess = Promise.resolve(cliResult(finished)) as unknown as ExecaResult & {
    stdout: Readable;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  subprocess.stdout = Readable.from(lines.map((line) => `${line}\n`));
  subprocess.kill = () => true;
  return subprocess;
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
    setVerbose(false);
  });

  it('requests the stream-json output format while keeping the prompt on stdin', async () => {
    mockExeca.mockReturnValue(claudeSubprocess([jsonEnvelope('done')]));

    await executeClaude('do the thing');

    // The stream is what makes the loop observable (US-026): it is now always
    // requested, and only the rendering differs between verbose and not.
    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      ['--dangerously-skip-permissions', '--print', '--output-format', 'stream-json', '--verbose'],
      {
        input: 'do the thing',
        reject: false,
        timeout: 0,
        stripFinalNewline: false,
      },
    );
  });

  it('unwraps the result text and captures metrics on valid JSON', async () => {
    mockExeca.mockReturnValue(claudeSubprocess([jsonEnvelope('Story US-003 implemented')]));

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
    mockExeca.mockReturnValue(
      claudeSubprocess([JSON.stringify({ type: 'result', result: 'plain' })]),
    );

    const result = await executeClaude('prompt');

    expect(result.output).toBe('plain');
    expect(result.cost).toBeNull();
  });

  it('falls back to the raw combined output when stdout is not JSON', async () => {
    mockExeca.mockReturnValue(
      claudeSubprocess([], { stdout: 'free-form text', stderr: 'a warning' }),
    );

    const result = await executeClaude('prompt');

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('free-form text\na warning');
    expect(result.cost).toBeNull();
  });

  it('falls back to stdout when the JSON envelope has no result field', async () => {
    mockExeca.mockReturnValue(
      claudeSubprocess(['{"type":"result"}'], { stdout: '{"type":"result"}' }),
    );

    const result = await executeClaude('prompt');

    expect(result.output).toBe('{"type":"result"}');
    expect(result.cost).toBeNull();
  });

  it('keeps stdout+stderr verbatim and reports no metrics on a non-zero exit code', async () => {
    mockExeca.mockReturnValue(
      claudeSubprocess([jsonEnvelope('partial')], {
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
    mockExeca.mockReturnValue(
      claudeSubprocess([], { stdout: 'boom', exitCode: null as unknown as number }),
    );

    const result = await executeClaude('prompt');

    expect(result.exitCode).toBe(1);
  });

  it('exposes the completion signal through the unwrapped result text', async () => {
    mockExeca.mockReturnValue(
      claudeSubprocess([jsonEnvelope('All done.\n<promise>COMPLETE</promise>')]),
    );

    const result = await executeClaude('prompt');

    expect(result.output.includes('<promise>COMPLETE</promise>')).toBe(true);
  });

  it('swallows the agent report in clean mode', async () => {
    const lines: string[] = [];
    setOutputCallback((line) => lines.push(line));
    mockExeca.mockReturnValue(claudeSubprocess([jsonEnvelope('  human readable  ')]));

    await executeClaude('prompt');

    expect(lines).toEqual([]);
  });

  it('forwards the result text line by line under --verbose, not the raw JSON', async () => {
    setVerbose(true);
    const lines: string[] = [];
    setOutputCallback((line) => lines.push(line));
    mockExeca.mockReturnValue(claudeSubprocess([jsonEnvelope('  human readable  ')]));

    await executeClaude('prompt');

    expect(lines).toEqual(['human readable']);
  });

  it('prints a stripped excerpt on failure even in clean mode', async () => {
    const lines: string[] = [];
    setOutputCallback((line) => lines.push(line));
    mockExeca.mockReturnValue(
      claudeSubprocess([], {
        stdout: 'ok\n**boom** in `file.ts`',
        stderr: '',
        exitCode: 1,
      }),
    );

    await executeClaude('prompt');

    expect(lines).toEqual(['ok', 'boom in file.ts']);
  });

  it('does not invoke the output callback when the result text is empty', async () => {
    const onOutput = vi.fn();
    setOutputCallback(onOutput);
    mockExeca.mockReturnValue(claudeSubprocess([jsonEnvelope('   ')]));

    await executeClaude('prompt');

    expect(onOutput).not.toHaveBeenCalled();
  });
});

describe('executeClaude — the inactivity watchdog (US-026)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setOutputCallback(undefined);
  });

  /** A stream that stays silent forever, like a hung agent. */
  function silentSubprocess() {
    const killed: string[] = [];
    const stdout = new Readable({ read() {} });
    const subprocess = new Promise((resolve) => {
      // Resolves only once the watchdog kills it, exactly as execa would.
      const check = setInterval(() => {
        if (killed.length > 0) {
          clearInterval(check);
          stdout.push(null);
          resolve(cliResult({ exitCode: 143 }));
        }
      }, 5);
      check.unref?.();
    }) as unknown as ExecaResult & {
      stdout: Readable;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    subprocess.stdout = stdout;
    subprocess.kill = (signal?: NodeJS.Signals) => {
      killed.push(signal ?? 'SIGTERM');
      return true;
    };
    return { subprocess, killed };
  }

  it('stops an agent that produced nothing, and reports it as stalled', async () => {
    const { subprocess, killed } = silentSubprocess();
    mockExeca.mockReturnValue(subprocess);

    const result = await executeClaude('prompt', { inactivityTimeoutMs: 20 });

    expect(killed).toContain('SIGTERM');
    // The wording is the contract that carries `stalled` through `classify()`.
    expect(result.output).toContain('produced no output for');
    expect(result.output).toContain('(stalled)');
    expect(result.exitCode).not.toBe(0);
  });

  it('leaves a slow but talking agent alone', async () => {
    const stdout = new Readable({ read() {} });
    const subprocess = new Promise((resolve) => {
      let beats = 0;
      const tick = setInterval(() => {
        beats++;
        stdout.push(`${JSON.stringify({ type: 'assistant', n: beats })}\n`);
        if (beats === 6) {
          clearInterval(tick);
          stdout.push(`${jsonEnvelope('slow but finished')}\n`);
          stdout.push(null);
          resolve(cliResult({ exitCode: 0 }));
        }
      }, 5);
      tick.unref?.();
    }) as unknown as ExecaResult & {
      stdout: Readable;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    subprocess.stdout = stdout;
    subprocess.kill = () => true;
    mockExeca.mockReturnValue(subprocess);

    // Each event resets the clock, so 30ms of tolerance survives 6 beats at 5ms.
    const result = await executeClaude('prompt', { inactivityTimeoutMs: 30 });

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('slow but finished');
  });

  it('is off when the timeout is 0, which is the behaviour before it existed', async () => {
    const { subprocess, killed } = silentSubprocess();
    mockExeca.mockReturnValue(subprocess);

    const running = executeClaude('prompt', { inactivityTimeoutMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(killed).toEqual([]);

    // Let the test finish: nothing else would ever stop this process.
    subprocess.kill('SIGTERM');
    await running;
  });
});
