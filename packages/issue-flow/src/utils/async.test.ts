import { describe, expect, it } from 'vitest';
import { mapWithConcurrency, startSerializedInterval } from './async.js';

/**
 * The five cases below are the upstream `backend/src/__tests__/pr.test.ts`
 * suites for `lib/async.ts`, migrated from `bun:test` to `vitest`. `Bun.sleep`
 * is the only translation: everything else is asserted exactly as upstream.
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('mapWithConcurrency', () => {
  it('maps all items with results in order', async () => {
    const items = [1, 2, 3, 4, 5];
    const result = await mapWithConcurrency(items, 2, async (n) => n * 10);
    expect(result).toEqual([10, 20, 30, 40, 50]);
  });

  it('limits concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const items = [1, 2, 3, 4, 5, 6];
    await mapWithConcurrency(items, 3, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(10);
      active--;
      return n;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('handles empty input', async () => {
    const result = await mapWithConcurrency([], 5, async (n: number) => n);
    expect(result).toEqual([]);
  });
});

describe('startSerializedInterval', () => {
  it('coalesces overlapping ticks into a single rerun', async () => {
    const ticks: Array<() => void> = [];
    const completions: Array<() => void> = [];
    let runs = 0;
    const stop = startSerializedInterval(
      async () => {
        runs += 1;
        await new Promise<void>((resolve) => {
          completions.push(resolve);
        });
      },
      1000,
      {
        scheduleEvery: (handler) => {
          ticks.push(handler);
          return ticks.length;
        },
        cancelSchedule: () => {},
      },
    );

    await Promise.resolve();
    expect(runs).toBe(1);

    ticks[0]?.();
    ticks[0]?.();
    expect(runs).toBe(1);

    completions.shift()?.();
    for (let i = 0; i < 10 && runs < 2; i += 1) {
      await Promise.resolve();
    }
    expect(runs).toBe(2);

    completions.shift()?.();
    await Promise.resolve();
    stop();
  });

  it('stops scheduling reruns after disposal', async () => {
    const ticks: Array<() => void> = [];
    const completions: Array<() => void> = [];
    let runs = 0;
    let cancelledHandle: number | null = null;
    const stop = startSerializedInterval(
      async () => {
        runs += 1;
        await new Promise<void>((resolve) => {
          completions.push(resolve);
        });
      },
      1000,
      {
        scheduleEvery: (handler) => {
          ticks.push(handler);
          return 42;
        },
        cancelSchedule: (handle) => {
          cancelledHandle = handle;
        },
      },
    );

    await Promise.resolve();
    expect(runs).toBe(1);
    ticks[0]?.();
    const stopped = stop();
    completions.shift()?.();
    await stopped;

    expect(cancelledHandle === 42).toBe(true);
    expect(runs).toBe(1);
  });

  it('aborts and awaits an in-flight run before stop resolves', async () => {
    let finished = false;
    const stop = startSerializedInterval(
      async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        finished = true;
      },
      1000,
      { scheduleEvery: () => 7, cancelSchedule: () => {} },
    );

    await Promise.resolve();
    await stop();
    expect(finished).toBe(true);
  });
});
