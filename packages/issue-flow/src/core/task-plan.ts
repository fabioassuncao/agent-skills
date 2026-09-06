import { taskPlanSchema } from '../schemas.js';
import type { UserStory } from '../types.js';

export interface ArtifactError {
  code: string;
  path: string;
  message: string;
}

/** Structural dependencies are deliberately never inferred from story prose. */
export function validateStoryDependencies(stories: readonly UserStory[]): ArtifactError[] {
  const errors: ArtifactError[] = [];
  const byId = new Map<string, UserStory>();
  for (const [index, story] of stories.entries()) {
    if (byId.has(story.id)) {
      errors.push({
        code: 'duplicate_story',
        path: `userStories.${index}.id`,
        message: `Duplicate story ID: ${story.id}`,
      });
    }
    byId.set(story.id, story);
    for (const id of story.dependencies ?? []) {
      if (id === story.id || !stories.some((candidate) => candidate.id === id)) {
        errors.push({
          code: id === story.id ? 'self_dependency' : 'missing_dependency',
          path: `userStories.${index}.dependencies`,
          message: `${story.id} depends on ${id}`,
        });
      }
    }
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(id: string, chain: string[]): void {
    if (active.has(id)) {
      errors.push({
        code: 'dependency_cycle',
        path: 'userStories',
        message: `Dependency cycle: ${[...chain, id].join(' -> ')}`,
      });
      return;
    }
    if (visited.has(id) || !byId.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency, [...chain, id]);
    active.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id, []);
  return errors;
}

export function eligibleStories(stories: readonly UserStory[]): UserStory[] {
  const passed = new Set(stories.filter((story) => story.passes).map((story) => story.id));
  return stories
    .filter((story) => !story.passes && (story.dependencies ?? []).every((id) => passed.has(id)))
    .sort((a, b) => a.priority - b.priority);
}

/** A bounded projection for inspection, never a replacement for the source plan. */
export function inspectTaskPlan(value: unknown) {
  const parsed = taskPlanSchema.safeParse(value);
  if (!parsed.success) {
    return {
      schemaVersion: 1 as const,
      ok: false as const,
      data: null,
      errors: parsed.error.issues.map((issue) => ({
        code: 'schema',
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }
  const plan = parsed.data;
  const errors = validateStoryDependencies(plan.userStories);
  if (errors.length) return { schemaVersion: 1 as const, ok: false as const, data: null, errors };
  const ready = eligibleStories(plan.userStories);
  const correctionRequired = Boolean(plan.lastReviewFindings);
  const next = correctionRequired ? undefined : ready[0];
  return {
    schemaVersion: 1 as const,
    ok: true as const,
    data: {
      counts: {
        total: plan.userStories.length,
        passed: plan.userStories.filter((story) => story.passes).length,
        ready: ready.length,
      },
      readyStoryIds: ready.map((story) => story.id),
      blockedStories: plan.userStories
        .filter((story) => !story.passes && !ready.includes(story))
        .map((story) => ({
          id: story.id,
          dependencies: (story.dependencies ?? []).filter(
            (id) => !plan.userStories.find((candidate) => candidate.id === id)?.passes,
          ),
        })),
      correctionRequired,
      executionComplete:
        plan.userStories.length > 0 &&
        plan.userStories.every((story) => story.passes) &&
        !correctionRequired,
      nextStory: next
        ? {
            id: next.id,
            title: next.title,
            description: next.description,
            acceptanceCriteria: next.acceptanceCriteria,
          }
        : null,
    },
    errors: [],
  };
}
