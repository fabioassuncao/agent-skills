import { getProvider } from '../issues/registry.js';
import type { Issue, IssueSource } from '../issues/types.js';
import { printInfo, printWarning } from '../ui/logger.js';
import { type ConfirmQueueOptions, confirmQueue, QueueConfirmationError } from './confirm.js';
import { collectCascadeIds } from './containers.js';
import { discoverIssueGraph, supportsRelations } from './discovery.js';
import { computeExecutionOrder, describeCycles } from './order.js';
import {
  buildExecutionPlan,
  isQueueComplete,
  loadExecutionPlan,
  markQueueIssueCompleted,
  queueNeedsFinalization,
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
  closeIssue?: boolean;
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

/** `--only` / "just this issue" implements a requested container on purpose. */
function forceRequestedExecutable(plan: ExecutionPlan): ExecutionPlan {
  return {
    ...plan,
    issues: plan.issues.map((entry) =>
      plan.requested.includes(entry.id) ? { ...entry, role: 'executable' as const } : entry,
    ),
  };
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
 * Closed relations are context, not work. Keep explicitly requested Issues in
 * scope, but do not schedule an Issue that discovery found after it was
 * already resolved.
 *
 * An unreadable Issue stays eligible: discovery is best effort, and absence of
 * state must never silently discard work.
 */
function executableGraphIds(
  graph: Awaited<ReturnType<typeof discoverIssueGraph>>,
  requested: readonly string[],
): string[] {
  const roots = new Set(requested);
  return [...graph.nodes.values()]
    .filter((node) => roots.has(node.id) || node.issue?.state !== 'closed')
    .map((node) => node.id);
}

/**
 * A persisted queue may outlive one of its discovered Issues. Refresh only
 * unfinished, discovered entries and treat those now closed as satisfied, so
 * resuming an old plan cannot start already-resolved work.
 */
async function reconcileClosedDiscoveredIssues(
  plan: ExecutionPlan,
  warn: (message: string) => void,
): Promise<{ plan: ExecutionPlan; closed: string[] }> {
  let next = plan;
  const closed: string[] = [];

  for (const entry of plan.issues) {
    if (entry.origin !== 'discovered' || entry.status === 'completed') continue;

    try {
      const issue = await getProvider(entry.source).get(entry.id);
      if (issue?.state !== 'closed') continue;
      next = markQueueIssueCompleted(next, entry.id);
      closed.push(entry.id);
    } catch (err) {
      warn(
        `Could not refresh issue #${entry.id} before resuming the queue: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { plan: next, closed };
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

  let resumable = await loadResumableQueue(input.planFile, input.requested);
  if (resumable !== null) {
    if (input.closeIssue !== undefined) {
      resumable.closeIssue = input.closeIssue;
      await saveExecutionPlan(input.planFile, resumable);
    }
    const reconciled = await reconcileClosedDiscoveredIssues(resumable, warn);
    resumable = reconciled.plan;
    if (reconciled.closed.length > 0) {
      await saveExecutionPlan(input.planFile, resumable);
      info(
        `Skipping already closed issue(s) in the resumed queue: ${reconciled.closed
          .map((id) => `#${id}`)
          .join(', ')}.`,
      );
    }
  }
  // A queue that already finished has nothing left to run, and re-planning it
  // would overwrite its `execution-plan.json` — losing the Pull Request and
  // the record of what ran. Report it and stop successfully instead.
  if (resumable !== null && isQueueComplete(resumable) && !queueNeedsFinalization(resumable)) {
    const pr = resumable.pullRequest?.url;
    info(
      `The execution queue of issue #${resumable.id} is already complete ` +
        `(${resumable.issues.length} issues)${pr === undefined ? '' : ` — ${pr}`}. Nothing to run.`,
    );
    return { kind: 'stop', code: 0 };
  }
  if (resumable !== null) {
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

  const schedulable = executableGraphIds(graph, input.requested);
  const suggested = computeExecutionOrder(graph, { include: schedulable });
  if (!suggested.ok) {
    // A cycle anywhere in the discovered hierarchy must not take down a run
    // the user asked for on a single issue: they never opted into the
    // hierarchy, so degrade to the pipeline that has always worked and say
    // why. Only an explicitly multi-issue request is refused outright.
    if (single) {
      warn(
        `Dependency cycle between issues: ${describeCycles(suggested.cycles)}. ` +
          'Running just the issue you informed; fix the dependencies on GitHub to run the hierarchy.',
      );
      return { kind: 'single' };
    }
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

  // Closed discovered relations do not turn a normal single-Issue run into a
  // queue. A container is the exception: it still needs the explicit scope
  // decision that prevents an umbrella Issue from being implemented directly.
  if (
    single &&
    suggestedPlan.issues.length === 1 &&
    suggestedPlan.issues[0]?.role !== 'container'
  ) {
    return { kind: 'single' };
  }

  let choice: 'all' | 'requested' | 'cascade' | 'cancel';
  try {
    choice = await confirmQueue(suggestedPlan, requestedCount, {
      ...(input.confirm ?? {}),
      singleRequest: single,
    });
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
  if (choice === 'cascade') {
    const eligible = new Set(schedulable);
    const include = collectCascadeIds(graph, input.requested).filter((id) => eligible.has(id));
    const cascadeOrder = computeExecutionOrder(graph, { include });
    if (!cascadeOrder.ok) {
      warn(`Dependency cycle between issues: ${describeCycles(cascadeOrder.cycles)}.`);
      return { kind: 'stop', code: 1 };
    }
    if (
      cascadeOrder.order.filter(
        (id) => suggestedPlan.issues.find((entry) => entry.id === id)?.role !== 'container',
      ).length === 0
    ) {
      warn(
        `Issue #${input.requested[0]} is a container with no executable children in scope. ` +
          'Re-run with --only if you really want to implement it.',
      );
      return { kind: 'stop', code: 1 };
    }
    plan = buildExecutionPlan({
      projectId: input.projectId,
      requested: input.requested,
      graph,
      order: cascadeOrder.order,
      noBranch: input.noBranch,
      prReview: input.prReview,
    });
  } else if (choice === 'requested') {
    if (!requestedOrder.ok) {
      warn(
        `Dependency cycle between the issues you informed: ${describeCycles(requestedOrder.cycles)}.`,
      );
      return { kind: 'stop', code: 1 };
    }
    // A single issue after trimming is not a queue at all: fall back to the
    // untouched single-issue pipeline instead of creating an artifact for it.
    // But that fallback only makes sense when one issue was requested — with
    // several, trimming to one means the others never made it into the graph
    // (unreadable issue, node limit), and silently running a subset of what
    // the user asked for is worse than stopping.
    if (requestedOrder.order.length <= 1) {
      if (input.requested.length > 1) {
        const missing = input.requested.filter((id) => !requestedOrder.order.includes(id));
        warn(
          `Only issue #${requestedOrder.order[0] ?? '—'} of the ones you informed could be read; ` +
            `${missing.map((id) => `#${id}`).join(', ')} did not make it into the dependency graph. ` +
            'Nothing was executed — check the identifiers and try again.',
        );
        return { kind: 'stop', code: 1 };
      }
      return { kind: 'single' };
    }
    plan = forceRequestedExecutable(
      buildExecutionPlan({
        projectId: input.projectId,
        requested: input.requested,
        graph,
        order: requestedOrder.order,
        noBranch: input.noBranch,
        prReview: input.prReview,
      }),
    );
  }

  if (input.closeIssue !== undefined) plan.closeIssue = input.closeIssue;
  await saveExecutionPlan(input.planFile, plan);
  return { kind: 'queue', plan, resumed: false };
}
