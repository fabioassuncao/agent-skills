import { readFile } from 'node:fs/promises';
import chalk from 'chalk';
import { runnerFor } from '../agents/registry.js';
import { resolveAgentFor } from '../agents/resolve.js';
import type { AgentEvent, AgentPermission, AgentPhase, AgentProviderId } from '../agents/types.js';
import { createSpinner, ElapsedTimer, formatDuration, getIcons, useColor } from '../ui/logger.js';
import { DECOMPOSITION_THRESHOLDS, timeoutsByPhase } from './decompose.js';
import { type ClaudeUsage, parseUsage } from './metrics.js';
import { getSessionPublisher } from './session-publisher.js';
import { isoNow } from './state-manager.js';
import { getInactivityTimeout, getOutputCallback, isVerbose } from './verbose.js';

export interface HeadlessOptions {
  prompt: string;
  maxTurns?: number;
  timeout?: number;
  outputFormat?: 'json' | 'text' | 'stream-json';
  allowedTools?: string[];
  /**
   * Extra directories the headless session may read from and write to, passed
   * through as `--add-dir`. Required whenever a prompt points at a path outside
   * the working tree (e.g. the global issue storage under `~/.issue-flow`).
   */
  addDirs?: string[];
  /** Status message displayed as spinner (non-verbose) or header (verbose). */
  statusMessage?: string;
  /** Optional callback for routing verbose output (e.g., through listr2 task.output). */
  onOutput?: (line: string) => void;
  /** Journal-backed identity used to apply the one-time 2× timeout escalation. */
  timeoutHistory?: {
    phase: string;
    journalFiles: string[];
  };
  /** The invoking phase. Defaults to `analyze` only for resolution; argv is unchanged. */
  phase?: AgentPhase;
  /**
   * Semantic permission. Absent means `workspace`, which is the historical
   * `runHeadless` argv (no `--permission-mode`, no `--dangerously-skip-permissions`).
   */
  permission?: AgentPermission;
}

export type HeadlessCost = ClaudeUsage;

export interface HeadlessResult {
  success: boolean;
  result: string;
  cost: HeadlessCost | null;
  error: string | null;
  agent?: { provider: AgentProviderId; model: string | null };
}

export const DEFAULT_HEADLESS_TIMEOUT_MS = 900_000;

async function escalatedTimeout(
  timeoutMs: number,
  history: HeadlessOptions['timeoutHistory'],
): Promise<number> {
  if (timeoutMs === 0 || history === undefined) return timeoutMs;

  const journal = (
    await Promise.all(
      history.journalFiles.map(async (file) => {
        try {
          return await readFile(file, 'utf-8');
        } catch {
          return '';
        }
      }),
    )
  ).join('');
  const timeouts = timeoutsByPhase(journal).get(history.phase) ?? 0;
  if (timeouts < DECOMPOSITION_THRESHOLDS.timeoutsPerPhase) return timeoutMs;
  return Math.min(timeoutMs * 2, Number.MAX_SAFE_INTEGER);
}

function printAgentEvent(event: AgentEvent, onOutput?: (line: string) => void): void {
  const icons = getIcons();
  const colored = useColor();
  const emit = onOutput ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  if (event.kind === 'text') {
    const lines = event.text.split('\n');
    for (const textLine of lines) {
      if (!textLine.trim()) continue;
      const prefix = colored ? chalk.dim(`  ${icons.connector}  `) : `  ${icons.connector}  `;
      const text = colored ? chalk.dim(textLine) : textLine;
      emit(`${prefix}${text}`);
    }
    return;
  }

  getSessionPublisher().publish({
    type: 'activity',
    at: isoNow(),
    tool: event.name,
    detail: event.detail,
  });
  const toolName = event.name.padEnd(12);
  const prefix = colored ? chalk.dim(`  ${icons.connector}  `) : `  ${icons.connector}  `;
  const toolIcon = colored ? chalk.cyan(icons.tool) : icons.tool;
  const toolLabel = colored ? chalk.cyan(toolName) : toolName;
  const contextText = event.detail ? (colored ? chalk.dim(event.detail) : event.detail) : '';
  emit(`${prefix}${toolIcon} ${toolLabel} ${contextText}`);
}

