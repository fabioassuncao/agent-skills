import type { StoryStage, UserStory } from '../../types.js';
import type { SessionStorySnapshot } from './snapshot.js';

/**
 * Stages that describe a finished story. A run that ends — successfully or
 * not — must never leave a story on any other stage, or the panel keeps
 * claiming it is executing long after the process is gone.
 */
export function isTerminalStage(stage: StoryStage): boolean {
  return stage === 'done' || stage === 'failed';
}

export function transitionStory(
  story: SessionStorySnapshot,
  stage: StoryStage,
  at: string,
  detail: string | null,
): SessionStorySnapshot {
  if (story.stage === stage && story.stageDetail === detail) return story;
  return {
    ...story,
    stage,
    stageSince: at,
    stageDetail: detail,
    history: [...story.history, { at, stage, detail }],
  };
}

/**
 * `stage`/`stageSince`/`stageDetail` for one story, on one `stories:update`.
 *
 * This event owns exactly one transition — `awaiting_review` the moment a
 * story flips to `passes: true` (or is first seen already passing, since its
 * real completion moment is unknown either way). Everything else is a
 * carry-over: a still-`passes: false` story keeps whatever `iteration:start`
 * last gave it (defaulting to `'pending'` the very first time it is ever
 * seen), and a story already passing before this event is left exactly as it
 * was — `phase:start`/`phase:end` (review) and `correction:cycle` own every
 * transition past `awaiting_review`.
 */
export function deriveStageOnStoriesUpdate(
  story: UserStory,
  before: SessionStorySnapshot | undefined,
  at: string,
): Pick<SessionStorySnapshot, 'stage' | 'stageSince' | 'stageDetail'> {
  if (!story.passes) {
    return {
      stage: before?.stage ?? 'pending',
      stageSince: before?.stageSince ?? at,
      stageDetail: before?.stageDetail ?? null,
    };
  }
  if (before?.passes) {
    return { stage: before.stage, stageSince: before.stageSince, stageDetail: before.stageDetail };
  }
  return { stage: 'awaiting_review', stageSince: at, stageDetail: null };
}
