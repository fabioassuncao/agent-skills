/**
 * The one question the watchdog asks about human takeover.
 *
 * Deliberately a module of its own, with no imports: `core/watchdog.ts` is
 * dependency-light on purpose, and reaching storage from it — even
 * transitively — would put a database read behind a timer that exists to be
 * cheap. `core/human-hold.ts` knows about storage and installs the answer here.
 *
 * No gate installed means "nobody is holding anything", which is the behaviour
 * every release before human takeover had.
 */

let gate: (() => boolean) | null = null;

/** Install the answer, or pass `null` to remove it. */
export function installHumanHoldGate(next: (() => boolean) | null): void {
  gate = next;
}

/** Whether the run in this process is currently held by a person. */
export function isCurrentRunHeld(): boolean {
  try {
    return gate?.() === true;
  } catch {
    // A gate that throws must not freeze a run, and must not kill one either:
    // "not held" is the state everything behaved as before this existed.
    return false;
  }
}
