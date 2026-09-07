import { describe, expect, it, vi } from 'vitest';
import {
  AWAITING_INPUT_ESCALATION_MS,
  decideAwaitingInputEscalation,
  describeAwaitingInputEscalation,
  startAwaitingInputWatch,
} from './awaiting-input.js';
import { MemoryPublisher } from './session/publishers.js';
import { createInitialSnapshot, type SessionSnapshot } from './session/snapshot.js';

/**
 * The last row of §32's table: `awaiting_input` with no answer for N minutes
 * escalates.
 *
 * The two cases that decide whether this is right are the ones a naive
 * implementation gets wrong, and they each have their own case below:
 *
 * - a **human hold** is the opposite condition (somebody took the run over and
 *   is thinking) and must never escalate;
 * - the decision is the **pipeline's**, so it fires with no dashboard anywhere
 *   near it (ADR-03) — the watch here runs against a publisher, which is all a
 *   headless run has.
 */

const T0 = Date.parse('2026-09-06T10:00:00.000Z');

function agentOf(overrides: Partial<SessionSnapshot['agent']> = {}): SessionSnapshot['agent'] {
  return { ...createInitialSnapshot().agent, ...overrides };
}

describe('decideAwaitingInputEscalation', () => {
  it('does not escalate an agent that is not waiting on anybody', () => {
    const decision = decideAwaitingInputEscalation(
      agentOf({ lifecycle: 'busy', since: new Date(T0).toISOString() }),
      { now: T0 + AWAITING_INPUT_ESCALATION_MS * 10 },
    );
    expect(decision).toEqual({ waitedMs: null, escalate: false });
  });

  it('does not escalate before the threshold', () => {
    const decision = decideAwaitingInputEscalation(
      agentOf({ lifecycle: 'awaiting-input', since: new Date(T0).toISOString() }),
      { now: T0 + AWAITING_INPUT_ESCALATION_MS - 1 },
    );
    expect(decision.escalate).toBe(false);
    expect(decision.waitedMs).toBe(AWAITING_INPUT_ESCALATION_MS - 1);
  });

  it('escalates once the threshold is crossed', () => {
    const decision = decideAwaitingInputEscalation(
      agentOf({ lifecycle: 'awaiting-input', since: new Date(T0).toISOString() }),
      { now: T0 + AWAITING_INPUT_ESCALATION_MS },
    );
    expect(decision).toEqual({ waitedMs: AWAITING_INPUT_ESCALATION_MS, escalate: true });
  });

  it('never escalates while a person is holding the run', () => {
    // The distinction §32 is explicit about: a hold means somebody is in
    // control and reading. Escalating there is exactly the false alarm the
    // hold exists to prevent, and it is why `heldForMs` is not this number.
    const decision = decideAwaitingInputEscalation(
      agentOf({
        lifecycle: 'awaiting-input',
        since: new Date(T0).toISOString(),
        humanHold: { since: new Date(T0).toISOString(), reason: 'takeover' },
      }),
      { now: T0 + AWAITING_INPUT_ESCALATION_MS * 100 },
    );
    expect(decision).toEqual({ waitedMs: null, escalate: false });
  });

  it('does not escalate twice for the same wait', () => {
    const decision = decideAwaitingInputEscalation(
      agentOf({
        lifecycle: 'awaiting-input',
        since: new Date(T0).toISOString(),
        awaitingInputEscalatedAt: new Date(T0 + AWAITING_INPUT_ESCALATION_MS).toISOString(),
      }),
      { now: T0 + AWAITING_INPUT_ESCALATION_MS * 3 },
    );
    expect(decision.escalate).toBe(false);
  });

  it('does not escalate a state reported without a usable timestamp', () => {
    // "Waiting since epoch" would escalate every such run on the first tick,
    // which is worse than not escalating it at all.
    for (const since of [null, 'not-a-date']) {
      const decision = decideAwaitingInputEscalation(
        agentOf({ lifecycle: 'awaiting-input', since }),
        { now: T0 + AWAITING_INPUT_ESCALATION_MS * 10 },
      );
      expect(decision).toEqual({ waitedMs: null, escalate: false });
    }
  });
});

