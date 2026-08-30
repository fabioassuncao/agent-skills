import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { execa } from 'execa';
import { createSpinner, ElapsedTimer, formatDuration, getIcons, useColor } from '../ui/logger.js';
import { type ClaudeUsage, parseUsage } from './metrics.js';
import { getSessionPublisher } from './session-publisher.js';
import { isoNow } from './state-manager.js';
import { getOutputCallback, isVerbose } from './verbose.js';

export interface HeadlessOptions {
  prompt: string;
  maxTurns?: number;
  timeout?: number;
  outputFormat?: 'json' | 'text' | 'stream-json';
  allowedTools?: string[];
  /**
   * Extra directories the headless session may read from and write to, passed
   * through as `--add-dir`. Required whenever a prompt points at a path outside
   * the working tree (e.g. the global issue storage under `~/.issue-flow`),
   * since `claude -p` otherwise refuses the access.
   */
  addDirs?: string[];
  /** Status message displayed as spinner (non-verbose) or header (verbose). */
  statusMessage?: string;
  /** Optional callback for routing verbose output (e.g., through listr2 task.output). When provided, verbose stream events are sent here instead of directly to stderr. */
  onOutput?: (line: string) => void;
}

/**
 * Token/cost metrics of a headless invocation.
 *
 * Alias of {@link ClaudeUsage} — the name is kept for the existing call sites,
 * but the shape (and the parsing behind it) now lives in core/metrics.ts, so
 * cache tokens and USD cost come along for free.
 */
export type HeadlessCost = ClaudeUsage;

export interface HeadlessResult {
  success: boolean;
  result: string;
  cost: HeadlessCost | null;
  error: string | null;
}

/**
 * Default wall-clock limit for a single headless invocation.
 *
 * Every phase that invokes `claude` once (analyze, prd, plan, review, pr,
 * pr-review, generate) shares it, so the limit is raised in one place. It is
 * deliberately generous: the phases read the repository before writing their
 * artifact, and on a large issue that alone outlives a few minutes. The execute
 * loop is the exception and runs with no limit at all (`core/executor.ts`),
 * because its iteration budget is what bounds it.
 */
export const DEFAULT_HEADLESS_TIMEOUT_MS = 900_000;

/**
 * The subset of an execa result this module inspects. Declared structurally so
 * both the awaited `execa()` result and the awaited subprocess of the verbose
 * path fit it without a cast to `any`.
 */
interface FinishedProcess {
  exitCode?: number | undefined;
  signal?: string | undefined;
  timedOut?: boolean | undefined;
}

/**
 * How much of the limit an invocation has to have burned through before an
 * unlabelled kill is attributed to the timeout rather than to something
 * external. A limit of 0 means no limit, and nothing can be attributed to it.
 */
const TIMEOUT_ATTRIBUTION_RATIO = 0.9;

function reachedTimeout(timeoutMs: number, elapsedMs: number): boolean {
  return timeoutMs > 0 && elapsedMs >= timeoutMs * TIMEOUT_ATTRIBUTION_RATIO;
}

/**
 * Whether a finished invocation was killed by the `timeout` option.
 *
 * `reject: false` means execa never throws on a timeout — it resolves with a
 * result carrying `timedOut: true`, which is why the `catch` block below never
 * sees one. That flag is the authoritative signal; the rest is a fallback for
 * the case execa cannot label, a CLI that installs its own SIGTERM handler and
 * exits by itself. `claude` does exactly that and leaves 143 (128 + SIGTERM),
 * with no signal for execa to report. The elapsed-time guard keeps that
 * fallback from mislabelling an unrelated external kill as a timeout.
 */
function wasTimedOut(proc: FinishedProcess, timeoutMs: number, elapsedMs: number): boolean {
  if (proc.timedOut === true) return true;
  if (!reachedTimeout(timeoutMs, elapsedMs)) return false;
  return (
    proc.signal === 'SIGTERM' ||
    proc.signal === 'SIGKILL' ||
    proc.exitCode === 143 ||
    proc.exitCode === 137
  );
}

/**
 * The error text of a failed invocation.
 *
 * A timeout gets a message of its own, and it has to keep saying "timed out":
 * `utils/retry.ts` classifies a failure as transient by matching that text, and
 * it is what earns the phase its retries in `core/phase-runner.ts`. Reporting a
 * timeout as a bare `claude exited with code 143` — which is what the CLI
 * leaves behind when it handles the SIGTERM itself — both hid the cause and
 * cost the phase every retry it had.
 */
function describeFailure(
  proc: FinishedProcess,
  diagnostics: string,
  timeoutMs: number,
  elapsedMs: number,
): string {
  if (wasTimedOut(proc, timeoutMs, elapsedMs)) {
    return `Headless invocation timed out after ${formatDuration(Math.round(timeoutMs / 1000))}. Raise the limit with --timeout <seconds> (0 = no limit).`;
  }
  return diagnostics.trim() || `claude exited with code ${proc.exitCode ?? 'unknown'}`;
}

