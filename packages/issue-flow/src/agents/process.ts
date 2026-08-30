import { formatDuration } from '../ui/logger.js';

/**
 * Timeout detection shared by both runners.
 *
 * `reject: false` means execa resolves on a timeout instead of throwing. The
 * wording of the error must keep saying "timed out": `classify()` falls back
 * to that text, and it is what earns the phase its retries.
 */

export interface FinishedProcess {
  exitCode?: number | undefined;
  signal?: string | undefined;
  timedOut?: boolean | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
}

const TIMEOUT_ATTRIBUTION_RATIO = 0.9;

export function reachedTimeout(timeoutMs: number, elapsedMs: number): boolean {
  return timeoutMs > 0 && elapsedMs >= timeoutMs * TIMEOUT_ATTRIBUTION_RATIO;
}

export function wasTimedOut(proc: FinishedProcess, timeoutMs: number, elapsedMs: number): boolean {
  if (proc.timedOut === true) return true;
  if (!reachedTimeout(timeoutMs, elapsedMs)) return false;
  return (
    proc.signal === 'SIGTERM' ||
    proc.signal === 'SIGKILL' ||
    proc.exitCode === 143 ||
    proc.exitCode === 137
  );
}

export function describeAgentFailure(
  proc: FinishedProcess,
  diagnostics: string,
  timeoutMs: number,
  elapsedMs: number,
  command: string,
): string {
  if (wasTimedOut(proc, timeoutMs, elapsedMs)) {
    return `Headless invocation timed out after ${formatDuration(Math.round(timeoutMs / 1000))}. Raise the limit with --timeout <seconds> (0 = no limit).`;
  }
  return diagnostics.trim() || `${command} exited with code ${proc.exitCode ?? 'unknown'}`;
}
