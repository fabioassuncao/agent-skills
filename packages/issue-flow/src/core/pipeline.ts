import type { PipelineState, TaskPlan } from '../types.js';
import { loadTaskPlan, saveTaskPlan } from './state-manager.js';

/**
 * Ordered pipeline phases. Each phase must complete before the next can start.
 *
 * `pr-review` is deliberately NOT here: it is opt-in via `--pr-review`. Adding
 * it to the default set would make every existing `tasks.json` (which has no
 * `prReviewCompleted`) look unfinished, so `getNextPhase()` would resume into a
 * phase the user never asked for.
 */
export const PIPELINE_PHASES = ['init', 'prd', 'plan', 'execute', 'review', 'pr'] as const;

/**
 * The default set plus the opt-in `pr-review` phase, used when the user passes
 * `--pr-review` (or the flag was persisted in `plan.prReview.enabled`).
 */
export const PIPELINE_PHASES_WITH_PR_REVIEW = [...PIPELINE_PHASES, 'pr-review'] as const;

export type PipelinePhase = (typeof PIPELINE_PHASES_WITH_PR_REVIEW)[number];

/**
 * Pipeline phases excluding the 'pr' phase, for --no-branch mode.
 * `pr-review` is excluded too: without a branch there is no PR to review.
 */
export const PIPELINE_PHASES_NO_BRANCH = PIPELINE_PHASES.filter(
  (p): p is Exclude<PipelinePhase, 'pr' | 'pr-review'> => p !== 'pr',
);

/**
 * Map pipeline phases to their corresponding PipelineState field.
 * 'init' has no persisted state — it's a runtime-only check.
 */
const PHASE_TO_FIELD: Record<PipelinePhase, keyof PipelineState | null> = {
  init: null,
  prd: 'prdCompleted',
  plan: 'jsonCompleted',
  execute: 'executionCompleted',
  review: 'reviewCompleted',
  pr: 'prCreated',
  'pr-review': 'prReviewCompleted',
};

export class PipelineManager {
  private tasksJsonPath: string;
  private plan: TaskPlan;
  private activePhases: readonly PipelinePhase[];

  constructor(plan: TaskPlan, tasksJsonPath: string, activePhases?: readonly PipelinePhase[]) {
    this.plan = plan;
    this.tasksJsonPath = tasksJsonPath;
    this.activePhases = activePhases ?? PIPELINE_PHASES;
  }

  /**
   * Reload state from disk.
   */
  async reload(): Promise<void> {
    this.plan = await loadTaskPlan(this.tasksJsonPath);
  }

  /**
   * Check if a phase is complete.
   */
  isPhaseComplete(phase: PipelinePhase): boolean {
    const field = PHASE_TO_FIELD[phase];
    if (field === null) return true; // init is always "complete" after running
    return this.plan.pipeline?.[field] ?? false;
  }

  /**
   * Get the first incomplete phase in the pipeline.
   * Returns null if all phases are complete.
   */
  getNextPhase(): PipelinePhase | null {
    for (const phase of this.activePhases) {
      if (!this.isPhaseComplete(phase)) {
        return phase;
      }
    }
    return null;
  }

  /**
   * Get the current phase (alias for getNextPhase).
   */
  getCurrentPhase(): PipelinePhase | null {
    return this.getNextPhase();
  }

  /**
   * Check whether we can resume from a specific phase.
   * All prerequisite phases must be complete.
   */
  canResume(fromPhase: PipelinePhase): boolean {
    const idx = this.activePhases.indexOf(fromPhase);
    if (idx < 0) return false;

    // All active phases before fromPhase must be complete
    for (let i = 0; i < idx; i++) {
      if (!this.isPhaseComplete(this.activePhases[i])) {
        return false;
      }
    }
    return true;
  }

  /**
   * Mark a phase as complete and persist to disk.
   */
  async markPhaseComplete(phase: PipelinePhase): Promise<void> {
    const field = PHASE_TO_FIELD[phase];
    if (field === null) return; // init has no persisted state

    this.plan = {
      ...this.plan,
      pipeline: {
        ...(this.plan.pipeline ?? {
          prdCompleted: false,
          jsonCompleted: false,
          executionCompleted: false,
          reviewCompleted: false,
          prCreated: false,
        }),
        [field]: true,
      },
    };

    await saveTaskPlan(this.tasksJsonPath, this.plan);
  }
}
