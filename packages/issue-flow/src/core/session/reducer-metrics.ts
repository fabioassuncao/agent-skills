import { accumulate, accumulateUsage } from './derive.js';
import type { SessionEvent } from './events.js';
import type { SessionSnapshot } from './snapshot.js';

export type MetricsEvent = Extract<SessionEvent, { type: 'metrics:update' }>;

export function applyMetricsEvent(snapshot: SessionSnapshot, event: MetricsEvent): SessionSnapshot {
  switch (event.type) {
    case 'metrics:update': {
      if (event.scope === 'story') {
        // Story metrics are a rateio of the iteration that completed them;
        // the iteration-scoped event already fed the phase and the aggregate,
        // so counting them again here would double the totals.
        if (event.storyId === undefined) return snapshot;
        if (!snapshot.stories.some((s) => s.id === event.storyId)) return snapshot;
        return {
          ...snapshot,
          stories: snapshot.stories.map((story) =>
            story.id === event.storyId
              ? {
                  ...accumulateUsage(story, event),
                  durationSeconds: accumulate(story.durationSeconds, event.durationSeconds),
                }
              : story,
          ),
        };
      }

      // phase and iteration scopes both land on the named phase. An event for
      // a phase the snapshot never saw is ignored rather than appended: it
      // would show up as a phantom entry in the UI.
      if (event.phase === undefined) return snapshot;
      if (!snapshot.phases.some((p) => p.name === event.phase)) return snapshot;
      return {
        ...snapshot,
        // durationSeconds is deliberately untouched here: phase:start and
        // phase:end remain the single source of a phase's wall-clock time.
        phases: snapshot.phases.map((phase) =>
          phase.name === event.phase ? accumulateUsage(phase, event) : phase,
        ),
        metrics: {
          totalInputTokens: accumulate(snapshot.metrics.totalInputTokens, event.inputTokens),
          totalOutputTokens: accumulate(snapshot.metrics.totalOutputTokens, event.outputTokens),
          totalCacheReadTokens: accumulate(
            snapshot.metrics.totalCacheReadTokens,
            event.cacheReadTokens,
          ),
          totalCacheCreationTokens: accumulate(
            snapshot.metrics.totalCacheCreationTokens,
            event.cacheCreationTokens,
          ),
          totalCostUsd: accumulate(snapshot.metrics.totalCostUsd, event.costUsd),
        },
      };
    }
  }
}
