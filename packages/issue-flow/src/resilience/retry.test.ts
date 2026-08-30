import { describe, expect, it, vi } from 'vitest';
import type { ClassifiedFailure, FailureKind } from './errors.js';
import type { RetryPolicy } from './policy.js';
import { fixedBackoffPolicy, type RetryAttemptInfo, withRetry } from './retry.js';

/** A failure of `kind`, retryable unless the kind or the caller says otherwise. */
function failure(kind: FailureKind, overrides: Partial<ClassifiedFailure> = {}): ClassifiedFailure {
  return { kind, message: `${kind} failure`, retryable: true, source: 'agent', ...overrides };
}

/** A policy with generous budget and a flat, un-jittered 10ms delay. */
function fastPolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return fixedBackoffPolicy(5, 0.01, 0.01, overrides);
}

/** Never actually waits; records what it was asked to wait for. */
function fakeDelay(): { waits: number[]; delay: (ms: number) => Promise<boolean> } {
  const waits: number[] = [];
  return {
    waits,
    delay: async (ms: number) => {
      waits.push(ms);
      return true;
    },
  };
}

describe('withRetry', () => {
  it('runs once and returns the value when the first attempt succeeds', async () => {
    const fn = vi.fn(async () => 'ok');

    const outcome = await withRetry(fn, { policy: fastPolicy(), evaluate: () => null });

    expect(outcome).toMatchObject({ value: 'ok', attempts: 1, failure: null, exhausted: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure and returns the later success', async () => {
    const fn = vi.fn(async (attempt: number) => attempt);
    const { delay, waits } = fakeDelay();

    const outcome = await withRetry(fn, {
      policy: fastPolicy(),
      delay,
      evaluate: (attempt) => (attempt < 3 ? failure('network') : null),
    });

    expect(outcome.attempts).toBe(3);
    expect(outcome.failure).toBeNull();
    expect(waits).toEqual([10, 10]);
  });

  it('gives up on the first non-retryable failure', async () => {
    const fn = vi.fn(async () => 'boom');
    const { delay, waits } = fakeDelay();

    const outcome = await withRetry(fn, {
      policy: fastPolicy(),
      delay,
      evaluate: () => failure('internal', { retryable: false }),
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(outcome.exhausted).toBe(false);
    expect(outcome.failure?.kind).toBe('internal');
    expect(waits).toEqual([]);
  });

  it('reports the budget as exhausted after the last allowed attempt', async () => {
    const fn = vi.fn(async () => 'down');
    const { delay } = fakeDelay();

    const outcome = await withRetry(fn, {
      policy: fixedBackoffPolicy(3, 0.01, 0.01),
      delay,
      evaluate: () => failure('provider_down'),
    });

    expect(fn).toHaveBeenCalledTimes(3);
    expect(outcome.exhausted).toBe(true);
    expect(outcome.failure?.kind).toBe('provider_down');
  });

  /* ── the golden rule ──────────────────────────────────────────────────── */

  it('never retries task_execution, even with retryForever and an unbounded budget', async () => {
    const fn = vi.fn(async () => 'tests failed');
    const { delay, waits } = fakeDelay();

    const outcome = await withRetry(fn, {
      // A hand-built policy that bypasses `resolvePolicy()`'s clamp entirely:
      // the veto has to live in the executor too, and this is what proves it.
      policy: fixedBackoffPolicy(1000, 0.01, 0.01, { retryForever: true }),
      delay,
      evaluate: () => failure('task_execution', { retryable: true }),
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    expect(outcome).toMatchObject({ attempts: 1, exhausted: false, aborted: false });
  });

  it.each<FailureKind>([
    'authentication',
    'configuration',
    'repository_state',
  ])('never retries %s, whatever the policy says', async (kind) => {
    const fn = vi.fn(async () => 'blocked');

    const outcome = await withRetry(fn, {
      policy: fixedBackoffPolicy(1000, 0.01, 0.01, { retryForever: true }),
      delay: fakeDelay().delay,
      evaluate: () => failure(kind, { retryable: true }),
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(outcome.exhausted).toBe(false);
  });

  /* ── the backoff ──────────────────────────────────────────────────────── */

  it('doubles the delay from the base up to the ceiling', async () => {
    const { delay, waits } = fakeDelay();

    await withRetry(async () => 'down', {
      policy: fixedBackoffPolicy(6, 30, 900),
      delay,
      evaluate: () => failure('provider_down'),
    });

    // 30s, 60s, 120s, 240s, 480s — the curve `retryDelaySeconds()` produced.
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
  });

  it('draws the jittered delay from the injected RNG', async () => {
    const { delay, waits } = fakeDelay();

    await withRetry(async () => 'down', {
      policy: fixedBackoffPolicy(3, 10, 100, { jitter: 'full' }),
      delay,
      random: () => 0.5,
      evaluate: () => failure('network'),
    });

    expect(waits).toEqual([5_000, 10_000]);
  });

  it("honours a server's Retry-After over the computed backoff", async () => {
    const { delay, waits } = fakeDelay();

    await withRetry(async () => 'limited', {
      policy: fixedBackoffPolicy(2, 60, 900),
      delay,
      evaluate: () => failure('rate_limit', { retryAfterMs: 7_000 }),
    });

    expect(waits).toEqual([7_000]);
  });

  /* ── abort ────────────────────────────────────────────────────────────── */

  it('stops without a further attempt when the signal cuts the backoff short', async () => {
    const fn = vi.fn(async () => 'down');

    const outcome = await withRetry(fn, {
      policy: fastPolicy(),
      delay: async () => false,
      evaluate: () => failure('network'),
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ aborted: true, exhausted: false });
    expect(outcome.failure?.kind).toBe('network');
  });

  it('hands the abort signal to the delay', async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];

    await withRetry(async () => 'down', {
      policy: fixedBackoffPolicy(2, 0.01, 0.01),
      signal: controller.signal,
      delay: async (_ms, options) => {
        seen.push(options.signal);
        return true;
      },
      evaluate: () => failure('network'),
    });

    expect(seen).toEqual([controller.signal]);
  });

  /* ── onAttempt ────────────────────────────────────────────────────────── */

  it('reports every attempt, with the decision already taken', async () => {
    const seen: RetryAttemptInfo<string>[] = [];

    await withRetry(async (attempt) => (attempt < 3 ? 'down' : 'ok'), {
      policy: fixedBackoffPolicy(4, 0.01, 0.01),
      delay: fakeDelay().delay,
      evaluate: (value) => (value === 'ok' ? null : failure('network')),
      onAttempt: (info) => {
        seen.push(info);
      },
    });

    expect(seen.map((info) => [info.attempt, info.willRetry, info.delayMs])).toEqual([
      [1, true, 10],
      [2, true, 10],
      [3, false, 0],
    ]);
    expect(seen[2].failure).toBeNull();
  });

  it('awaits onAttempt before backing off', async () => {
    const order: string[] = [];

    await withRetry(async () => 'down', {
      policy: fixedBackoffPolicy(2, 0.01, 0.01),
      delay: async () => {
        order.push('delay');
        return true;
      },
      evaluate: () => failure('network'),
      onAttempt: async () => {
        await Promise.resolve();
        order.push('onAttempt');
      },
    });

    expect(order).toEqual(['onAttempt', 'delay', 'onAttempt']);
  });
});

describe('fixedBackoffPolicy', () => {
  it("is the single-shot phases' historical policy: 3 attempts, 15s doubling to 120s", () => {
    expect(fixedBackoffPolicy(3, 15, 120)).toEqual({
      maxAttempts: 3,
      initialDelayMs: 15_000,
      maxDelayMs: 120_000,
      backoffFactor: 2,
      jitter: 'none',
      retryForever: false,
      failover: 'never',
      failoverAfterAttempts: 2,
      onExhausted: 'fail',
    });
  });

  it("is the execute loop's historical policy: retryLimit 10 means 11 attempts, 30s to 900s", () => {
    expect(fixedBackoffPolicy(10 + 1, 30, 900)).toMatchObject({
      maxAttempts: 11,
      initialDelayMs: 30_000,
      maxDelayMs: 900_000,
      jitter: 'none',
    });
  });
});