/* ── argument helpers ───────────────────────────────────────────────────── */

/**
 * Append one `<flag> <value>` pair per value. An empty or absent list leaves
 * `args` untouched, so callers that pass nothing keep the exact same argv.
 */
function pushRepeatedFlag(args: string[], flag: string, values: string[] | undefined): void {
  if (!values || values.length === 0) return;
  for (const value of values) {
    args.push(flag, value);
  }
}

/* ── verbose stream formatting ──────────────────────────────────────────── */

/**
 * Extract a short context string from a tool_use input object.
 */
function getToolContext(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
      return shortPath(input.file_path as string);
    case 'Write':
    case 'Edit':
      return shortPath(input.file_path as string);
    case 'Glob':
      return (input.pattern as string) ?? '';
    case 'Grep':
      return (input.pattern as string) ?? '';
    case 'Bash': {
      const cmd = (input.command as string) ?? '';
      return cmd.length > 60 ? `${cmd.substring(0, 57)}...` : cmd;
    }
    default:
      return '';
  }
}

/**
 * Shorten a file path to be relative-friendly.
 */
function shortPath(filePath: string | undefined): string {
  if (!filePath) return '';
  const cwd = process.cwd();
  if (filePath.startsWith(cwd)) {
    return filePath.substring(cwd.length + 1);
  }
  // Show last 2 segments for absolute paths
  const parts = filePath.split('/');
  if (parts.length > 2) {
    return `.../${parts.slice(-2).join('/')}`;
  }
  return filePath;
}

/**
 * Print a formatted stream event line to stderr.
 */
function printStreamEvent(
  line: string,
  state: { turnCount: number },
  onOutput?: (line: string) => void,
): void {
  let event: {
    type?: string;
    subtype?: string;
    message?: {
      content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[];
    };
  };

  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  const icons = getIcons();
  const colored = useColor();
  const emit = onOutput ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  if (event.type === 'assistant' && event.message?.content) {
    state.turnCount++;

    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) {
        // Wrap text with connector prefix
        const lines = block.text.split('\n');
        for (const textLine of lines) {
          if (!textLine.trim()) continue;
          const prefix = colored ? chalk.dim(`  ${icons.connector}  `) : `  ${icons.connector}  `;
          const text = colored ? chalk.dim(textLine) : textLine;
          emit(`${prefix}${text}`);
        }
      }

      if (block.type === 'tool_use' && block.name) {
        const context = block.input ? getToolContext(block.name, block.input) : '';
        getSessionPublisher().publish({
          type: 'activity',
          at: isoNow(),
          tool: block.name,
          detail: context || undefined,
        });
        const toolName = block.name.padEnd(12);

        const prefix = colored ? chalk.dim(`  ${icons.connector}  `) : `  ${icons.connector}  `;
        const toolIcon = colored ? chalk.cyan(icons.tool) : icons.tool;
        const toolLabel = colored ? chalk.cyan(toolName) : toolName;
        const contextText = context ? (colored ? chalk.dim(context) : context) : '';

        emit(`${prefix}${toolIcon} ${toolLabel} ${contextText}`);
      }
    }
  }
}

/* ── verbose execution ──────────────────────────────────────────────────── */

/**
 * Run headless in verbose mode using stream-json to display real-time progress.
 */
async function runHeadlessVerbose(options: {
  prompt: string;
  maxTurns: number;
  timeout: number;
  allowedTools?: string[];
  addDirs?: string[];
  statusMessage?: string;
  onOutput?: (line: string) => void;
}): Promise<HeadlessResult> {
  const { prompt, maxTurns, timeout, allowedTools, addDirs, statusMessage, onOutput } = options;
  const icons = getIcons();
  const colored = useColor();
  const emit = onOutput ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  // Print header
  if (statusMessage) {
    const msg = colored
      ? chalk.blue(`${icons.start} ${statusMessage}`)
      : `${icons.start} ${statusMessage}`;
    emit(msg);
  }

  // Print opening connector
  const connectorLine = colored ? chalk.dim(`  ${icons.connector}`) : `  ${icons.connector}`;
  emit(connectorLine);

  const startTime = Date.now();

  const args: string[] = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(maxTurns),
  ];

  pushRepeatedFlag(args, '--allowedTools', allowedTools);
  pushRepeatedFlag(args, '--add-dir', addDirs);

  const subprocess = execa('claude', args, {
    stdin: 'ignore',
    reject: false,
    timeout,
    stripFinalNewline: false,
  });

  let resultText = '';
  let isError = false;
  let costData: HeadlessCost | null = null;
  const state = { turnCount: 0 };

  if (subprocess.stdout) {
    const rl = createInterface({ input: subprocess.stdout });
    for await (const line of rl) {
      printStreamEvent(line, state, onOutput);

      try {
        const event = JSON.parse(line);
        if (event.type === 'result') {
          resultText = event.result ?? '';
          isError = event.is_error === true;
          // Keep the previous metrics when this event carries none, so a
          // malformed trailing result never erases what was already captured.
          costData = parseUsage(event) ?? costData;
        }
      } catch {
        // ignore malformed lines
      }
    }
  }

  // Wait for the process to finish
  const proc = await subprocess;

  // Close connector with elapsed time
  const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
  const durationStr = formatDuration(elapsedSec);
  const doneLine = colored
    ? chalk.dim(`  ${icons.connector}  ${chalk.italic(`Done in ${durationStr}`)}`)
    : `  ${icons.connector}  Done in ${durationStr}`;
  emit(doneLine);
  emit(connectorLine);

  if (proc.exitCode !== 0 && !resultText) {
    return {
      success: false,
      result: '',
      cost: null,
      error: describeFailure(proc, proc.stderr?.toString() ?? '', timeout, Date.now() - startTime),
    };
  }

  return {
    success: !isError,
    result: resultText,
    cost: costData,
    error: isError ? resultText : null,
  };
}

