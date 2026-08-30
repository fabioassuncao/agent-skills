/**
 * The single retry executor of the project.
 *
 * `errors.ts` says *what went wrong*, `policy.ts` says *what to do about it*,
 * and this module is the only place that actually does it: one loop, one
 * backoff, one veto. Before it existed the codebase had two independent retry
 * loops — `core/phase-runner.ts` for single-shot phases and the `execute` loop
 * of `core/engine.ts` — with their own counters, their own delays and no way
 * to keep them in step. Both now delegate here.
 *
 * The loop performs no I/O and knows nothing about phases, sessions or
 * publishers: everything observable is handed back through `onAttempt`, so the
 * caller keeps ownership of its own logging, events and persistence.
 *
 * The invariants of this layer are in `src/resilience/AGENTS.md`.
 */

import { type ClassifiedFailure, requiresHumanAction } from './errors.js';
import { abortableDelay, computeDelayMs, type RetryPolicy, shouldRetry } from './policy.js';

/** What `onAttempt` is told once an attempt has produced a value. */
export interface RetryAttemptInfo<T> {
  /** 1-based number of the attempt that just finished. */
  attempt: number;
  /** Whatever `fn` returned, failure or not. */
  value: T;
  /** `null` when the attempt succeeded. */
  failure: ClassifiedFailure | null;
  /** Whether another attempt follows this one. */
  willRetry: boolean;
  /** The wait before that next attempt; `0` when there is none. */
  delayMs: number;
}

/**
 * A policy chosen from the failure that just happened.
 *
 * The kind is only known *after* an attempt, so a call site that spans several
 * kinds — every `gh` invocation is a network failure, a rate limit or an
 * authentication failure depending on the day — hands over the resolver rather
 * than one frozen policy. `resolvePolicy(failure.kind, config)` is what a
 * caller normally passes.
 */
export type RetryPolicyFor = (failure: ClassifiedFailure) => RetryPolicy;

export interface WithRetryOptions<T> {
  /** One policy, or one chosen per classified failure. */
  policy: RetryPolicy | RetryPolicyFor;
  /**
   * The verdict on one attempt's value: `null` for success, a classified
   * failure otherwise.
   *
   * It belongs to the caller because only the caller knows what a failure
   * looks like in its own return type — an exit code, an `ok: false`, a
   * rejected HTTP response. Callers holding structured evidence should build
   * the failure with `classify()` rather than re-deriving it from text.
   */
  evaluate: (value: T, attempt: number) => ClassifiedFailure | null;
  /** Cuts a pending backoff short; see `abortableDelay`. */
  signal?: AbortSignal;
  /**
   * Called once per attempt, before the backoff, with the decision already
   * taken. This is where a caller publishes its `retry` event, prints, or
   * persists an error — awaited, so those writes finish before the wait.
   */
  onAttempt?: (info: RetryAttemptInfo<T>) => void | Promise<void>;
  /** Injectable RNG for the jitter, so a test can assert the exact curve. */
  random?: () => number;
  /** Injectable wait, so a test never sleeps for real. */
  delay?: (ms: number, options: { signal?: AbortSignal }) => Promise<boolean>;
}

export interface RetryOutcome<T> {
  /** The value of the last attempt — the successful one, or the final failure. */
  value: T;
  /** How many times `fn` ran. */
  attempts: number;
  /** `null` when the last attempt succeeded. */
  failure: ClassifiedFailure | null;
  /** The failure was retryable and the budget ran out. */
  exhausted: boolean;
  /** `signal` fired during a backoff, so the next attempt never happened. */
  aborted: boolean;
}

/**
 * Run `fn` until it succeeds, until the policy's budget is spent, or until
 * `signal` fires.
 *
 * Three separate conditions have to hold for another attempt, and all three
 * are checked here rather than by the caller:
 *
 * 1. the failure is retryable at all (`ClassifiedFailure.retryable`);
 * 2. the kind is not one that needs a human — `task_execution`,
 *    `authentication`, `configuration` and `repository_state` are vetoed
 *    outright, whatever the policy says and even under `retryForever`. This is
 *    the golden rule of `AGENTS.md`, enforced a second time here: a caller can
 *    hand-build a `RetryPolicy` without going through `resolvePolicy()`, so
 *    the clamp there is not on its own enough;
 * 3. the policy still has budget (`shouldRetry`).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: WithRetryOptions<T>,
): Promise<RetryOutcome<T>> {
  const { policy, evaluate, signal, onAttempt, random } = options;
  const delay = options.delay ?? abortableDelay;
  const policyFor: RetryPolicyFor = typeof policy === 'function' ? policy : () => policy;

  for (let attempt = 1; ; attempt++) {
    const value = await fn(attempt);
    const failure = evaluate(value, attempt);

    if (failure === null) {
      await onAttempt?.({ attempt, value, failure, willRetry: false, delayMs: 0 });
      return { value, attempts: attempt, failure: null, exhausted: false, aborted: false };
    }

    const active = policyFor(failure);
    const eligible = failure.retryable && !requiresHumanAction(failure.kind);
    const willRetry = eligible && shouldRetry(active, attempt);
    const delayMs = willRetry
      ? computeDelayMs(active, attempt, { random, retryAfterMs: failure.retryAfterMs })
      : 0;

    await onAttempt?.({ attempt, value, failure, willRetry, delayMs });

    if (!willRetry) {
      return { value, attempts: attempt, failure, exhausted: eligible, aborted: false };
    }

    if (!(await delay(delayMs, { signal }))) {
      return { value, attempts: attempt, failure, exhausted: false, aborted: true };
    }
  }
}

/**
 * A fixed policy in the shape the two legacy call sites express their settings
 * in: a number of attempts and a base/max delay in seconds.
 *
 * Deliberately un-jittered. Both call sites have always used a bare
 * `base * 2^(n-1)` and both publish that number in a `retry` event and print
 * it; adding jitter here would change today's behaviour with no configuration
 * asking for it. Jitter arrives with the `resilience` key that configures it.
 */
export function fixedBackoffPolicy(
  maxAttempts: number,
  baseSeconds: number,
  maxSeconds: number,
  overrides: Partial<RetryPolicy> = {},
): RetryPolicy {
  return {
    maxAttempts,
    initialDelayMs: baseSeconds * 1000,
    maxDelayMs: maxSeconds * 1000,
    backoffFactor: 2,
    jitter: 'none',
    retryForever: false,
    failover: 'never',
    failoverAfterAttempts: 2,
    onExhausted: 'fail',
    ...overrides,
  };
}
