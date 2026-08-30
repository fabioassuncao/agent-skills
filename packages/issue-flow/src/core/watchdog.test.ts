import { describe, expect, it, vi } from 'vitest';
import { classify } from '../resilience/errors.js';
import {
  createWatchdog,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
  describeStall,
  type Watchdog,
} from './watchdog.js';

/** A child that records the signals it received and never exits on its own. */
function fakeChild() {
  const signals: string[] = [];
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    signals,
    exit: () => settle(),
    kill: (signal?: NodeJS.Signals) => {
      signals.push(signal ?? 'SIGTERM');
      return true;
    },
    done,
  };
}

/**
 * A hand-driven clock and timer, so silence is produced by advancing a number
 * rather than by waiting. The watchdog's decision is the assertion; the wall
 * clock is not part of it.
 */
function harness() {
  let now = 0;
  const ticks: (() => void)[] = [];
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const tick of [...ticks]) tick();
    },
    options: {
      clock: () => now,
      setInterval: ((handler: () => void) => {
        ticks.push(handler);
        return { unref: () => {} } as unknown as NodeJS.Timeout;
      }) as never,
      clearInterval: (() => {
        ticks.length = 0;
      }) as never,
    },
  };
}

describe('createWatchdog', () => {
  it('says nothing while the stream keeps beating', () => {
    const clock = harness();
    const watchdog = createWatchdog({
      inactivityTimeoutMs: 100,
      ...clock.options,
    });

    for (let i = 0; i < 10; i++) {
      clock.advance(50);
      watchdog.beat();
    }

    // Half a second of work, never more than 50ms of silence.
    expect(watchdog.stalled).toBe(false);
  });

  it('declares a stall once the silence passes the limit', () => {
    const clock = harness();
    const onStall = vi.fn();
    const watchdog = createWatchdog({ inactivityTimeoutMs: 100, onStall, ...clock.options });

    clock.advance(100);
    expect(watchdog.stalled).toBe(false);

    clock.advance(1);
    expect(watchdog.stalled).toBe(true);
    expect(watchdog.silentMs).toBe(101);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('stops the child with SIGTERM, then SIGKILL after the grace', async () => {
    vi.useFakeTimers();
    try {
      const clock = harness();
      const child = fakeChild();
      const watchdog = createWatchdog({
        inactivityTimeoutMs: 100,
        graceMs: 500,
        child,
        ...clock.options,
      });

      clock.advance(200);
      expect(watchdog.stalled).toBe(true);
      // Asked first: an agent killed outright mid-write leaves half a file.
      expect(child.signals).toEqual(['SIGTERM']);

      await vi.advanceTimersByTimeAsync(600);
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not kill a child that exits during the grace', async () => {
    vi.useFakeTimers();
    try {
      const clock = harness();
      const child = fakeChild();
      createWatchdog({ inactivityTimeoutMs: 100, graceMs: 500, child, ...clock.options });

      clock.advance(200);
      child.exit();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(600);

      expect(child.signals).toEqual(['SIGTERM']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is inert at 0, which is the documented off switch', () => {
    const clock = harness();
    const child = fakeChild();
    const watchdog: Watchdog = createWatchdog({
      inactivityTimeoutMs: 0,
      child,
      ...clock.options,
    });

    clock.advance(1_000_000);
    watchdog.beat();

    expect(watchdog.stalled).toBe(false);
    expect(child.signals).toEqual([]);
  });

  it('decides only once, however long the silence lasts', () => {
    const clock = harness();
    const onStall = vi.fn();
    createWatchdog({ inactivityTimeoutMs: 100, onStall, ...clock.options });

    clock.advance(500);
    clock.advance(500);

    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('defaults to ten minutes', () => {
    expect(DEFAULT_INACTIVITY_TIMEOUT_MS).toBe(600_000);
  });
});

describe('describeStall', () => {
  it('is worded so the classifier reads it as stalled, not as a plain timeout', () => {
    const message = describeStall(600_000);

    expect(message).toContain('produced no output for 600s');
    // The contract: the wording is what carries the kind through a plain
    // string, which is all a phase's failure ever is by the time it is read.
    const failure = classify({ source: 'agent', exitCode: 143, stderr: message });
    expect(failure.kind).toBe('stalled');
    expect(failure.retryable).toBe(true);
  });
});
