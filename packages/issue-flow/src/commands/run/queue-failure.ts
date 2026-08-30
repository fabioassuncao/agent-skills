import { isoNow } from '../../core/state-manager.js';
import {
  markQueueIssueBlocked,
  markQueueIssueFailed,
  markQueueIssueSkipped,
  type nextQueueIssue,
  saveExecutionPlan,
} from '../../execution/plan.js';
import type { ExecutionPlan } from '../../execution/types.js';
import { printError, printInfo, printWarning } from '../../ui/logger.js';
import type { IssueRunResult, QueueFailureMode } from './types.js';

export async function handleQueueIssueFailure(input: {
  plan: ExecutionPlan;
  planFile: string;
  entry: NonNullable<ReturnType<typeof nextQueueIssue>>;
  result: IssueRunResult;
  failureMode: QueueFailureMode;
  maxIssueAttempts: number;
  exhausted: Set<string>;
  failedIds: Set<string>;
}): Promise<{ action: 'stop'; code: number } | { action: 'continue'; plan: ExecutionPlan }> {
  let plan = input.plan;
  const { planFile, entry, result, failureMode, maxIssueAttempts, exhausted, failedIds } = input;
  const failure = {
    phase: result.failedPhase,
    error: {
      category: 'queue_issue_failed',
      message: `Issue #${entry.id} failed${result.failedPhase === null ? '' : ` in phase ${result.failedPhase}`}`,
      at: isoNow(),
    },
  };
  const where = result.failedPhase === null ? '' : ` (phase ${result.failedPhase})`;

  if (failureMode === 'stop') {
    plan = markQueueIssueFailed(plan, entry.id, failure);
    await saveExecutionPlan(planFile, plan);
    printError(
      `Queue stopped at issue #${entry.id}${where}. ` +
        'The branch and every commit made so far were kept.',
    );
    printInfo(`Resume with: issue-flow run ${plan.requested.join(',')}`);
    return { action: 'stop', code: result.code };
  }

  if (failureMode === 'block') {
    plan = markQueueIssueBlocked(
      plan,
      entry.id,
      `Failed${where} and --on-issue-failure block was in force`,
      failure,
    );
    await saveExecutionPlan(planFile, plan);
    exhausted.add(entry.id);
    failedIds.add(entry.id);
    printWarning(
      `Issue #${entry.id} failed${where} and is blocked for review. Continuing with the rest of the queue.`,
    );
    return { action: 'continue', plan };
  }

  const attempts = entry.attempts + 1;
  if (attempts >= maxIssueAttempts) {
    plan = markQueueIssueFailed(plan, entry.id, failure);
    exhausted.add(entry.id);
    failedIds.add(entry.id);
    printWarning(
      `Issue #${entry.id} failed${where} after ${attempts} attempt(s). Continuing with the rest of the queue.`,
    );
  } else {
    plan = markQueueIssueSkipped(plan, entry.id, failure);
    printWarning(
      `Issue #${entry.id} failed${where}. Skipping it for now and coming back at the end of the queue.`,
    );
  }
  await saveExecutionPlan(planFile, plan);
  return { action: 'continue', plan };
}
