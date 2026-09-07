import { writeDiagnostic } from '../storage/diagnostics.js';
import type { SessionPublisher } from './session/publishers.js';
import type { SessionSnapshot } from './session/snapshot.js';

/**
 * Nobody answered the agent. The last row of §32's table.
 *
 * §32 asks for "`awaiting_input` sem resposta por N minutos → notificação +
 * escalada". Two things decide whether this is implemented correctly, and both
 * are easy to get wrong:
 *
 * **1. This is not a human hold.** `core/human-hold.ts` measures how long
 * somebody has been *in control* of a run — they took it over and are reading.
 * This measures the opposite: the agent asked a question and **nobody came**.
 * Folding the two together would escalate in the middle of a legitimate
 * takeover, which is exactly the failure the hold exists to prevent. So an
 * escalation is suppressed for as long as a hold exists, and `heldForMs` is
 * never consulted here.
 *
 * **2. The policy is the pipeline's, not the dashboard's** (ADR-03). A run with
 * no interface at all — the default — that blocks waiting for input has to
 * escalate anyway; if the threshold lived in the browser, the only runs that
 * escalated would be the ones somebody was already watching, which is the case
 * that needs it least. So the decision is taken here, in the process that runs
 * the agent, and the interface renders `agent.awaitingInputEscalatedAt` rather
 * than recomputing it.
 *
 * The escalation is announced twice, deliberately, because the two audiences
 * are in different places: a `warn` log event (which reaches the snapshot's
 * `warnings`, the dashboard's alert card and `session.json`) and a diagnostic
 * line in `~/.issue-flow/logs`, which survives with no monitor running at all.
 */

/**
 * How long an unanswered question waits before it is escalated.
 *
 * Five minutes is the shortest interval that does not fire on somebody who
 * stepped away to read a diff: the hook reports the block the instant it
 * happens, so this is silence *after* the question was already visible.
 */
export const AWAITING_INPUT_ESCALATION_MS = 300_000;

/** How often the wait is measured. A minute of granularity is plenty here. */
export const AWAITING_INPUT_CHECK_MS = 30_000;

export interface AwaitingInputDecision {
  /** How long the agent has been waiting, or `null` when it is not waiting. */
  waitedMs: number | null;
  /** Whether this tick should publish an escalation. */
  escalate: boolean;
}

/**
 * The whole policy, as a pure function.
 *
 * Pure so the threshold, the hold suppression and the idempotence are testable
 * without a timer, a publisher or a clock.
 */
export function decideAwaitingInputEscalation(
  agent: SessionSnapshot['agent'],
  options: { now: number; thresholdMs?: number },
): AwaitingInputDecision {
  const thresholdMs = options.thresholdMs ?? AWAITING_INPUT_ESCALATION_MS;

  // Not blocked on anybody: there is nothing to escalate.
  if (agent.lifecycle !== 'awaiting-input') return { waitedMs: null, escalate: false };

  // Somebody is driving. They *are* the answer, and §32 is explicit that the
  // watchdog and everything like it steps back while a person holds the run.
  if (agent.humanHold !== null) return { waitedMs: null, escalate: false };

  const since = agent.since === null ? Number.NaN : Date.parse(agent.since);
  // A harness that reported the state without a usable timestamp gives no
  // basis for a duration. Reporting "waiting since epoch" would escalate every
  // such run instantly, which is worse than not escalating it at all.
  if (Number.isNaN(since)) return { waitedMs: null, escalate: false };

  const waitedMs = Math.max(0, options.now - since);
  if (waitedMs < thresholdMs) return { waitedMs, escalate: false };

  // Already escalated: the state is on the screen and in the log. Publishing
  // again on every tick would bury the run's real warnings under copies of one.
  if (agent.awaitingInputEscalatedAt !== null) return { waitedMs, escalate: false };

  return { waitedMs, escalate: true };
}

/** Minutes, rounded, for a message a person reads. */
function minutesOf(waitedMs: number): number {
  return Math.max(1, Math.round(waitedMs / 60_000));
}

export function describeAwaitingInputEscalation(phase: string | null, waitedMs: number): string {
  const where = phase === null ? '' : ` during '${phase}'`;
  return `Nobody has answered the agent${where} for ${minutesOf(waitedMs)} minute(s). The run is not progressing until someone does.`;
}

export interface AwaitingInputWatch {
  /** Run one check now. Exposed so a test drives the policy without a timer. */
  check(): void;
  stop(): void;
}

export interface AwaitingInputWatchOptions {
  publisher: SessionPublisher;
  /** Silence tolerated before escalating. Defaults to the module constant. */
  thresholdMs?: number;
  /** How often the wait is measured. */
  intervalMs?: number;
  /** Injectable clock, so a test drives the wait without waiting for it. */
  clock?: () => number;
  setInterval?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  /** Diagnostics sink. Defaults to the machine-wide JSONL log. */
  onEscalate?: (input: { phase: string | null; waitedMs: number; at: string }) => void;
}

/**
 * Watch one run's `awaiting-input` state and escalate an unanswered question.
 *
 * A timer rather than a reaction to the event itself, because the thing being
 * detected is the **absence** of a follow-up: the only way to observe that
 * nothing happened for five minutes is to look again in five minutes. Same
 * shape as `core/watchdog.ts`, and for the same reason.
 *
 * The interval is `unref`'d, so it never keeps the process alive past the
 * invocation it belongs to.
 */
export function startAwaitingInputWatch(options: AwaitingInputWatchOptions): AwaitingInputWatch {
  const clock = options.clock ?? Date.now;
  const start = options.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const clear = options.clearInterval ?? ((timer) => clearInterval(timer));
  const onEscalate =
    options.onEscalate ??
    ((input) => {
      writeDiagnostic({
        level: 'warning',
        message: describeAwaitingInputEscalation(input.phase, input.waitedMs),
        context: { phase: input.phase, waitedMs: input.waitedMs },
      });
    });

  let stopped = false;

  const check = (): void => {
    if (stopped) return;
    const snapshot = options.publisher.snapshot();
    const now = clock();
    const decision = decideAwaitingInputEscalation(snapshot.agent, {
      now,
      ...(options.thresholdMs === undefined ? {} : { thresholdMs: options.thresholdMs }),
    });
    if (!decision.escalate || decision.waitedMs === null) return;

    const at = new Date(now).toISOString();
    const phase = snapshot.agent.phase;
    options.publisher.publish({
      type: 'agent:awaiting-input-escalated',
      at,
      phase: phase ?? '',
      waitedMs: decision.waitedMs,
    });
    // The notification half of §32's row. `warn` and not `error`: nothing has
    // failed — a person is late.
    options.publisher.publish({
      type: 'log',
      at,
      level: 'warn',
      message: describeAwaitingInputEscalation(phase, decision.waitedMs),
    });
    onEscalate({ phase, waitedMs: decision.waitedMs, at });
  };

  const timer = start(check, options.intervalMs ?? AWAITING_INPUT_CHECK_MS);
  timer.unref?.();

  return {
    check,
    stop: () => {
      stopped = true;
      clear(timer);
    },
  };
}