describe('startAwaitingInputWatch', () => {
  function publisherWaitingSince(at: string): MemoryPublisher {
    const publisher = new MemoryPublisher();
    publisher.publish({ type: 'agent:awaiting-input', at, phase: 'execute' });
    return publisher;
  }

  it('publishes the escalation and a warning, headless, with no dashboard', () => {
    const publisher = publisherWaitingSince(new Date(T0).toISOString());
    const onEscalate = vi.fn();
    const watch = startAwaitingInputWatch({
      publisher,
      clock: () => T0 + AWAITING_INPUT_ESCALATION_MS,
      setInterval: () => 0 as unknown as NodeJS.Timeout,
      clearInterval: () => {},
      onEscalate,
    });

    watch.check();

    const snapshot = publisher.snapshot();
    expect(snapshot.agent.awaitingInputEscalatedAt).toBe(
      new Date(T0 + AWAITING_INPUT_ESCALATION_MS).toISOString(),
    );
    expect(snapshot.agent.awaitingInputWaitedMs).toBe(AWAITING_INPUT_ESCALATION_MS);
    // The notification half of the row: it reaches the snapshot's warnings, so
    // it is on the alert card and in session.json without a monitor running.
    expect(snapshot.warnings.map((entry) => entry.message)).toContain(
      describeAwaitingInputEscalation('execute', AWAITING_INPUT_ESCALATION_MS),
    );
    expect(onEscalate).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it('escalates only once however many times it looks', () => {
    const publisher = publisherWaitingSince(new Date(T0).toISOString());
    const onEscalate = vi.fn();
    let now = T0 + AWAITING_INPUT_ESCALATION_MS;
    const watch = startAwaitingInputWatch({
      publisher,
      clock: () => now,
      setInterval: () => 0 as unknown as NodeJS.Timeout,
      clearInterval: () => {},
      onEscalate,
    });

    watch.check();
    now += AWAITING_INPUT_ESCALATION_MS;
    watch.check();
    now += AWAITING_INPUT_ESCALATION_MS;
    watch.check();

    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(publisher.snapshot().warnings).toHaveLength(1);
    watch.stop();
  });

  it('clears the escalation when the agent goes back to work', () => {
    const publisher = publisherWaitingSince(new Date(T0).toISOString());
    const watch = startAwaitingInputWatch({
      publisher,
      clock: () => T0 + AWAITING_INPUT_ESCALATION_MS,
      setInterval: () => 0 as unknown as NodeJS.Timeout,
      clearInterval: () => {},
      onEscalate: () => {},
    });
    watch.check();
    expect(publisher.snapshot().agent.awaitingInputEscalatedAt).not.toBeNull();

    publisher.publish({
      type: 'agent:busy',
      at: new Date(T0 + AWAITING_INPUT_ESCALATION_MS + 1).toISOString(),
      phase: 'execute',
    });

    expect(publisher.snapshot().agent.awaitingInputEscalatedAt).toBeNull();
    expect(publisher.snapshot().agent.awaitingInputWaitedMs).toBeNull();
    watch.stop();
  });

  it('clears the escalation when a person takes the run over', () => {
    const publisher = publisherWaitingSince(new Date(T0).toISOString());
    const watch = startAwaitingInputWatch({
      publisher,
      clock: () => T0 + AWAITING_INPUT_ESCALATION_MS,
      setInterval: () => 0 as unknown as NodeJS.Timeout,
      clearInterval: () => {},
      onEscalate: () => {},
    });
    watch.check();

    publisher.publish({
      type: 'human:hold',
      at: new Date(T0 + AWAITING_INPUT_ESCALATION_MS + 1).toISOString(),
      reason: 'takeover',
    });

    expect(publisher.snapshot().agent.awaitingInputEscalatedAt).toBeNull();
    watch.stop();
  });

  it('stops looking once stopped', () => {
    const publisher = publisherWaitingSince(new Date(T0).toISOString());
    const onEscalate = vi.fn();
    const watch = startAwaitingInputWatch({
      publisher,
      clock: () => T0 + AWAITING_INPUT_ESCALATION_MS,
      setInterval: () => 0 as unknown as NodeJS.Timeout,
      clearInterval: () => {},
      onEscalate,
    });

    watch.stop();
    watch.check();

    expect(onEscalate).not.toHaveBeenCalled();
    expect(publisher.snapshot().agent.awaitingInputEscalatedAt).toBeNull();
  });
});
