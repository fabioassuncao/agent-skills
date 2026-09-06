import type { SessionEvent } from './events.js';
import type { SessionSnapshot } from './snapshot.js';

export type AgentLifecycleEvent = Extract<
  SessionEvent,
  { type: 'agent:busy' | 'agent:awaiting-input' | 'pr:opened' }
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
        },
      };

    case 'agent:awaiting-input':
      return {
        ...snapshot,
        agent: {
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
        },
      };

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
