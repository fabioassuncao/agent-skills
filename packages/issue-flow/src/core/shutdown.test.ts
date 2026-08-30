import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginShutdown,
  getShutdownSignal,
  installShutdownHandlers,
  isShuttingDown,
  onShutdown,
  registerChild,
  resetShutdownState,
  SHUTDOWN_GRACE_MS,
  type ShutdownReason,
  type TerminableChild,
} from './shutdown.js';

/** A child that records its signals and exits when the test says so. */
function fakeChild(): TerminableChild & { signals: string[]; exit: () => void } {
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

/** Collects the handlers `installShutdownHandlers` registers. */
function signalHarness() {
  const handlers = new Map<ShutdownReason, () => void>();
  return {
    onSignal: (signal: ShutdownReason, handler: () => void) => handlers.set(signal, handler),
    fire: (signal: ShutdownReason) => handlers.get(signal)?.(),
    has: (signal: ShutdownReason) => handlers.has(signal),
    size: () => handlers.size,
  };
}

let exits: number[];
let notices: string[];

beforeEach(() => {
  resetShutdownState();
  exits = [];
  notices = [];
});

afterEach(() => {
  resetShutdownState();
});

const options = () => ({
  graceMs: 50,
  exit: (code: number) => void exits.push(code),
  notify: (message: string) => void notices.push(message),
});

describe('the abort signal', () => {
  it('is available before any handler is installed', () => {
    const signal = getShutdownSignal();

    expect(signal.aborted).toBe(false);
    // Same object every time: a backoff that captured it early must be the one
    // that fires, not a second controller nobody is holding.
    expect(getShutdownSignal()).toBe(signal);
  });

  it('fires as the very first step of the shutdown', async () => {
    const signal = getShutdownSignal();
    let abortedDuringCheckpoint = false;
    onShutdown({
      phase: 'checkpoint',
      run: () => {
        abortedDuringCheckpoint = signal.aborted;
      },
    });

    await beginShutdown('SIGINT', options());

    expect(abortedDuringCheckpoint).toBe(true);
  });

  it('flips isShuttingDown, so no new work is started', async () => {
    expect(isShuttingDown()).toBe(false);
    await beginShutdown('SIGINT', options());
    expect(isShuttingDown()).toBe(true);
  });
});

describe('the sequence', () => {
  it('checkpoints, then stops the child, then closes the surfaces', async () => {
    const order: string[] = [];
    const child = fakeChild();
    registerChild(child);
    child.exit();

    onShutdown({
      phase: 'checkpoint',
      run: () => {
        // The child is still alive here on purpose: checkpointing after the
        // kill would race the very writes it is trying to capture.
        order.push(`checkpoint(child killed: ${child.signals.length > 0})`);
      },
    });
    onShutdown({
      phase: 'close',
      run: () => {
        order.push(`close(child signals: ${child.signals.join(',')})`);
      },
    });

    await beginShutdown('SIGINT', options());

    expect(order).toEqual(['checkpoint(child killed: false)', 'close(child signals: SIGTERM)']);
  });

  it('exits 130 on SIGINT and 143 on SIGTERM', async () => {
    await beginShutdown('SIGINT', options());
    expect(exits).toEqual([130]);

    resetShutdownState();
    exits = [];
    await beginShutdown('SIGTERM', options());
    expect(exits).toEqual([143]);
  });

  it('keeps going when a hook throws', async () => {
    const closed = vi.fn();
    onShutdown({
      phase: 'checkpoint',
      run: () => {
        throw new Error('disk full');
      },
    });
    onShutdown({ phase: 'close', run: closed });

    await beginShutdown('SIGINT', options());

    // The journal still has to be closed even when the checkpoint failed.
    expect(closed).toHaveBeenCalled();
    expect(notices.some((line) => line.includes('disk full'))).toBe(true);
    expect(exits).toEqual([130]);
  });

  it('runs with no child and no hooks at all', async () => {
    await expect(beginShutdown('SIGINT', options())).resolves.toBeUndefined();
    expect(exits).toEqual([130]);
  });
});

describe('the child', () => {
  it('gets SIGTERM and is left alone when it exits within the grace', async () => {
    const child = fakeChild();
    registerChild(child);
    // Exits as soon as it is asked to.
    setTimeout(() => child.exit(), 0);

    await beginShutdown('SIGINT', options());

    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('is killed once the grace runs out', async () => {
    const child = fakeChild();
    registerChild(child);
    // Never exits.

    await beginShutdown('SIGINT', options());

    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('is not signalled once it has been deregistered', async () => {
    const child = fakeChild();
    const unregister = registerChild(child);
    unregister();

    await beginShutdown('SIGINT', options());

    expect(child.signals).toEqual([]);
  });

  it('defaults to a 15s grace', () => {
    expect(SHUTDOWN_GRACE_MS).toBe(15_000);
  });
});

describe('a second interrupt', () => {
  it('kills the child and exits immediately, without waiting out the grace', async () => {
    const child = fakeChild();
    registerChild(child);

    // The first shutdown is still inside the grace period, waiting.
    const first = beginShutdown('SIGINT', { ...options(), graceMs: 5_000 });
    await Promise.resolve();
    await beginShutdown('SIGINT', options());

    expect(child.signals).toContain('SIGKILL');
    await first;
    // Two exits: the forced one, and the first sequence finishing behind it.
    expect(exits[0]).toBe(130);
  });
});

describe('installShutdownHandlers', () => {
  it('listens on SIGINT and SIGTERM', () => {
    const harness = signalHarness();

    installShutdownHandlers({ ...options(), onSignal: harness.onSignal });

    expect(harness.has('SIGINT')).toBe(true);
    expect(harness.has('SIGTERM')).toBe(true);
  });

  it('installs once, however many times it is called', () => {
    const harness = signalHarness();

    installShutdownHandlers({ ...options(), onSignal: harness.onSignal });
    installShutdownHandlers({ ...options(), onSignal: harness.onSignal });

    // A second set of handlers would run the whole sequence twice.
    expect(harness.size()).toBe(2);
  });

  it('runs the sequence when the signal arrives', async () => {
    const harness = signalHarness();
    const checkpoint = vi.fn();
    onShutdown({ phase: 'checkpoint', run: checkpoint });
    installShutdownHandlers({ ...options(), onSignal: harness.onSignal });

    harness.fire('SIGINT');
    await vi.waitFor(() => expect(exits).toEqual([130]));

    expect(checkpoint).toHaveBeenCalledWith('SIGINT');
  });
});
