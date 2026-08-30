import { readFile } from 'node:fs/promises';
import { ZodError } from 'zod';
import { taskPlanSchema } from '../schemas.js';
import { getPlanRepository, loadStoredPlan, saveStoredPlan } from '../storage/db/repository.js';
import { reconcileInterruptedExecutions } from '../telemetry/reconcile.js';
import type { LastError, PipelineState, TaskPlan, UserStory } from '../types.js';
import { writeFileAtomic } from '../utils/fs.js';
import { type ClaudeUsage, sumUsage } from './metrics.js';

/**
 * Get the current ISO timestamp.
 */
export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Load and parse a tasks.json file.
 * Validates that it has the expected structure.
 */
export async function loadTaskPlan(path: string): Promise<TaskPlan> {
  const repository = getPlanRepository(path);
  const content = repository === undefined ? await readFile(path, 'utf-8') : null;
  const raw = content === null ? null : JSON.parse(content);

  try {
    const parsed =
      repository === undefined
        ? (taskPlanSchema.parse(raw) as TaskPlan)
        : await loadStoredPlan(repository);
    const reconciled = reconcileInterruptedExecutions(parsed);
    if (reconciled !== parsed) {
      try {
        await saveTaskPlan(path, reconciled);
      } catch {
        // Observational: a failed persist of interrupted status still returns
        // the reconciled plan to this reader.
      }
    }
    return reconciled;
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Invalid tasks.json at ${path}:\n${issues}`);
    }
    throw err;
  }
}

/**
 * Save a TaskPlan to disk atomically (write-to-temp + rename).
 * This prevents corruption if the process is interrupted during write.
 */
export async function saveTaskPlan(path: string, plan: TaskPlan): Promise<void> {
  const repository = getPlanRepository(path);
  if (repository !== undefined) {
    await saveStoredPlan(repository, plan);
    return;
  }
  await writeFileAtomic(path, `${JSON.stringify(plan, null, 2)}\n`);
}

/**
 * Initialize default state fields on a TaskPlan.
 * Fills in missing fields with defaults, matching the Bash script behavior.
 *
 * The opt-in fields (`pullRequest`, `prReview`, `pipeline.prReviewCompleted`)
 * are deliberately absent from the defaults: they ride along on the spread when
 * present and stay out of the file entirely when the phases never ran.
 */
export function initializeState(plan: TaskPlan): TaskPlan {
  const defaultPipeline: PipelineState = {
    prdCompleted: false,
    jsonCompleted: false,
    executionCompleted: false,
    reviewCompleted: false,
    prCreated: false,
  };

  return {
    ...plan,
    issueStatus: plan.issueStatus ?? 'pending',
    completedAt: plan.completedAt ?? null,
    lastAttemptAt: plan.lastAttemptAt ?? null,
    lastError: plan.lastError ?? null,
    correctionCycle: plan.correctionCycle ?? 0,
    maxCorrectionCycles: plan.maxCorrectionCycles ?? 3,
    lastReviewFindings: plan.lastReviewFindings ?? null,
    pipeline: plan.pipeline ? { ...defaultPipeline, ...plan.pipeline } : defaultPipeline,
  };
}

/**
 * Whether the issue has a review failure that execute must still address,
 * even if every userStories[].passes is already true.
 */
export function hasPendingCorrection(plan: TaskPlan): boolean {
  return Boolean(plan.lastReviewFindings);
}

/**
 * Check if all user stories have passes=true.
 * Returns false if there are no stories.
 */
export function allStoriesPass(plan: TaskPlan): boolean {
  if (plan.userStories.length === 0) {
    return false;
  }

  return plan.userStories.every((story) => story.passes === true);
}

/**
 * The story `execute` should work on next: the highest-priority (lowest
 * `priority` number) story with `passes: false`. This is the exact same rule
 * `prompts/execute.md` gives the agent ("pick the highest priority user
 * story where `passes: false`") — kept here as a single, pure, exported
 * helper so the engine's `iteration:start` publication and the terminal
 * renderer read the same computed identity instead of two independent
 * heuristics.
 *
 * Pure: never mutates `stories`. Returns `undefined` when every story
 * already passes (or the plan has none).
 */
export function selectActiveStory(stories: readonly UserStory[]): UserStory | undefined {
  return [...stories].filter((story) => !story.passes).sort((a, b) => a.priority - b.priority)[0];
}

/**
 * Mark a specific story as passing.
 */
export function markStoryPassing(plan: TaskPlan, storyId: string): TaskPlan {
  return {
    ...plan,
    userStories: plan.userStories.map((story) =>
      story.id === storyId ? { ...story, passes: true } : story,
    ),
  };
}

/**
 * Accumulate a usage share (and duration) onto the given stories.
 *
 * Pure, like the rest of this module: returns a new plan and never touches the
 * input. Accumulation is summing and treats `undefined` as "not reported": a
 * field neither the story nor the share carries stays absent, so a plan written
 * by a CLI that reports no usage never gains artificial zeros.
 *
 * The share is what `divideUsage()` already split across the stories that
 * completed in the same execute iteration — see core/engine.ts.
 */
export function applyStoryMetrics(
  plan: TaskPlan,
  storyIds: string[],
  share: ClaudeUsage,
  durationSeconds?: number,
): TaskPlan {
  if (storyIds.length === 0) return plan;

  const targets = new Set(storyIds);

  return {
    ...plan,
    userStories: plan.userStories.map((story) => {
      if (!targets.has(story.id)) return story;

      const updated: UserStory = { ...story, ...sumUsage(story, share) };
      if (story.durationSeconds !== undefined || durationSeconds !== undefined) {
        updated.durationSeconds = (story.durationSeconds ?? 0) + (durationSeconds ?? 0);
      }
      return updated;
    }),
  };
}

/**
 * Mark the issue as in_progress.
 */
export function markIssueInProgress(plan: TaskPlan, timestamp?: string): TaskPlan {
  const ts = timestamp ?? isoNow();
  return {
    ...plan,
    issueStatus: 'in_progress',
    completedAt: null,
    lastAttemptAt: ts,
  };
}

/**
 * Mark the issue as completed.
 */
export function markIssueCompleted(plan: TaskPlan): TaskPlan {
  const ts = isoNow();
  return {
    ...plan,
    issueStatus: 'completed',
    completedAt: ts,
    lastAttemptAt: ts,
    lastError: null,
    pipeline: plan.pipeline ? { ...plan.pipeline, executionCompleted: true } : plan.pipeline,
  };
}

/**
 * Set the lastError field on the task plan.
 */
export function setLastError(plan: TaskPlan, category: string, message: string): TaskPlan {
  const ts = isoNow();
  const error: LastError = {
    category,
    message,
    at: ts,
  };

  return {
    ...plan,
    lastAttemptAt: ts,
    lastError: error,
  };
}

/**
 * Clear the lastError field, but only if it was set before the attempt started.
 * This prevents clearing errors that were set during the current attempt.
 */
export function clearLastError(plan: TaskPlan, attemptStartedAt: string): TaskPlan {
  const ts = isoNow();

  // If the error was set after the attempt started, keep it
  if (plan.lastError && plan.lastError.at > attemptStartedAt) {
    return {
      ...plan,
      lastAttemptAt: ts,
    };
  }

  return {
    ...plan,
    lastAttemptAt: ts,
    lastError: null,
  };
}

/**
 * Trim an error message to at most 8 non-empty lines.
 */
export function trimErrorMessage(message: string): string {
  return message
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(0, 8)
    .join('\n');
}
