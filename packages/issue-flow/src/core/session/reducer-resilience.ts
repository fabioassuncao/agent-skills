import type { SessionEvent } from './events.js';
import type { SessionSnapshot } from './snapshot.js';

export type ResilienceEvent = Extract<
  SessionEvent,
  { type: 'retry' | 'agent:attempt' | 'failover' | 'agent:result' | 'agent:activity' }
>;

export function applyResilienceEvent(
  snapshot: SessionSnapshot,
  event: ResilienceEvent,
): SessionSnapshot {
  switch (event.type) {
    case 'retry':
      return {
        ...snapshot,
        execution: { ...snapshot.execution, retries: snapshot.execution.retries + 1 },
      };

    case 'agent:attempt':
      return {
        ...snapshot,
        resilience: {
          ...snapshot.resilience,
          attempt: event.attempt,
          provider: event.provider,
          model: event.model ?? null,
          lastActivityAt: event.at,
        },
      };

    case 'failover':
      return {
        ...snapshot,
        resilience: {
          ...snapshot.resilience,
          provider: event.to,
          lastFailureKind: event.reason,
          cooldownUntil: event.cooldownUntil ?? null,
          lastActivityAt: event.at,
        },
      };

    case 'agent:result':
      return {
        ...snapshot,
        resilience: {
          ...snapshot.resilience,
          provider: event.provider,
          lastFailureKind: event.failureKind ?? snapshot.resilience.lastFailureKind,
          cooldownUntil: event.cooldownUntil ?? null,
          lastActivityAt: event.at,
        },
      };

    case 'agent:activity':
      return {
        ...snapshot,
        resilience: {
          ...snapshot.resilience,
          provider: event.provider,
          lastActivityAt: event.at,
        },
      };

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
