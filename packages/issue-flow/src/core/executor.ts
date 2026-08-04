import { execa } from 'execa';
import type { ClaudeResult } from '../types.js';
import { type ClaudeUsage, parseUsage } from './metrics.js';
import { getOutputCallback } from './verbose.js';

/**
 * Execute Claude CLI with a prompt piped to stdin.
 *
 * Runs: echo $PROMPT | claude --dangerously-skip-permissions --print --output-format json
 *
 * The JSON envelope is requested purely for observability: it carries the token
 * and cost metrics of the execute phase. Every flow decision keeps working off
 * the same values as before — `exitCode` and the assistant's text — so the
 * envelope is unwrapped here and never leaks to callers. Whenever stdout is not
 * parseable JSON (or the CLI failed), the behaviour falls back exactly to the
 * previous combined stdout+stderr text with no metrics.
 */
export async function executeClaude(prompt: string): Promise<ClaudeResult> {
  const result = await execa(
    'claude',
    ['--dangerously-skip-permissions', '--print', '--output-format', 'json'],
    {
      input: prompt,
      reject: false,
      timeout: 0, // No timeout — let the engine handle iteration limits
      stripFinalNewline: false,
    },
  );

  // Combine stdout and stderr to match Bash's 2>&1 behavior
  const stdout = result.stdout?.toString() ?? '';
  const stderr = result.stderr?.toString() ?? '';
  const exitCode = result.exitCode ?? 1;

  let output = stdout + (stderr ? `\n${stderr}` : '');
  let cost: ClaudeUsage | null = null;

  // Only unwrap on success: a failing CLI may print diagnostics on stderr that
  // trimErrorMessage()/isTransientFailure() need to see verbatim.
  if (exitCode === 0) {
    try {
      const parsed: unknown = JSON.parse(stdout);
      const text = (parsed as { result?: unknown } | null)?.result;
      // Non-string `result` would break the callers that treat output as text.
      output = typeof text === 'string' ? text : stdout;
      cost = parseUsage(parsed);
    } catch {
      // Not JSON — keep the raw combined output and report no metrics.
    }
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
