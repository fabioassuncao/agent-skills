import { readFile } from 'node:fs/promises';
import { type ClassifiedFailure, classify } from '../resilience/errors.js';
import { fixedBackoffPolicy, withRetry } from '../resilience/retry.js';
import { printRetry } from '../ui/logger.js';
import { getSessionPublisher } from './session-publisher.js';
import { getShutdownSignal } from './shutdown.js';
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
  /** Cuts a pending backoff short, so a phase stops waiting on shutdown. */
  signal?: AbortSignal;
}

const DEFAULT_PHASE_RETRY_LIMIT = 3;
const DEFAULT_BACKOFF_BASE_SECONDS = 15;
const DEFAULT_BACKOFF_MAX_SECONDS = 120;

/**
 * Bounded retry wrapper for single-shot phases (prd, plan, pr) that invoke
 * the Claude CLI once and validate an artifact. Applied to phases that
 * previously aborted the whole pipeline on the first failure with no chance
 * to recover. Non-transient failures (or exhausting the retry budget) still
 * end the phase — this bounds recovery attempts, it never retries forever.
 *
 * The loop itself is `resilience/retry.ts:withRetry`, shared with the
 * `execute` loop of `core/engine.ts`. What stays here is what is specific to a
 * phase: the caller's `transient` verdict, the `retry` event and the printed
 * line. With no options supplied the effective numbers are the ones this
 * module has always used — 3 attempts, 15s doubling to 120s, no jitter.
 */
export async function runPhaseWithRetry(options: PhaseRetryOptions): Promise<PhaseAttemptResult> {
  const retryLimit = options.retryLimit ?? DEFAULT_PHASE_RETRY_LIMIT;
  const backoffBaseSeconds = options.backoffBaseSeconds ?? DEFAULT_BACKOFF_BASE_SECONDS;
  const backoffMaxSeconds = options.backoffMaxSeconds ?? DEFAULT_BACKOFF_MAX_SECONDS;

  if (retryLimit < 1) return { ok: false, error: 'Phase never attempted' };

  const outcome = await withRetry<PhaseAttemptResult>((attempt) => options.attempt(attempt), {
    policy: fixedBackoffPolicy(retryLimit, backoffBaseSeconds, backoffMaxSeconds),
    // The caller's own signal when it has one, and the process-wide shutdown
    // otherwise: a backoff nobody can interrupt is a `Ctrl+C` that appears to
    // do nothing for two minutes.
    signal: options.signal ?? getShutdownSignal(),
    evaluate: (result) => (result.ok ? null : phaseFailure(result)),
    onAttempt: ({ attempt, failure, willRetry, delayMs }) => {
      if (failure === null || !willRetry) return;

      const delaySeconds = delayMs / 1000;
      getSessionPublisher().publish({
        type: 'retry',
        at: isoNow(),
        attempt,
        delaySeconds,
        reason: failure.message,
        kind: failure.kind,
      });
      printRetry(
        `Phase ${options.phase} hit a recoverable failure (attempt ${attempt}/${retryLimit}): ${failure.message}. Retrying in ${delaySeconds}s.`,
      );
    },
  });

  return outcome.value;
}

/**
 * Turn a phase's own verdict into the classified failure `withRetry` decides
 * on.
 *
 * `transient` stays authoritative: the phases build it with
 * `isTransientFailure()` over the CLI's output, but a phase can also fail on
 * something it alone can see — a PRD file that never appeared — and that
 * judgement is not recoverable from the error text. `classify()` is consulted
 * only to name the *kind*, which is what the `retry` event now reports.
 */
function phaseFailure(result: PhaseAttemptResult): ClassifiedFailure {
  const message = result.error ?? 'Phase failed';
  return {
    ...classify({ source: 'agent', stdout: message }),
    message,
    retryable: result.transient === true,
  };
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
