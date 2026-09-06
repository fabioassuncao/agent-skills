import { loadTaskPlan, saveTaskPlan } from '../../core/state-manager.js';
import type { ExecutionPlan } from '../../execution/types.js';
import { resolveIssuePaths } from '../../storage/resolve.js';
import type { PullRequestRef } from '../../types.js';
import { printWarning } from '../../ui/logger.js';
import type { PrQueueContext } from '../pr.js';

/**
 * Whether the `pr` phase already ran for this queue, even if it could not
 * report a URL.
 *
 * `plan.pullRequest` on the queue is the happy path; this is the safety net for
 * the case where the phase succeeded but no URL could be parsed from its output
 * — re-running it on a resume would open a second Pull Request for the same
 * branch, which is exactly what the whole feature exists to avoid.
 */
export async function primaryPrCreated(plan: ExecutionPlan): Promise<boolean> {
  try {
    const paths = await resolveIssuePaths(plan.id);
    return (await loadTaskPlan(paths.tasksFile)).pipeline.prCreated;
  } catch {
    return false;
  }
}

/**
 * The context the consolidated Pull Request needs: what was implemented, in
 * which order, and what is knowingly left pending.
 *
 * "Pending" is the honest half of the report — the issues the user chose not to
 * run, and any review findings still recorded on an issue's plan. Both would
 * otherwise be invisible to whoever reviews the Pull Request.
 */
export async function buildPrQueueContext(plan: ExecutionPlan): Promise<PrQueueContext> {
  const pending: string[] = [];

  for (const entry of plan.issues) {
    try {
      const paths = await resolveIssuePaths(entry.id);
      const taskPlan = await loadTaskPlan(paths.tasksFile);
      if (taskPlan.lastReviewFindings !== null && taskPlan.lastReviewFindings !== '') {
        pending.push(`Issue #${entry.id} has unresolved review findings`);
      }
    } catch {
      // No plan on disk for this issue: nothing to report about it.
    }
  }

  return {
    issues: plan.issues.map((entry) => ({
      id: entry.id,
      number: entry.number,
      title: entry.title,
      url: entry.url,
      source: entry.source,
      parent: entry.parent,
      role: entry.role,
      complete: entry.status === 'completed',
    })),
    excluded: plan.excluded.map((entry) => ({
      id: entry.id,
      number: entry.number,
      title: entry.title,
      reason: entry.reason,
    })),
    pending,
  };
}

/**
 * Copy the Pull Request the `pr` phase recorded on the primary issue's plan
 * onto every other issue of the queue.
 *
 * The queue's `execution-plan.json` is the source of truth, but `pr-review`
 * discovers a Pull Request from `plan.pullRequest` in `tasks.json`
 * (`core/pr-review/discovery.ts`), so replicating it is what keeps
 * `pr-review --issue <any issue of the queue>` working without a special case.
 * A write that fails is reported and skipped: the Pull Request exists either
 * way, and the queue file already records it.
 */
export async function propagatePullRequest(plan: ExecutionPlan): Promise<PullRequestRef | null> {
  let pullRequest: PullRequestRef | null = null;
  try {
    const primaryPaths = await resolveIssuePaths(plan.id);
    pullRequest = (await loadTaskPlan(primaryPaths.tasksFile)).pullRequest ?? null;
  } catch {
    return null;
  }
  if (pullRequest === null) return null;

  for (const entry of plan.issues) {
    if (entry.id === plan.id) continue;
    try {
      const paths = await resolveIssuePaths(entry.id);
      const taskPlan = await loadTaskPlan(paths.tasksFile);
      taskPlan.pullRequest = pullRequest;
      taskPlan.pipeline.prCreated = true;
      await saveTaskPlan(paths.tasksFile, taskPlan);
    } catch {
      printWarning(`Could not record the Pull Request on issue #${entry.id}'s task plan.`);
    }
  }

  return pullRequest;
}
