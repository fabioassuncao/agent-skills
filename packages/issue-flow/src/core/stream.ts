import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { type ClaudeUsage, parseUsage } from './metrics.js';

/**
 * Reading the CLI's `stream-json` output.
 *
 * The project used to ask for two different formats depending on whether the
 * user passed `--verbose`: `stream-json` when it had something to print, and a
 * single `json` envelope otherwise. The envelope is one write at the very end,
 * which means the non-verbose path — the common one, and the one that runs
 * unattended for hours — had **no signal at all** while the agent worked. An
 * agent that hung produced exactly the same observable behaviour as one that
 * was thinking.
 *
 * So the stream is now always what is requested, and only the *rendering*
 * differs: verbose prints each event, non-verbose feeds a spinner and a
 * watchdog heartbeat. This module is the half both share — the parsing, the
 * final result and the usage — so neither can drift from the other.
 */

/** What a finished stream yielded. */
export interface StreamOutcome {
  /** Assistant text of the `result` event; `''` when none arrived. */
  result: string;
  /** Whether the `result` event reported an error. */
  isError: boolean;
  usage: ClaudeUsage | null;
  /** How many lines were read. `0` means the CLI printed nothing at all. */
  events: number;
  /**
   * Everything the stream printed, joined back together.
   *
   * The fallback for a CLI build that ignores `--output-format` and prints
   * plain text: the stream is consumed by the time the process finishes, so
   * `result.stdout` is empty and this is the only copy of what it said.
   */
  raw: string;
}

export interface ReadStreamOptions {
  /** Called for every line, parsed or not. This is the watchdog's heartbeat. */
  onLine?: (line: string) => void;
  /** Called for every event that parsed, after `onLine`. */
  onEvent?: (event: Record<string, unknown>) => void;
}

/**
 * Consume `stream-json` from `stdout` until it ends.
 *
 * Malformed lines are skipped rather than fatal: the CLI interleaves its own
 * diagnostics with the stream, and a run must not die because one line was not
 * JSON. They still count as activity — a process writing anything is a process
 * that is alive, which is the only question the watchdog is asking.
 */
export async function readClaudeStream(
  stdout: Readable,
  options: ReadStreamOptions = {},
): Promise<StreamOutcome> {
  const outcome: StreamOutcome = { result: '', isError: false, usage: null, events: 0, raw: '' };
  const collected: string[] = [];

  const lines = createInterface({ input: stdout });
  for await (const line of lines) {
    options.onLine?.(line);
    if (line.trim() === '') continue;
    outcome.events++;
    collected.push(line);

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== 'object' || event === null) continue;

    const record = event as Record<string, unknown>;
    options.onEvent?.(record);

    if (record.type === 'result') {
      outcome.result = typeof record.result === 'string' ? record.result : '';
      outcome.isError = record.is_error === true;
      // Keep the previous metrics when this event carries none, so a malformed
      // trailing result never erases what was already captured.
      outcome.usage = parseUsage(record) ?? outcome.usage;
    }
  }

  outcome.raw = collected.join('\n');
  return outcome;
}
