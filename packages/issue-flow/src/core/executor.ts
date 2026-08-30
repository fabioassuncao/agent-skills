import { invokeSelectedAgent } from '../agents/invoke.js';
import type { ClaudeResult } from '../types.js';
import { getOutputCallback } from './verbose.js';

export interface ExecuteClaudeOptions {
  /**
   * Silence tolerated before the agent is considered stuck. `0` disables the
   * watchdog, which is the behaviour every release before it had.
   */
  inactivityTimeoutMs?: number;
}

/**
 * Execute the resolved agent with a prompt piped to stdin.
 *
 * The default (Claude, unconfigured) is still
 * `claude --dangerously-skip-permissions --print --output-format stream-json --verbose`
 * with the prompt on stdin and `timeout: 0`. Callers see `exitCode`, the
 * assistant text as `output`, and usage. On failure the raw diagnostics stay
 * unwrapped so `isTransientFailure()` can read them.
 */
export async function executeClaude(
  prompt: string,
  options: ExecuteClaudeOptions = {},
): Promise<ClaudeResult> {
  let selected: Awaited<ReturnType<typeof invokeSelectedAgent>>;
  try {
    selected = await invokeSelectedAgent({
      prompt,
      phase: 'execute',
      timeout: 0,
      permission: 'autonomous',
      inactivityTimeoutMs: options.inactivityTimeoutMs,
    });
  } catch (err) {
    return {
      exitCode: 1,
      output: err instanceof Error ? err.message : String(err),
      cost: null,
    };
  }
  const { run } = selected;

  let output: string;
  let cost = run.usage;

  if (!run.success || run.exitCode !== 0) {
    output = run.rawOutput || run.error || '';
    cost = null;
  } else {
    output = run.result || run.rawOutput;
  }

  const onOutput = getOutputCallback();
  if (onOutput) {
    const trimmed = output.trim();
    if (trimmed) onOutput(trimmed);
  }

  return {
    exitCode: run.exitCode === 0 && run.success ? 0 : run.exitCode === 0 ? 1 : run.exitCode,
    output,
    cost,
  };
}
