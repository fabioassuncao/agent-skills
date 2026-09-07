import {
  deriveNextSteps,
  deriveStoryStatuses,
  estimateRemainingSeconds,
  secondsBetween,
} from './derive.js';
import type { SessionEvent } from './events.js';
import { applyAgentLifecycleEvent } from './reducer-agent.js';
import { applyGitEvent } from './reducer-git.js';
import { applyLogEvent } from './reducer-log.js';
import { applyMetricsEvent } from './reducer-metrics.js';
import { applyPhaseEvent } from './reducer-phase.js';
import { applyResilienceEvent } from './reducer-resilience.js';
import { applySessionEvent } from './reducer-session.js';
import { applyStoryEvent } from './reducer-story.js';
import type { SessionReducerOptions, SessionSnapshot } from './snapshot.js';

export {
  deriveStageOnStoriesUpdate,
  isTerminalStage,
  transitionStory,
} from './reducer-stage.js';

/**
 * Fold a SessionEvent into a SessionSnapshot. Pure: never mutates the input
 * and performs no I/O. Unknown event types return the snapshot unchanged.
 *
 * errors/warnings are derived slices of the logs ring buffer, recomputed on
 * each reduction — they are never accumulated separately. The same applies
 * to estimatedRemainingSeconds, nextSteps and each story's status.
 */
export function reduceSessionEvent(
  snapshot: SessionSnapshot,
  event: SessionEvent,
  options?: SessionReducerOptions,
): SessionSnapshot {
  const next = applyEvent(snapshot, event, options);
  if (next === snapshot) return snapshot;

  const elapsedSeconds = secondsBetween(next.startedAt, event.at) ?? next.elapsedSeconds;
  return {
    ...next,
    updatedAt: event.at,
    elapsedSeconds,
    stories: deriveStoryStatuses(next),
    estimatedRemainingSeconds: estimateRemainingSeconds(next),
    errors: next.logs.filter((entry) => entry.level === 'error'),
    warnings: next.logs.filter((entry) => entry.level === 'warn'),
    nextSteps: deriveNextSteps(next),
  };
}

function applyEvent(
  snapshot: SessionSnapshot,
  event: SessionEvent,
  options?: SessionReducerOptions,
): SessionSnapshot {
  switch (event.type) {
    case 'session:start':
    case 'session:end':
    case 'issue:update':
    case 'verify:end':
      return applySessionEvent(snapshot, event);

    case 'phase:start':
    case 'phase:end':
    case 'iteration:start':
    case 'iteration:end':
    case 'correction:cycle':
      return applyPhaseEvent(snapshot, event);

    case 'stories:update':
    case 'activity':
      return applyStoryEvent(snapshot, event);

    case 'metrics:update':
      return applyMetricsEvent(snapshot, event);

    case 'git:update':
      return applyGitEvent(snapshot, event);

    case 'log':
    case 'process:output':
    case 'execution:update':
      return applyLogEvent(snapshot, event, options);

    case 'retry':
    case 'agent:attempt':
    case 'failover':
    case 'agent:result':
    case 'agent:activity':
      return applyResilienceEvent(snapshot, event);

    case 'agent:busy':
    case 'agent:awaiting-input':
    case 'agent:awaiting-input-escalated':
    case 'pr:opened':
    case 'human:hold':
    case 'human:resume':
      return applyAgentLifecycleEvent(snapshot, event);

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return snapshot;
    }
  }
}
