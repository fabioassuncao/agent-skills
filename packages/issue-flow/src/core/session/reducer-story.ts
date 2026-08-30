import type { SessionEvent } from './events.js';
import { deriveStageOnStoriesUpdate } from './reducer-stage.js';
import type { SessionSnapshot } from './snapshot.js';

export type StoryEvent = Extract<SessionEvent, { type: 'stories:update' | 'activity' }>;

export function applyStoryEvent(snapshot: SessionSnapshot, event: StoryEvent): SessionSnapshot {
  switch (event.type) {
    case 'stories:update': {
      const previous = new Map(snapshot.stories.map((story) => [story.id, story]));
      const stories = event.stories.map((story) => {
        const before = previous.get(story.id);
        // Stamp the flip to passing; stories already passing when first seen
        // keep null (completed before this session, duration unknown).
        const completedAt = !story.passes
          ? null
          : before && !before.passes
            ? event.at
            : (before?.completedAt ?? null);
        // stories:update rebuilds the array from the plan on every publish, so
        // metrics already attributed to a story must be carried over here or
        // the next update would wipe them.
        const stage = deriveStageOnStoriesUpdate(story, before, event.at);
        const history = before?.history ?? [];
        const stageChanged = before !== undefined && before.stage !== stage.stage;
        return {
          id: story.id,
          title: story.title,
          priority: story.priority,
          passes: story.passes,
          completedAt,
          // Seed only: deriveStoryStatus() recomputes it right after, so an
          // explicit 'done' in the plan on a story with passes: false is not
          // honoured — `passes` remains the single source of truth. The plan's
          // value survives just for 'in_review', which no derivation produces.
          status: story.status ?? before?.status ?? 'backlog',
          dependencies: story.dependencies ?? [],
          // Required on UserStory, so the plan is always the source — no
          // carry-over from `before` the way the accumulated fields need.
          description: story.description,
          acceptanceCriteria: story.acceptanceCriteria,
          durationSeconds: before?.durationSeconds ?? null,
          inputTokens: before?.inputTokens ?? null,
          outputTokens: before?.outputTokens ?? null,
          cacheReadTokens: before?.cacheReadTokens ?? null,
          cacheCreationTokens: before?.cacheCreationTokens ?? null,
          costUsd: before?.costUsd ?? null,
          ...stage,
          history: stageChanged
            ? [...history, { at: event.at, stage: stage.stage, detail: stage.stageDetail }]
            : history,
        };
      });
      return {
        ...snapshot,
        stories,
        progress: {
          ...snapshot.progress,
          storiesCompleted: stories.filter((s) => s.passes).length,
          storiesTotal: stories.length,
        },
      };
    }

    case 'activity': {
      const story = event.story ?? null;
      const tool = event.tool ?? null;
      const detail = event.detail ?? null;
      const current = snapshot.currentActivity;
      // Same activity repeated: keep `since` so the UI can show "for how long".
      const since =
        current && current.story === story && current.tool === tool && current.detail === detail
          ? current.since
          : event.at;
      return {
        ...snapshot,
        currentActivity: { story, tool, detail, since },
        resilience: { ...snapshot.resilience, lastActivityAt: event.at },
      };
    }

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