/**
 * Invoke the resolved agent in headless mode.
 *
 * Each invocation is an isolated session. UI (spinner, verbose header, activity)
 * stays here; argv and stream parsing belong to the runner.
 */
export async function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
  const {
    prompt,
    maxTurns = 10,
    timeout: configuredTimeout = DEFAULT_HEADLESS_TIMEOUT_MS,
    outputFormat = 'json',
    allowedTools,
    addDirs,
    statusMessage,
    onOutput,
    phase = 'analyze',
    permission = 'workspace',
  } = options;
  const timeout = await escalatedTimeout(configuredTimeout, options.timeoutHistory);
  const settings = await resolveAgentFor(phase);
  const runner = runnerFor(settings.provider);

  const verbose = isVerbose();
  const effectiveOnOutput = onOutput ?? getOutputCallback();

  if (verbose) {
    const icons = getIcons();
    const colored = useColor();
    const emit = effectiveOnOutput ?? ((msg: string) => process.stderr.write(`${msg}\n`));
    if (statusMessage) {
      const msg = colored
        ? chalk.blue(`${icons.start} ${statusMessage}`)
        : `${icons.start} ${statusMessage}`;
      emit(msg);
    }
    const connectorLine = colored ? chalk.dim(`  ${icons.connector}`) : `  ${icons.connector}`;
    emit(connectorLine);

    const startTime = Date.now();
    const run = await runner.run(
      {
        prompt,
        phase,
        addDirs,
        timeout,
        permission,
        maxTurns,
        allowedTools,
        onEvent: (event) => printAgentEvent(event, effectiveOnOutput),
      },
      settings,
    );

    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const durationStr = formatDuration(elapsedSec);
    const doneLine = colored
      ? chalk.dim(`  ${icons.connector}  ${chalk.italic(`Done in ${durationStr}`)}`)
      : `  ${icons.connector}  Done in ${durationStr}`;
    emit(doneLine);
    emit(connectorLine);

    return mapHeadlessResult(run, outputFormat);
  }

  const spinner = statusMessage ? createSpinner(statusMessage).start() : null;
  let timer: ElapsedTimer | null = null;
  if (spinner) {
    timer = new ElapsedTimer((elapsed) => {
      spinner.suffixText = useColor() ? chalk.dim(`(${elapsed})`) : `(${elapsed})`;
    }).start();
  }

  try {
    const run = await runner.run(
      {
        prompt,
        phase,
        addDirs,
        timeout,
        permission,
        maxTurns,
        allowedTools,
        inactivityTimeoutMs: getInactivityTimeout(),
      },
      settings,
    );

    const elapsed = timer?.stop() ?? 0;
    const dur = useColor()
      ? chalk.dim(` (${formatDuration(elapsed)})`)
      : ` (${formatDuration(elapsed)})`;

    if (!run.success) {
      spinner?.fail(`${statusMessage}${dur}`);
      return mapHeadlessResult(run, outputFormat);
    }

    spinner?.succeed(`${statusMessage}${dur}`);
    return mapHeadlessResult(run, outputFormat);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const catchElapsed = timer?.stop() ?? 0;
    const catchDur = useColor()
      ? chalk.dim(` (${formatDuration(catchElapsed)})`)
      : ` (${formatDuration(catchElapsed)})`;
    spinner?.fail(`${statusMessage}${catchDur}`);
    return {
      success: false,
      result: '',
      cost: null,
      error: message,
      agent: { provider: settings.provider, model: settings.model },
    };
  }
}

function mapHeadlessResult(
  run: {
    success: boolean;
    result: string;
    rawOutput: string;
    usage: ClaudeUsage | null;
    error: string | null;
    agent: { provider: AgentProviderId; model: string | null };
  },
  outputFormat: 'json' | 'text' | 'stream-json',
): HeadlessResult {
  if (outputFormat === 'text') {
    return {
      success: run.success,
      result: run.success ? run.rawOutput || run.result : '',
      cost: null,
      error: run.error,
      agent: run.agent,
    };
  }
  if (!run.success) {
    return {
      success: false,
      result: '',
      cost: null,
      error: run.error,
      agent: run.agent,
    };
  }
  return {
    success: true,
    result: run.result,
    cost: run.usage,
    error: null,
    agent: run.agent,
  };
}

/** Kept so existing tests that imported parse helpers through this module still typecheck. */
export { parseUsage };
