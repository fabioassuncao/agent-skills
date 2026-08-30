import { stripVTControlCharacters } from 'node:util';
import { computePercent, secondsBetween } from './derive.js';
import type { SessionEvent } from './events.js';
import { isTerminalStage, transitionStory } from './reducer-stage.js';
import { emptyPhaseTiming, emptyUsage, type SessionSnapshot } from './snapshot.js';

export type PhaseEvent = Extract<
  SessionEvent,
  {
    type:
      | 'phase:start'
      | 'phase:end'
      | 'iteration:start'
      | 'iteration:end'
      | 'correction:cycle';
  }
>;

export function applyPhaseEvent(snapshot: SessionSnapshot, event: PhaseEvent): SessionSnapshot {
  switch (event.type) {
    case 'phase:start':
      return applyPhaseStart(snapshot, event);
    case 'phase:end':
      return applyPhaseEnd(snapshot, event);
    case 'iteration:start':
      return applyIterationStart(snapshot, event);
    case 'iteration:end':
      return { ...snapshot, currentActivity: null };
    case 'correction:cycle':
      return applyCorrectionCycle(snapshot, event);
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function applyPhaseStart(
  snapshot: SessionSnapshot,
  event: Extract<PhaseEvent, { type: 'phase:start' }>,
): SessionSnapshot {
  const known = snapshot.phases.some((p) => p.name === event.phase);
  const phases = known
    ? snapshot.phases.map((p) =>
        p.name === event.phase
          ? {
              ...p,
              status: 'running' as const,
              startedAt: event.at,
              endedAt: null,
              error: null,
            }
          : p,
      )
    : [
        ...snapshot.phases,
        {
          name: event.phase,
          status: 'running' as const,
          startedAt: event.at,
          endedAt: null,
          durationSeconds: null,
          error: null,
          ...emptyPhaseTiming(),
          ...emptyUsage(),
        },
      ];
  // The `execute` phase only completes (and `review` only starts) once
  // every story already passes — a pipeline invariant — so entering
  // `review` safely moves every passing story to 'in_review' in one go;
  // there is never a not-yet-passing story to skip over here.
  const stories =
    event.phase === 'review'
      ? snapshot.stories.map((story) =>
          story.passes ? transitionStory(story, 'in_review', event.at, null) : story,
        )
      : snapshot.stories;
  return {
    ...snapshot,
    currentPhase: event.phase,
    phases,
    stories,
    progress: known ? snapshot.progress : { ...snapshot.progress, phasesTotal: phases.length },
  };
}

function applyPhaseEnd(
  snapshot: SessionSnapshot,
  event: Extract<PhaseEvent, { type: 'phase:end' }>,
): SessionSnapshot {
  const phases = snapshot.phases.map((p) =>
    p.name === event.phase
      ? {
          ...p,
          status: event.success ? ('completed' as const) : ('failed' as const),
          endedAt: event.at,
          durationSeconds: secondsBetween(p.startedAt, event.at),
          error: event.error ? stripVTControlCharacters(event.error) : null,
          harnessExecutionMs: event.harnessExecutionMs ?? p.harnessExecutionMs,
          orchestrationOverheadMs: event.orchestrationOverheadMs ?? p.orchestrationOverheadMs,
          harnessStartupMs: event.harnessStartupMs ?? p.harnessStartupMs,
          ttftMs: event.ttftMs ?? p.ttftMs,
          attemptCount: event.attemptCount ?? p.attemptCount,
          retryDurationMs: event.retryDurationMs ?? p.retryDurationMs,
        }
      : p,
  );
  const phasesCompleted = phases.filter((p) => p.status === 'completed').length;
  // Success moves every passing story to 'done'. Failure (the correction
  // loop gave up after maxCorrectionCycles) closes every story that is not
  // already 'done' as 'failed' — including the ones that never reached
  // `passes`, which are precisely the stories the issue calls failed. A
  // phase that fails outside `review` closes the same non-terminal stages,
  // so nothing is left frozen on 'executing' after the run stops.
  const stories = !event.success
    ? snapshot.stories.map((story) =>
        isTerminalStage(story.stage) ? story : transitionStory(story, 'failed', event.at, null),
      )
    : event.phase === 'review'
      ? snapshot.stories.map((story) =>
          story.passes ? transitionStory(story, 'done', event.at, null) : story,
        )
      : snapshot.stories;
  return {
    ...snapshot,
    currentPhase: snapshot.currentPhase === event.phase ? null : snapshot.currentPhase,
    currentActivity: null,
    phases,
    stories,
    progress: {
      ...snapshot.progress,
      phasesCompleted,
      percent: computePercent(phasesCompleted, snapshot.progress.phasesTotal),
    },
  };
}

function applyIterationStart(
  snapshot: SessionSnapshot,
  event: Extract<PhaseEvent, { type: 'iteration:start' }>,
): SessionSnapshot {
  // The story matching storyId becomes 'executing'; every other
  // not-yet-passing story becomes 'pending' (a story that was already
  // 'executing' in a previous iteration but lost the turn reverts here).
  // Passing stories are untouched — this event owns only the
  // execute-loop's own pending/executing transition, never review or
  // correction. No-op branches (`return story`) avoid needless object
  // churn when the stage is already correct.
  const storyId = event.storyId;
  const stories = snapshot.stories.map((story) => {
    if (story.passes) return story;
    if (story.id === storyId) {
      return transitionStory(story, 'executing', event.at, null);
    }
    return transitionStory(story, 'pending', event.at, null);
  });
  return {
    ...snapshot,
    execution: { ...snapshot.execution, iteration: event.iteration },
    stories,
    // Finally populates the `story` field of the activity payload during
    // execute — today this phase never publishes an `activity` event at
    // all (no streaming), so `currentActivity` stays whatever an earlier
    // phase left it at. Left untouched when storyId is absent (every
    // story already passes, or the caller could not determine one).
    currentActivity:
      storyId !== undefined
        ? { story: storyId, tool: null, detail: null, since: event.at }
        : snapshot.currentActivity,
  };
}

function applyCorrectionCycle(
  snapshot: SessionSnapshot,
  event: Extract<PhaseEvent, { type: 'correction:cycle' }>,
): SessionSnapshot {
  // Correction is pipeline-wide, not per-story: commands/run.ts re-runs
  // the whole execute+review cycle on a review failure, with no notion
  // of which story a finding belongs to — so every passing story moves
  // to 'in_correction' together, carrying the cycle count as a readable
  // stageDetail.
  const stageDetail = `Cycle ${event.cycle}/${event.maxCycles}`;
  const stories = snapshot.stories.map((story) =>
    story.passes ? transitionStory(story, 'in_correction', event.at, stageDetail) : story,
  );
  return {
    ...snapshot,
    execution: {
      ...snapshot.execution,
      correctionCycle: event.cycle,
      maxCorrectionCycles: event.maxCycles,
    },
    stories,
  };
}
