import { readFile } from 'node:fs/promises';
import { printRetry } from '../ui/logger.js';
import { retryDelaySeconds, sleep } from '../utils/retry.js';
import { getSessionPublisher } from './session-publisher.js';
import { isoNow } from './state-manager.js';

export interface PhaseAttemptResult {
  ok: boolean;
  /** Whether a failed attempt is worth retrying. Ignored when ok is true. */
  transient?: boolean;
  error?: string;
}

export interface PhaseRetryOptions {
  phase: string;
  attempt: (attemptNumber: number) => Promise<PhaseAttemptResult>;
  retryLimit?: number;
  backoffBaseSeconds?: number;
  backoffMaxSeconds?: number;
}

const DEFAULT_PHASE_RETRY_LIMIT = 3;
const DEFAULT_BACKOFF_BASE_SECONDS = 15;
const DEFAULT_BACKOFF_MAX_SECONDS = 120;

/**
 * Bounded retry wrapper for single-shot phases (prd, plan, pr) that invoke
 * the Claude CLI once and validate an artifact. Mirrors the transient-retry
 * pattern already used by the execute phase's iteration loop (core/engine.ts:
 * isTransientFailure + retryDelaySeconds), applied here to phases that
 * previously aborted the whole pipeline on the first failure with no chance
 * to recover. Non-transient failures (or exhausting the retry budget) still
 * end the phase — this bounds recovery attempts, it never retries forever.
 */
export async function runPhaseWithRetry(options: PhaseRetryOptions): Promise<PhaseAttemptResult> {
  const retryLimit = options.retryLimit ?? DEFAULT_PHASE_RETRY_LIMIT;
  const backoffBaseSeconds = options.backoffBaseSeconds ?? DEFAULT_BACKOFF_BASE_SECONDS;
  const backoffMaxSeconds = options.backoffMaxSeconds ?? DEFAULT_BACKOFF_MAX_SECONDS;

  let lastResult: PhaseAttemptResult = { ok: false, error: 'Phase never attempted' };
  let retryCount = 0;

  for (let attemptNumber = 1; attemptNumber <= retryLimit; attemptNumber++) {
    lastResult = await options.attempt(attemptNumber);
    if (lastResult.ok) return lastResult;
    if (!lastResult.transient || attemptNumber === retryLimit) return lastResult;

    retryCount++;
    const delaySeconds = retryDelaySeconds(retryCount, backoffBaseSeconds, backoffMaxSeconds);
    getSessionPublisher().publish({
      type: 'retry',
      at: isoNow(),
      attempt: retryCount,
      delaySeconds,
      reason: lastResult.error,
    });
    printRetry(
      `Phase ${options.phase} hit a recoverable failure (attempt ${attemptNumber}/${retryLimit}): ${lastResult.error}. Retrying in ${delaySeconds}s.`,
    );
    await sleep(delaySeconds);
  }

  return lastResult;
}

/**
 * Re-read a file a few times with short delays before giving up. Absorbs a
 * brief filesystem-visibility lag between the Claude CLI's Write tool
 * completing and this process observing the result, without spending a full
 * phase retry (and a new Claude invocation) on what may just be a timing gap.
 */
export async function readFileWithGrace(
  path: string,
  delaysMs: number[] = [300, 800],
): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await readFile(path, 'utf-8');
    } catch (err) {
      if (i >= delaysMs.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[i]));
    }
  }
}
