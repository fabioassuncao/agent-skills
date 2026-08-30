import { execa } from 'execa';
import type { ClaudeResult } from '../types.js';
import type { ClaudeUsage } from './metrics.js';
import { registerChild } from './shutdown.js';
import { readClaudeStream } from './stream.js';
import { getOutputCallback } from './verbose.js';
import { createWatchdog, describeStall } from './watchdog.js';

export interface ExecuteClaudeOptions {
  /**
   * Silence tolerated before the agent is considered stuck. `0` disables the
   * watchdog, which is the behaviour every release before it had.
   */
  inactivityTimeoutMs?: number;
}

/**
 * Execute Claude CLI with a prompt piped to stdin.
 *
 * Runs: `claude --dangerously-skip-permissions --print --output-format
 * stream-json --verbose`, with the prompt on stdin.
 *
 * **The stream is what makes the loop observable.** This phase runs with
 * `timeout: 0` on purpose — its budget is iterations, not seconds — so before
 * the stream there was no signal whatsoever between "started" and "finished",
 * and an agent that hung hung forever. Every line is now a heartbeat for the
 * watchdog, which is the only instrument that can tell a long task from a stuck
 * one.
 *
 * What callers see is unchanged: `exitCode`, the assistant's text as `output`,
 * and the usage of the invocation. Whenever the stream yields nothing usable
 * (or the CLI failed), the behaviour falls back exactly to the previous
 * combined stdout+stderr text with no metrics.
 */
export async function executeClaude(
  prompt: string,
  options: ExecuteClaudeOptions = {},
): Promise<ClaudeResult> {
  const subprocess = execa(
    'claude',
    ['--dangerously-skip-permissions', '--print', '--output-format', 'stream-json', '--verbose'],
    {
      input: prompt,
      reject: false,
      timeout: 0, // No timeout — the engine bounds this by iterations
      stripFinalNewline: false,
    },
  );

  const unregisterChild = registerChild({
    kill: (signal) => subprocess.kill(signal),
    done: subprocess.then(
      () => undefined,
      () => undefined,
    ),
  });

  const watchdog = createWatchdog({
    ...(options.inactivityTimeoutMs === undefined
      ? {}
      : { inactivityTimeoutMs: options.inactivityTimeoutMs }),
    child: {
      kill: (signal) => subprocess.kill(signal),
      done: subprocess.then(
        () => undefined,
        () => undefined,
      ),
    },
  });

  let streamed: Awaited<ReturnType<typeof readClaudeStream>> = {
    result: '',
    isError: false,
    usage: null,
    events: 0,
    raw: '',
  };
  if (subprocess.stdout) {
    streamed = await readClaudeStream(subprocess.stdout, { onLine: () => watchdog.beat() });
  }

  const result = await subprocess;
  watchdog.stop();
  unregisterChild();

  // Combine stdout and stderr to match Bash's 2>&1 behavior
  const stdout = result.stdout?.toString() ?? '';
  const stderr = result.stderr?.toString() ?? '';
  const exitCode = result.exitCode ?? 1;

  // The stream is consumed by the time the process finishes, so what it printed
  // lives in `streamed.raw` rather than in `result.stdout`. Falling back to
  // `stdout` keeps a CLI build that ignores `--output-format` — and every
  // failure that printed nothing on the stream — behaving as it always did.
  const printed = streamed.raw === '' ? stdout : streamed.raw;
  let output = printed + (stderr ? `\n${stderr}` : '');
  let cost: ClaudeUsage | null = null;

  if (watchdog.stalled) {
    // The wording is the contract: `classify()` reads it as a last resort, and
    // `stalled` has to survive the trip through a plain string for the phase to
    // keep its retries.
    return {
      exitCode: exitCode === 0 ? 1 : exitCode,
      output: describeStall(watchdog.silentMs),
      cost: null,
    };
  }

  // Only unwrap on success: a failing CLI may print diagnostics on stderr that
  // trimErrorMessage()/isTransientFailure() need to see verbatim.
  if (exitCode === 0 && streamed.result !== '') {
    output = streamed.result;
    cost = streamed.usage;
  }

  // Forward output through the global callback (listr2 renderer) when active
  const onOutput = getOutputCallback();
  if (onOutput) {
    const trimmed = output.trim();
    if (trimmed) {
      onOutput(trimmed);
    }
  }

  return {
    exitCode,
    output,
    cost,
  };
}