/* ── standard execution ─────────────────────────────────────────────────── */

/**
 * Invoke Claude Code in headless mode via `claude -p`.
 *
 * Each invocation is an isolated session — no context is shared between calls.
 * Output is parsed as JSON when outputFormat is 'json' (default).
 *
 * When verbose mode is active, uses stream-json to display real-time progress.
 * Otherwise, shows a spinner while waiting.
 */
export async function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
  const {
    prompt,
    maxTurns = 10,
    timeout = DEFAULT_HEADLESS_TIMEOUT_MS,
    outputFormat = 'json',
    allowedTools,
    addDirs,
    statusMessage,
    onOutput,
  } = options;

  if (isVerbose()) {
    // Use explicit onOutput, fall back to global output callback, or default to stderr
    const effectiveOnOutput = onOutput ?? getOutputCallback();
    return runHeadlessVerbose({
      prompt,
      maxTurns,
      timeout,
      allowedTools,
      addDirs,
      statusMessage,
      onOutput: effectiveOnOutput,
    });
  }

  // Non-verbose: use spinner with elapsed timer
  const startTime = Date.now();
  const spinner = statusMessage ? createSpinner(statusMessage).start() : null;

  let timer: ElapsedTimer | null = null;
  if (spinner) {
    timer = new ElapsedTimer((elapsed) => {
      spinner.suffixText = useColor() ? chalk.dim(`(${elapsed})`) : `(${elapsed})`;
    }).start();
  }

  const args: string[] = [
    '-p',
    prompt,
    '--output-format',
    outputFormat,
    '--max-turns',
    String(maxTurns),
  ];

  pushRepeatedFlag(args, '--allowedTools', allowedTools);
  pushRepeatedFlag(args, '--add-dir', addDirs);

  try {
    const proc = await execa('claude', args, {
      stdin: 'ignore',
      reject: false,
      timeout,
      stripFinalNewline: false,
    });

    const stdout = proc.stdout?.toString() ?? '';
    const stderr = proc.stderr?.toString() ?? '';

    if (proc.exitCode !== 0) {
      const elapsed = timer?.stop() ?? 0;
      const dur = useColor()
        ? chalk.dim(` (${formatDuration(elapsed)})`)
        : ` (${formatDuration(elapsed)})`;
      spinner?.fail(`${statusMessage}${dur}`);
      return {
        success: false,
        result: '',
        cost: null,
        error: describeFailure(proc, stderr || stdout, timeout, Date.now() - startTime),
      };
    }

    const elapsed = timer?.stop() ?? 0;
    const dur = useColor()
      ? chalk.dim(` (${formatDuration(elapsed)})`)
      : ` (${formatDuration(elapsed)})`;
    spinner?.succeed(`${statusMessage}${dur}`);

    if (outputFormat === 'json') {
      try {
        const parsed = JSON.parse(stdout);
        return {
          success: true,
          result: parsed.result ?? stdout,
          cost: parseUsage(parsed),
          error: null,
        };
      } catch {
        return {
          success: true,
          result: stdout,
          cost: null,
          error: null,
        };
      }
    }

    return {
      success: true,
      result: stdout,
      cost: null,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const catchElapsed = timer?.stop() ?? 0;
    const catchDur = useColor()
      ? chalk.dim(` (${formatDuration(catchElapsed)})`)
      : ` (${formatDuration(catchElapsed)})`;
    spinner?.fail(`${statusMessage}${catchDur}`);

    if (message.includes('timed out') || message.includes('ETIMEDOUT')) {
      // There is no finished process to inspect here, so the clock is the only
      // evidence. Claim our own limit only when the invocation actually ran up
      // against it: an ETIMEDOUT raised minutes earlier — or with no limit set
      // at all — keeps its own message, which is the honest diagnosis and
      // already carries the words isTransientFailure() matches on.
      const elapsedMs = Date.now() - startTime;
      return {
        success: false,
        result: '',
        cost: null,
        error: describeFailure(
          { timedOut: reachedTimeout(timeout, elapsedMs) },
          message,
          timeout,
          elapsedMs,
        ),
      };
    }

    return {
      success: false,
      result: '',
      cost: null,
      error: message,
    };
  }
}
