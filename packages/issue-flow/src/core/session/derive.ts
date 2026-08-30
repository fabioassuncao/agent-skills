import type { UserStoryStatus } from '../../types.js';
import type { SessionEvent } from './events.js';
import type { SessionSnapshot, SessionStorySnapshot, SessionUsageSnapshot } from './snapshot.js';

export type MetricsUpdateEvent = Extract<SessionEvent, { type: 'metrics:update' }>;

/**
 * Add a reported delta to an accumulator. `undefined` means "not reported":
 * it leaves the accumulator untouched, so a metric the CLI never returned
 * stays null instead of collapsing to zero.
 */
export function accumulate(current: number | null, delta: number | undefined): number | null {
  return delta === undefined ? current : (current ?? 0) + delta;
}

/** Fold the event's token/cost fields into a phase or story entry. */
export function accumulateUsage<T extends SessionUsageSnapshot>(target: T, event: MetricsUpdateEvent): T {
  return {
    ...target,
    inputTokens: accumulate(target.inputTokens, event.inputTokens),
    outputTokens: accumulate(target.outputTokens, event.outputTokens),
    cacheReadTokens: accumulate(target.cacheReadTokens, event.cacheReadTokens),
    cacheCreationTokens: accumulate(target.cacheCreationTokens, event.cacheCreationTokens),
    costUsd: accumulate(target.costUsd, event.costUsd),
  };
}

/**
 * Pick between a reported value and the one already in the snapshot.
 * Unlike `??`, an explicitly reported `null` wins: only `undefined` — the
 * absence of the field on the event — keeps the previous value.
 */
export function reported<T>(value: T | undefined, previous: T): T {
  return value === undefined ? previous : value;
}

/**
 * Seconds between two ISO timestamps, or null when either is unparsable.
 */
export function secondsBetween(from: string | null, to: string): number | null {
  if (from === null) return null;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return null;
  return Math.max(0, Math.round((toMs - fromMs) / 1000));
}

export function computePercent(phasesCompleted: number, phasesTotal: number): number {
  if (phasesTotal === 0) return 0;
  return Math.round((phasesCompleted / phasesTotal) * 100);
}

/**
 * Estimated seconds until all stories pass: average duration of the stories
 * completed during this session × pending stories. Durations are the gaps
 * between consecutive completions (the first is measured from startedAt).
 * Published as null with fewer than two samples.
 */
export function estimateRemainingSeconds(snapshot: SessionSnapshot): number | null {
  const completions = snapshot.stories
    .map((story) => (story.completedAt === null ? Number.NaN : Date.parse(story.completedAt)))
    .filter((ms) => !Number.isNaN(ms))
    .sort((a, b) => a - b);
  if (completions.length < 2) return null;

  const startMs = snapshot.startedAt === null ? Number.NaN : Date.parse(snapshot.startedAt);
  const boundaries = Number.isNaN(startMs) ? completions : [startMs, ...completions];
  const durations: number[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    durations.push(Math.max(0, boundaries[i] - boundaries[i - 1]));
  }
  if (durations.length === 0) return null;

  const averageMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;
  const pending = snapshot.stories.filter((story) => !story.passes).length;
  return Math.round((averageMs * pending) / 1000);
}

/**
 * Remaining pipeline phases, in order. The phase list originates from the
 * session:start event, whose caller passes PIPELINE_PHASES (or
 * PIPELINE_PHASES_NO_BRANCH in --no-branch mode) from src/core/pipeline.ts.
 */
export function deriveNextSteps(snapshot: SessionSnapshot): string[] {
  if (snapshot.status === 'completed') return [];
  return snapshot.phases.filter((phase) => phase.status === 'pending').map((phase) => phase.name);
}

/**
 * Board status of a single story, in a fixed order that makes the derivation
 * idempotent — recomputing it over its own result yields the same value:
 *
 * 1. `passes: true` → `done` (execution is the only authority on completion);
 * 2. already `in_review` → kept, since nothing here can produce or clear it;
 * 3. the story owns the current activity → `in_progress`;
 * 4. otherwise → `backlog`.
 *
 * `in_review` is therefore never derived: it only enters through an explicit
 * `status` in tasks.json, and leaves when the story starts passing.
 */
export function deriveStoryStatus(
  story: SessionStorySnapshot,
  activeStory: string | null,
): UserStoryStatus {
  if (story.passes) return 'done';
  if (story.status === 'in_review') return 'in_review';
  if (activeStory !== null && activeStory === story.id) return 'in_progress';
  return 'backlog';
}

/** Recompute every story's status; entries that do not change keep identity. */
export function deriveStoryStatuses(snapshot: SessionSnapshot): SessionStorySnapshot[] {
  const activeStory = snapshot.currentActivity?.story ?? null;
  return snapshot.stories.map((story) => {
    const status = deriveStoryStatus(story, activeStory);
    return status === story.status ? story : { ...story, status };
  });
}
