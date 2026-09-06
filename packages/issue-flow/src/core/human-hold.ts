import type { PlanRepositoryContext } from '../storage/db/repository.js';
import { loadRunHumanHold, saveRunHumanHold } from '../storage/db/repository.js';
import { installHumanHoldGate } from './hold-gate.js';
import { getSessionPublisher } from './session-publisher.js';

/**
 * A person took over. Everything automatic steps back.
 *
 * Absorbed from WebMux's `disarmOneshotIfArmed` (`backend/src/server.ts:2231`),
 * whose mechanism §32 of the absorption plan calls elegant and tiny, and it is:
 * there is no state machine, no confirmation and no mode switch. **A human
 * touching the keyboard is the signal.** Any input arriving on the terminal
 * socket disarms the autonomous run.
 *
 * What is added on top is the typing §32 asks for, and one rule that is not
 * negotiable:
 *
 * > While a run is held, the watchdog does not kill the process and the
 * > pipeline does not advance a phase.
 *
 * Without it the watchdog would kill the session at exactly the moment the
 * human is thinking about what to type — the run looks silent because a person
 * is reading it.
 *
 * The hold lives in SQLite rather than in memory for two reasons. It is
 * **intent**, which is what the database is the authority over (ADR-08); and it
 * has to cross a process boundary, because the person types in the monitor
 * while the watchdog runs in the pipeline.
 */

export type HumanHoldReason =
  /** The person typed into the agent's terminal. No confirmation is asked for. */
  | 'takeover'
  /** Asked for explicitly, before touching anything. */
  | 'requested';

export interface HumanHold {
  runId: string;
  since: string;
  reason: HumanHoldReason;
}

/**
 * How long a cached answer is trusted.
 *
 * The watchdog asks on every tick — as often as every 250 ms — and the answer
 * changes at human speed. A second of staleness costs nothing and keeps a
 * database read off a timer that exists to be cheap.
 */
export const HUMAN_HOLD_CACHE_MS = 1000;

interface CacheEntry {
  value: HumanHold | null;
  readAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: the cache is process-wide and would leak between cases. */
export function resetHumanHoldCache(): void {
  cache.clear();
}

/**
 * Take over a run.
 *
 * Idempotent by design: a person typing produces one of these per keystroke
 * burst, and every one after the first must not move the timestamp — how long
 * the human has been in control is exactly what the escalation logic reads.
 */
export async function holdForHuman(
  context: PlanRepositoryContext,
  input: { runId: string; reason: HumanHoldReason; now?: () => Date },
): Promise<HumanHold> {
  const existing = await loadRunHumanHold(context, input.runId);
  if (existing !== null) {
    cache.set(input.runId, { value: existing, readAt: Date.now() });
    return existing;
  }

  const hold: HumanHold = {
    runId: input.runId,
    since: (input.now ?? (() => new Date()))().toISOString(),
    reason: input.reason,
  };
  await saveRunHumanHold(context, hold.runId, { since: hold.since, reason: hold.reason });
  cache.set(input.runId, { value: hold, readAt: Date.now() });
  return hold;
}

/**
 * Give control back.
 *
 * Only ever explicit. Nothing infers that a person is done — a run that resumed
 * itself because the terminal went quiet would be the same bug the hold exists
 * to prevent, with extra steps.
 */
export async function releaseHumanHold(
  context: PlanRepositoryContext,
  runId: string,
): Promise<void> {
  await saveRunHumanHold(context, runId, null);
  cache.set(runId, { value: null, readAt: Date.now() });
}

/** The current hold, read through the cache. */
export async function currentHumanHold(
  context: PlanRepositoryContext,
  runId: string,
): Promise<HumanHold | null> {
  const entry = cache.get(runId);
  if (entry !== undefined && Date.now() - entry.readAt < HUMAN_HOLD_CACHE_MS) return entry.value;

  let value: HumanHold | null = null;
  try {
    value = await loadRunHumanHold(context, runId);
  } catch {
    // A storage failure must not be read as "a human is holding this": that
    // would freeze a run for a reason nobody asked for. Absent is the safe
    // answer, and it is also the answer for every run nobody ever held.
    value = entry?.value ?? null;
  }
  cache.set(runId, { value, readAt: Date.now() });
  return value;
}

export async function isHeldForHuman(
  context: PlanRepositoryContext,
  runId: string,
): Promise<boolean> {
  return (await currentHumanHold(context, runId)) !== null;
}

/**
 * How long a run has waited for the person who took it over.
 *
 * `null` when it is not held. §32 wants an unanswered hold to escalate rather
 * than to sit forever, and this is the number that decision reads.
 */
export function heldForMs(
  hold: HumanHold | null,
  now: () => Date = () => new Date(),
): number | null {
  if (hold === null) return null;
  const since = Date.parse(hold.since);
  if (Number.isNaN(since)) return null;
  return Math.max(0, now().getTime() - since);
}

export interface HumanHoldWatch {
  /** Whether the run is currently held. Answers from the refreshed value. */
  held(): boolean;
  stop(): void;
}

/**
 * Keep the process-wide gate answering for one run.
 *
 * The refresh is a timer rather than a read-on-demand because the watchdog asks
 * synchronously and cannot await. The interval is unref'd, so it never keeps
 * the process alive past the run it belongs to.
 */
export function startHumanHoldWatch(
  context: PlanRepositoryContext,
  runId: string,
  intervalMs: number = HUMAN_HOLD_CACHE_MS,
): HumanHoldWatch {
  let held = false;
  let stopped = false;

  const refresh = async (): Promise<void> => {
    if (stopped) return;
    const hold = await currentHumanHold(context, runId);
    const next = hold !== null;
    if (next !== held) {
      held = next;
      // Published from here rather than from whoever flipped the flag: the
      // takeover happens in the monitor and the release in the CLI, and neither
      // owns this run's snapshot. Observing the transition is what keeps the
      // snapshot true regardless of which process caused it.
      const publisher = getSessionPublisher();
      if (hold === null) {
        publisher.publish({ type: 'human:resume', at: new Date().toISOString() });
      } else {
        publisher.publish({ type: 'human:hold', at: hold.since, reason: hold.reason });
      }
    }
  };
  void refresh();

  const timer = setInterval(() => void refresh(), intervalMs);
  timer.unref?.();
  installHumanHoldGate(() => held);

  return {
    held: () => held,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      installHumanHoldGate(null);
    },
  };
}
