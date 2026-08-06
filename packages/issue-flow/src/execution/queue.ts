import type { Issue, IssueSource } from '../issues/types.js';
import { printInfo, printWarning } from '../ui/logger.js';
import { type ConfirmQueueOptions, confirmQueue, QueueConfirmationError } from './confirm.js';
import { discoverIssueGraph, supportsRelations } from './discovery.js';
import { computeExecutionOrder, describeCycles } from './order.js';
import {
  buildExecutionPlan,
  isQueueComplete,
  loadExecutionPlan,
  saveExecutionPlan,
} from './plan.js';
import type { ExecutionPlan } from './types.js';

/**
 * Deciding, before any phase runs, whether this invocation is a single-issue
 * pipeline or a queue — and, when it is a queue, what exactly it will run.
 *
 * Everything here happens *before* the session starts, so a run that turns out
 * to be a plain single-issue pipeline is indistinguishable from what the CLI
 * did before this feature existed: no prompt, no artifact, no extra output.
 */

export type QueueDecision =
  /** Nothing to coordinate: run the single issue exactly as before. */
  | { kind: 'single' }
  | { kind: 'queue'; plan: ExecutionPlan; resumed: boolean }
  /** The run must stop; `code` is what the CLI returns. */
  | { kind: 'stop'; code: number };

export interface PlanQueueInput {
  /** Identifiers the user asked for, in order. */
  requested: string[];
  /** Origin the run resolved, used to ask the right provider about relations. */
  source: IssueSource;
  /** Issues already resolved by the caller, so the roots are not re-read. */
  known: Issue[];
  projectId: string;
  /** Where the queue's `execution-plan.json` lives. */
  planFile: string;
  noBranch: boolean;
  prReview: boolean;
  /** `--yes` / `--only`, forwarded to the confirmation. */
  confirm?: ConfirmQueueOptions;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

/** A persisted queue that matches this invocation, or `null`. */
async function loadResumableQueue(
  planFile: string,
  requested: readonly string[],
): Promise<ExecutionPlan | null> {
  let plan: ExecutionPlan;
  try {
    plan = await loadExecutionPlan(planFile);
  } catch {
    // Absent (the common case) or unreadable: plan the queue from scratch. A
    // corrupted file must not strand the user — the plan is derived state.
    return null;
  }

  // The stored queue answers a different question than the one being asked.
  const sameRequest =
    plan.requested.length === requested.length &&
    plan.requested.every((id, index) => id === requested[index]);

  return sameRequest ? plan : null;
}

/**
 * Work out what this invocation runs.
 *
 * The order of the checks is what keeps the feature additive:
 *
 * 1. an unfinished queue for the very same request is resumed, never
 *    re-confirmed — the user already answered that question;
 * 2. `--only` with a single issue skips discovery altogether, so an automation
 *    that knows what it wants pays nothing for the feature;
 * 3. discovery runs; if it finds nothing beyond the requested issue, the run
 *    stays single-issue and no artifact is created;
 * 4. only a genuinely larger structure reaches the confirmation.
 */
export async function planQueue(input: PlanQueueInput): Promise<QueueDecision> {
  const info = input.info ?? printInfo;
  const warn = input.warn ?? printWarning;
  const single = input.requested.length === 1;

  const resumable = await loadResumableQueue(input.planFile, input.requested);
  if (resumable !== null && !isQueueComplete(resumable)) {
    const done = resumable.issues.filter((entry) => entry.status === 'completed').length;
    info(
      `Resuming the execution queue of issue #${resumable.id}: ` +
        `${done}/${resumable.issues.length} issues already completed.`,
    );
    return { kind: 'queue', plan: resumable, resumed: true };
  }

  // `--only` on a single issue is the explicit "do not look around" answer.
  if (single && input.confirm?.only === true) {
    return { kind: 'single' };
  }

  if (single && !supportsRelations(input.source)) {
    // An origin with no notion of related Issues (the local provider) can only
    // ever produce a single-issue run.
    return { kind: 'single' };
  }

  const graph = await discoverIssueGraph(input.requested, {
    source: input.source,
    known: input.known,
    warn,
  });

  if (single && graph.nodes.size <= 1) {
    return { kind: 'single' };
  }

  const suggested = computeExecutionOrder(graph);
  if (!suggested.ok) {
    warn(
      `Dependency cycle between issues: ${describeCycles(suggested.cycles)}. ` +
        'Fix the dependencies on GitHub, or re-run with --only to execute just the issues you informed.',
    );
    return { kind: 'stop', code: 1 };
  }

  const requestedOrder = computeExecutionOrder(graph, { include: input.requested });
  const requestedCount = requestedOrder.ok ? requestedOrder.order.length : input.requested.length;

  const suggestedPlan = buildExecutionPlan({
    projectId: input.projectId,
    requested: input.requested,
    graph,
    order: suggested.order,
    noBranch: input.noBranch,
    prReview: input.prReview,
  });

  let choice: 'all' | 'requested' | 'cancel';
  try {
    choice = await confirmQueue(suggestedPlan, requestedCount, input.confirm ?? {});
  } catch (err) {
    if (err instanceof QueueConfirmationError) {
      warn(err.message);
      return { kind: 'stop', code: err.exitCode };
    }
    throw err;
  }

  if (choice === 'cancel') {
    info('Cancelled: nothing was executed.');
    return { kind: 'stop', code: 1 };
  }

  let plan = suggestedPlan;
  if (choice === 'requested') {
    if (!requestedOrder.ok) {
      warn(
        `Dependency cycle between the issues you informed: ${describeCycles(requestedOrder.cycles)}.`,
      );
      return { kind: 'stop', code: 1 };
    }
    // A single issue after trimming is not a queue at all: fall back to the
    // untouched single-issue pipeline instead of creating an artifact for it.
    if (requestedOrder.order.length <= 1) {
      return { kind: 'single' };
    }
    plan = buildExecutionPlan({
      projectId: input.projectId,
      requested: input.requested,
      graph,
      order: requestedOrder.order,
      noBranch: input.noBranch,
      prReview: input.prReview,
    });
  }

  await saveExecutionPlan(input.planFile, plan);
  return { kind: 'queue', plan, resumed: false };
}
