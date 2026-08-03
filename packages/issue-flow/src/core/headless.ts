import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { execa } from 'execa';
import { createSpinner, ElapsedTimer, formatDuration, getIcons, useColor } from '../ui/logger.js';
import { getSessionPublisher } from './session-publisher.js';
import { isoNow } from './state-manager.js';
import { getOutputCallback, isVerbose } from './verbose.js';

export interface HeadlessOptions {
  prompt: string;
  maxTurns?: number;
  timeout?: number;
  outputFormat?: 'json' | 'text' | 'stream-json';
  allowedTools?: string[];
  /** Status message displayed as spinner (non-verbose) or header (verbose). */
  statusMessage?: string;
  /** Optional callback for routing verbose output (e.g., through listr2 task.output). When provided, verbose stream events are sent here instead of directly to stderr. */
  onOutput?: (line: string) => void;
}

export interface HeadlessCost {
  inputTokens?: number;
  outputTokens?: number;
}

export interface HeadlessResult {
  success: boolean;
  result: string;
  cost: HeadlessCost | null;
  error: string | null;
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
async function runHeadlessVerbose(
  prompt: string,
  maxTurns: number,
  timeout: number,
  allowedTools?: string[],
  statusMessage?: string,
  onOutput?: (line: string) => void,
): Promise<HeadlessResult> {
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

  if (allowedTools && allowedTools.length > 0) {
    for (const tool of allowedTools) {
      args.push('--allowedTools', tool);
    }
  }

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
          if (event.total_cost_usd != null && event.usage) {
            costData = {
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
            };
          }
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
    const stderr = proc.stderr?.toString() ?? '';
    const isTimeout =
      proc.exitCode === 143 || ('signalName' in proc && proc.signalName === 'SIGTERM');
    const errorMsg = isTimeout
      ? `Headless invocation timed out after ${timeout}ms`
      : stderr || `claude exited with code ${proc.exitCode}`;
    return {
      success: false,
      result: '',
      cost: null,
      error: errorMsg,
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
    timeout = 300_000,
    outputFormat = 'json',
    allowedTools,
    statusMessage,
    onOutput,
  } = options;

  if (isVerbose()) {
    // Use explicit onOutput, fall back to global output callback, or default to stderr
    const effectiveOnOutput = onOutput ?? getOutputCallback();
    return runHeadlessVerbose(
      prompt,
      maxTurns,
      timeout,
      allowedTools,
      statusMessage,
      effectiveOnOutput,
    );
  }

  // Non-verbose: use spinner with elapsed timer
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

  if (allowedTools && allowedTools.length > 0) {
    for (const tool of allowedTools) {
      args.push('--allowedTools', tool);
    }
  }

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
        error: stderr || stdout || `claude exited with code ${proc.exitCode}`,
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
          cost:
            parsed.cost_usd != null
              ? { inputTokens: parsed.num_input_tokens, outputTokens: parsed.num_output_tokens }
              : null,
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
      return {
        success: false,
        result: '',
        cost: null,
        error: `Headless invocation timed out after ${timeout}ms`,
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
