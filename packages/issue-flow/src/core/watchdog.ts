import { isCurrentRunHeld } from './hold-gate.js';
import { SHUTDOWN_GRACE_MS, type TerminableChild } from './shutdown.js';

/**
 * Inactivity watchdog: telling a long task from a stuck one.
 *
 * The pipeline had exactly one instrument for a hung agent — the absolute
 * timeout — and it cannot tell the difference between a phase that has been
 * working hard for fourteen minutes and a phase that has produced nothing for
 * fourteen minutes. The execute loop did not even have that: it runs with
 * `timeout: 0` by design, because its budget is iterations rather than seconds,
 * so a `claude` that hangs without printing anything hangs forever.
 *
 * What separates the two cases is *output*. An agent that is working emits
 * events continuously; one that is stuck emits nothing. So the watchdog watches
 * the stream, not the clock: every event is a heartbeat, and only the **absence**
 * of heartbeats for longer than the limit is a stall.
 *
 * The absolute timeout stays exactly where it was. This is a second, tighter
 * instrument, not a replacement: the ceiling still bounds a task that keeps
 * talking and never finishes.
 */

/** Default silence before a child is considered stuck. */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 600_000;

export interface WatchdogOptions {
  /** Silence tolerated before the child is stopped. `0` disables the watchdog. */
  inactivityTimeoutMs?: number;
  /** The process to stop. Omitted for a watchdog that only reports. */
  child?: TerminableChild;
  /** Grace between `SIGTERM` and `SIGKILL`. Defaults to the shutdown's. */
  graceMs?: number;
  /** Called once, when the silence limit is crossed. */
  onStall?: (silentMs: number) => void;
  /**
   * Whether a person has taken the run over (§32).
   *
   * While this answers true the watchdog treats the silence as expected and
   * never declares a stall — the run is quiet because somebody is reading it,
   * and killing the agent at exactly that moment is the failure this exists to
   * prevent. Absent means "nobody is holding anything", which is the behaviour
   * every release before human takeover had.
   *
   * Synchronous on purpose: it is consulted on a timer that runs as often as
   * every 250 ms, so the caller is expected to answer from a cache rather than
   * from storage (`core/human-hold.ts` does exactly that).
   *
   * Defaults to the process-wide gate, which answers false until a run installs
   * one — so a watchdog built by any of the five runners gets this for free
   * without any of them having to thread it through.
   */
  isHeldByHuman?: () => boolean;
  /** Injectable clock, so a test drives the silence without waiting for it. */
  clock?: () => number;
  /** Injectable timer factory, so a test can use fake timers deliberately. */
  setInterval?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
}

export interface Watchdog {
  /** Record a sign of life. Called once per event of the stream. */
  beat(): void;
  /** Whether the watchdog decided the child was stuck. */
  readonly stalled: boolean;
  /** How long the child had been silent when it was judged. */
  readonly silentMs: number;
  /** Stop watching. Idempotent; always call it when the child finishes. */
  stop(): void;
}

/** How often the silence is measured, as a fraction of the limit. */
const CHECK_DIVISOR = 10;
const MIN_CHECK_MS = 250;
const MAX_CHECK_MS = 5_000;

function checkIntervalFor(timeoutMs: number): number {
  return Math.min(MAX_CHECK_MS, Math.max(MIN_CHECK_MS, Math.floor(timeoutMs / CHECK_DIVISOR)));
}

/**
 * Watch a stream for silence and stop the child when it goes quiet.
 *
 * `inactivityTimeoutMs: 0` returns an inert watchdog: `beat()` is a no-op and
 * nothing is ever killed. That is the documented "off" switch, and it is what
 * keeps this feature opt-out without a second code path anywhere else.
 */
export function createWatchdog(options: WatchdogOptions = {}): Watchdog {
  const timeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  const clock = options.clock ?? Date.now;
  const start = options.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const clear = options.clearInterval ?? ((timer) => clearInterval(timer));

  const state = { stalled: false, silentMs: 0 };

  if (timeoutMs <= 0) {
    return {
      beat: () => {},
      stop: () => {},
      get stalled() {
        return state.stalled;
      },
      get silentMs() {
        return state.silentMs;
      },
    };
  }

  let lastBeat = clock();
  let timer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;

  const stop = (): void => {
    if (timer !== null) {
      clear(timer);
      timer = null;
    }
    if (killTimer !== null) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  };

  const declareStalled = (): void => {
    state.stalled = true;
    state.silentMs = clock() - lastBeat;
    stop();
    options.onStall?.(state.silentMs);

    const child = options.child;
    if (child === undefined) return;

    // The same courtesy the shutdown extends: ask first, insist after. An agent
    // killed outright mid-write leaves a half-written file behind.
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.graceMs ?? SHUTDOWN_GRACE_MS);
    killTimer.unref?.();
    void child.done.then(
      () => {
        if (killTimer !== null) {
          clearTimeout(killTimer);
          killTimer = null;
        }
      },
      () => {},
    );
  };

  timer = start(() => {
    if (state.stalled) return;
    if ((options.isHeldByHuman ?? isCurrentRunHeld)() === true) {
      // Held: the clock is reset rather than merely not checked, so releasing
      // the hold gives the agent the full silence budget again instead of
      // killing it for the minutes a person spent thinking.
      lastBeat = clock();
      return;
    }
    if (clock() - lastBeat > timeoutMs) declareStalled();
  }, checkIntervalFor(timeoutMs));
  timer.unref?.();

  return {
    beat: () => {
      lastBeat = clock();
    },
    stop,
    get stalled() {
      return state.stalled;
    },
    get silentMs() {
      return state.silentMs;
    },
  };
}

/**
 * The message a stalled invocation reports.
 *
 * The wording is a contract, exactly like the timeout's: `classify()` reads it
 * as a last resort, and `stalled` has to survive the trip through a plain
 * string so the phase gets its retries.
 */
export function describeStall(silentMs: number, provider = 'claude'): string {
  return `${provider} produced no output for ${Math.round(silentMs / 1000)}s and was stopped (stalled)`;
}
