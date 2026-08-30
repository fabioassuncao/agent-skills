import { classify } from '../resilience/errors.js';

/**
 * Determine if an agent invocation failure is transient (retryable).
 *
 * This is a thin adapter over `resilience/errors.ts:classify()` — the taxonomy
 * is the single source of truth, and this signature survives only because
 * `core/engine.ts` and the phase commands are written against it. A caller
 * that has more evidence than an exit code and a blob of text (an `errno`, an
 * HTTP status, `timedOut`) should call `classify()` directly and keep it.
 */
export function isTransientFailure(exitCode: number, output: string): boolean {
  return classify({ source: 'agent', exitCode, stdout: output }).retryable;
}

/**
 * Calculate retry delay using exponential backoff.
 *
 * delay = baseSeconds * 2^(attempt-1), capped at maxSeconds
 *
 * @param attempt - The retry attempt number (1-based)
 * @param baseSeconds - Base delay in seconds (default: 30)
 * @param maxSeconds - Maximum delay in seconds (default: 900)
 */
export function retryDelaySeconds(
  attempt: number,
  baseSeconds: number = 30,
  maxSeconds: number = 900,
): number {
  const delay = baseSeconds * 2 ** (attempt - 1);
  return Math.min(delay, maxSeconds);
}

/**
 * Sleep for a given number of seconds.
 */
export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
