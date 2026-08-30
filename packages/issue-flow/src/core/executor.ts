import { invokeSelectedAgent } from '../agents/invoke.js';
import type { ClaudeResult } from '../types.js';
import { failureExcerpt } from '../ui/text.js';
import { getOutputCallback, isVerbose } from './verbose.js';

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

  emitAgentOutput(output, !(run.success && run.exitCode === 0));

  return {
    exitCode: run.exitCode === 0 && run.success ? 0 : run.exitCode === 0 ? 1 : run.exitCode,
    output,
    cost,
  };
}

/**
 * Clean mode never dumps the agent report. Verbose breaks it line by line.
 * A failure always prints a short excerpt — the user should not need
 * `--verbose` to see why a story stopped.
 */
function emitAgentOutput(output: string, failed: boolean): void {
  const onOutput = getOutputCallback();
  if (!onOutput) return;
  const trimmed = output.trim();
  if (!trimmed) return;

  if (isVerbose()) {
    for (const line of trimmed.split('\n')) {
      if (line.trim()) onOutput(line);
    }
    return;
  }

  if (failed) {
    for (const line of failureExcerpt(trimmed)) {
      onOutput(line);
    }
  }
}
