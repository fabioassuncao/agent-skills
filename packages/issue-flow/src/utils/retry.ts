/**
 * Transient failure patterns — matching the Bash script's detection heuristics.
 * These are checked case-insensitively against the combined output.
 */
const TRANSIENT_PATTERNS = [
  'timed out',
  'timeout',
  'connection reset',
  'connection refused',
  'connection aborted',
  'network error',
  'network unavailable',
  'temporary failure',
  'temporarily unavailable',
  'service unavailable',
  'overloaded',
  'rate limit',
  'too many requests',
  'bad gateway',
  'gateway timeout',
  'internal server error',
  'http 429',
  'http 500',
  'http 502',
  'http 503',
  'http 504',
  'econnreset',
  'econnrefused',
  'enotfound',
  'etimedout',
  'socket hang up',
];

/**
 * Determine if a Claude CLI failure is transient (retryable).
 *
 * A failure is considered transient if:
 * - Exit code is 75 (EX_TEMPFAIL)
 * - Output contains known transient error patterns
 */
export function isTransientFailure(exitCode: number, output: string): boolean {
  // Exit code 75 = EX_TEMPFAIL
  if (exitCode === 75) {
    return true;
  }

  const lowered = output.toLowerCase();
  return TRANSIENT_PATTERNS.some((pattern) => lowered.includes(pattern));
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
