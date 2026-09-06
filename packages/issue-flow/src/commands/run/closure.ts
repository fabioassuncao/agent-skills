import { PIPELINE_PHASES, PipelineManager, type PipelinePhase } from '../../core/pipeline.js';
import { allStoriesPass, isoNow, loadTaskPlan, saveTaskPlan } from '../../core/state-manager.js';
import { getProvider } from '../../issues/registry.js';
import type { IssueSource } from '../../issues/types.js';
import type { TaskPlan } from '../../types.js';
import { printError } from '../../ui/logger.js';

export function requestedPhasesComplete(plan: TaskPlan): boolean {
  const phases: PipelinePhase[] = PIPELINE_PHASES.filter(
    (phase) => !plan.noBranch || phase !== 'pr',
  );
  if (plan.prReview?.enabled && !plan.noBranch) phases.push('pr-review');
  return (
    plan.userStories.length > 0 &&
    new PipelineManager(plan, '', phases).getNextPhase() === null &&
    allStoriesPass(plan) &&
    !plan.lastReviewFindings
  );
}

/** Re-query uncertain closes: a retry never assumes a failed response means no mutation. */
export async function closeAndConfirm(id: string, source: IssueSource): Promise<void> {
  const provider = getProvider(source);
  if ((await provider.get(id))?.state === 'closed') return;
  if (!provider.close) throw new Error(`Provider ${source} cannot close issues`);
  await provider.close(id);
  if ((await provider.get(id))?.state !== 'closed')
    throw new Error(`Could not confirm closure of ${id}`);
}

/** CLI-owned authorization; a false flag revokes a persisted choice. */
export async function persistClosureChoice(
  path: string,
  choice: boolean | undefined,
): Promise<void> {
  if (choice === undefined) return;
  const plan = await loadTaskPlan(path);
  plan.closeIssue = choice;
  await saveTaskPlan(path, plan);
}

export async function finishIssueClosure(
  path: string,
  id: string,
  source: IssueSource,
): Promise<number> {
  const plan = await loadTaskPlan(path);
  if (!requestedPhasesComplete(plan)) return 1;
  if (plan.closeIssue && !plan.issueClosedAt) {
    try {
      await closeAndConfirm(id, source);
      plan.issueClosedAt = isoNow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      plan.lastError = { category: 'issue_closure', message, at: isoNow() };
      plan.issueStatus = 'in_progress';
      plan.completedAt = null;
      await saveTaskPlan(path, plan);
      printError(`Delivery complete; issue closure pending: ${message}`);
      return 1;
    }
  }
  plan.issueStatus = 'completed';
  plan.completedAt ??= isoNow();
  if (plan.lastError?.category === 'issue_closure') plan.lastError = null;
  await saveTaskPlan(path, plan);
  return 0;
}
