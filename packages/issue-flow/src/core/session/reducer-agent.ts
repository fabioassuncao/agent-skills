import type { SessionEvent } from './events.js';
import type { SessionSnapshot } from './snapshot.js';

export type AgentLifecycleEvent = Extract<
  SessionEvent,
  {
    type:
      | 'agent:busy'
      | 'agent:awaiting-input'
      | 'agent:awaiting-input-escalated'
      | 'pr:opened'
      | 'human:hold'
      | 'human:resume';
  }
>;

/**
 * Project what an agent's own hooks reported (ADR-05).
 *
 * Nothing here is inferred from output: the snapshot says "awaiting input"
 * only because a `Notification` hook said so, and stops saying it only because
 * the agent reported it went back to work. That is the whole point of taking
 * this from a hook instead of from a TTY parser — a parser produces a plausible
 * answer to a question it cannot actually observe.
 */
export function applyAgentLifecycleEvent(
  snapshot: SessionSnapshot,
  event: AgentLifecycleEvent,
): SessionSnapshot {
  switch (event.type) {
    case 'agent:busy':
      return {
        ...snapshot,
        agent: {
          ...snapshot.agent,
          lifecycle: 'busy',
          since: event.at,
          phase: event.phase,
          // Somebody answered — the agent is producing output again. Leaving
          // the escalation set would keep a resolved alarm on the screen for
          // the rest of the run.
          awaitingInputEscalatedAt: null,
          awaitingInputWaitedMs: null,
        },
      };

    case 'agent:awaiting-input':
      return {
        ...snapshot,
        agent: {
          ...snapshot.agent,
          lifecycle: 'awaiting-input',
          since: event.at,
          phase: event.phase,
          // Counted only on the transition. A harness that reports the same
          // prompt twice would otherwise inflate a number people read as
          // "how often did this run need me".
          awaitingInputCount:
            snapshot.agent.lifecycle === 'awaiting-input'
              ? snapshot.agent.awaitingInputCount
              : snapshot.agent.awaitingInputCount + 1,
          // A fresh question restarts the clock: the escalation belongs to the
          // wait that produced it, not to the run.
          awaitingInputEscalatedAt:
            snapshot.agent.lifecycle === 'awaiting-input'
              ? snapshot.agent.awaitingInputEscalatedAt
              : null,
          awaitingInputWaitedMs:
            snapshot.agent.lifecycle === 'awaiting-input'
              ? snapshot.agent.awaitingInputWaitedMs
              : null,
        },
      };

    case 'agent:awaiting-input-escalated':
      return {
        ...snapshot,
        agent: {
          ...snapshot.agent,
          // Idempotent for the same reason `human:hold` is: the watch may see
          // the threshold crossed on several ticks, and moving the timestamp
          // would erase how long the run has actually been stuck.
          awaitingInputEscalatedAt: snapshot.agent.awaitingInputEscalatedAt ?? event.at,
          awaitingInputWaitedMs: snapshot.agent.awaitingInputWaitedMs ?? event.waitedMs,
        },
      };

    case 'human:hold':
      return {
        ...snapshot,
        agent: {
          ...snapshot.agent,
          // Idempotent: a person typing produces one of these per burst, and
          // moving `since` would erase how long they have been in control.
          humanHold: snapshot.agent.humanHold ?? { since: event.at, reason: event.reason },
          // A takeover *is* somebody coming. The two conditions are distinct
          // (§32), and the one that means "nobody answered" stops being true
          // the moment a person is in control.
          awaitingInputEscalatedAt: null,
          awaitingInputWaitedMs: null,
        },
      };

    case 'human:resume':
      return { ...snapshot, agent: { ...snapshot.agent, humanHold: null } };

    case 'pr:opened': {
      // Same list the `pr` phase writes through `git:update`: one concept, two
      // producers. Matching on the URL keeps a hook-reported PR and a
      // phase-reported one from becoming two entries for one pull request.
      if (snapshot.pullRequests.some((entry) => entry.url === event.url)) return snapshot;
      return {
        ...snapshot,
        pullRequests: [
          ...snapshot.pullRequests,
          {
            number: event.number ?? 0,
            url: event.url,
            title: event.title ?? '',
          },
        ],
      };
    }
  }
}
