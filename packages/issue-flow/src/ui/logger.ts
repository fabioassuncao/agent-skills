import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { getSessionPublisher } from '../core/session-publisher.js';
import type { SessionLogLevel } from '../core/session-state.js';
import { isoNow } from '../core/state-manager.js';
import { getOutputCallback } from '../core/verbose.js';
import { writeDiagnostic } from '../storage/diagnostics.js';
import { redactSecrets } from '../telemetry/redact.js';

/**
 * Detect if unicode output is supported.
 */
export function useUnicode(): boolean {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== '') return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

/**
 * Detect if color output is supported.
 */
export function useColor(): boolean {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== '') return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

export interface Icons {
  success: string;
  fail: string;
  pending: string;
  retry: string;
  warn: string;
  start: string;
  end: string;
  notReached: string;
  tool: string;
  connector: string;
  info: string;
}

export function getIcons(): Icons {
  if (useUnicode()) {
    return {
      success: '\u2713',
      fail: '\u2717',
      pending: '\u23F3',
      retry: '\u21BB',
      warn: '\u26A0',
      start: '\u25B6',
      end: '\u25A0',
      notReached: '\u25CB',
      tool: '\u25B8',
      connector: '\u2502',
      info: '\u00B7',
    };
  }
  return {
    success: '[OK]',
    fail: '[FAIL]',
    pending: '[...]',
    retry: '[RETRY]',
    warn: '[WARN]',
    start: '[START]',
    end: '[END]',
    notReached: '[ ]',
    tool: '>',
    connector: '|',
    info: '-',
  };
}

/**
 * Get the terminal width.
 */
export function getTermWidth(): number {
  return process.stdout.columns ?? 80;
}

/**
 * Emit a line of output. Routes through the global output callback when
 * running inside a listr2 task context, otherwise falls back to console.log.
 *
 * Also forwards the line to the session publisher with its structured level;
 * ANSI codes are stripped by the reducer, so terminal output stays untouched.
 */
function emit(line: string, level: SessionLogLevel = 'info'): void {
  getSessionPublisher().publish({ type: 'log', at: isoNow(), level, message: line });
  writeDiagnostic({
    level: level === 'warn' ? 'warning' : level,
    message: line,
  });
  const cb = getOutputCallback();
  if (cb) {
    cb(line);
  } else {
    console.log(line);
  }
}

export function printSuccess(message: string): void {
  const icons = getIcons();
  if (useColor()) {
    emit(chalk.green(`${icons.success} ${message}`));
  } else {
    emit(`${icons.success} ${message}`);
  }
}

export function printError(message: string): void {
  const icons = getIcons();
  if (useColor()) {
    emit(chalk.red(`${icons.fail} ${message}`), 'error');
  } else {
    emit(`${icons.fail} ${message}`, 'error');
  }
}

export function printWarning(message: string): void {
  const icons = getIcons();
  if (useColor()) {
    emit(chalk.yellow(`${icons.warn} ${message}`), 'warn');
  } else {
    emit(`${icons.warn} ${message}`, 'warn');
  }
}

export function printRetry(message: string): void {
  const icons = getIcons();
  if (useColor()) {
    emit(chalk.yellow(`${icons.retry} ${message}`), 'warn');
  } else {
    emit(`${icons.retry} ${message}`, 'warn');
  }
}

export function printInfo(message: string): void {
  const icons = getIcons();
  if (useColor()) {
    emit(chalk.blue(`${icons.info} ${message}`));
  } else {
    emit(`${icons.info} ${message}`);
  }
}

/** Format a long-lived process event without introducing a second logger. */
export function formatSubsystemLine(
  subsystem: string,
  message: string,
  now: Date = new Date(),
): string {
  const timestamp = now.toISOString().slice(11, 23);
  return `[${timestamp}] [${subsystem}] ${redactSecrets(message)}`;
}

/** One timestamped operational event, routed through the CLI's single writer. */
export function printSubsystem(subsystem: string, message: string): void {
  emit(formatSubsystemLine(subsystem, message));
}

/**
 * Create an ora spinner with consistent styling.
 */
export function createSpinner(message: string): Ora {
  return ora({
    text: message,
    color: 'blue',
    spinner: 'dots',
  });
}

/**
 * Format a duration in seconds to a human-readable string.
 */
export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${mins}m ${secs}s`;
  }
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

/**
 * Timer that calls a callback every second with the formatted elapsed time.
 */
export class ElapsedTimer {
  private startTime: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private cleanup = () => this.stop();

  constructor(private onTick: (elapsed: string) => void) {
    this.startTime = Date.now();
  }

  start(): this {
    this.startTime = Date.now();
    this.intervalId = setInterval(() => {
      const seconds = Math.floor((Date.now() - this.startTime) / 1000);
      this.onTick(formatDuration(seconds));
    }, 1_000);
    // Prevent the timer from keeping the process alive
    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      this.intervalId.unref();
    }
    process.on('exit', this.cleanup);
    return this;
  }

  getElapsedSeconds(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  stop(): number {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    process.removeListener('exit', this.cleanup);
    return this.getElapsedSeconds();
  }
}
