import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ZodError } from 'zod';
import { isoNow } from '../core/state-manager.js';
import type { DependencyGraph } from '../issues/graph.js';
import type { Issue } from '../issues/types.js';
import { executionPlanSchema } from '../storage/schemas.js';
import type { LastError, PullRequestRef } from '../types.js';
import { writeFileAtomic } from '../utils/fs.js';
import { priorityOf } from './order.js';
import type {
  ExecutionPlan,
  ExecutionPlanExcluded,
  ExecutionPlanIssue,
  QueueStatus,
} from './types.js';

/**
 * Building, reading, writing and advancing the execution plan of a queue.
 *
 * The plan is the only state a multi-issue run adds to the storage tree, and it
 * is written **only** for a queue with more than one Issue — a single-issue run
 * leaves the layout exactly as it was.
 */

export interface BuildExecutionPlanInput {
  /** Project id of the global storage tree. */
  projectId: string;
  /** Identifiers the user asked for, in order; the first one names the queue. */
  requested: readonly string[];
  graph: DependencyGraph;
  /** Ids to run, already ordered by `computeExecutionOrder`. */
  order: readonly string[];
  noBranch?: boolean;
  prReview?: boolean;
  /** Injectable clock, so tests can assert `createdAt` vs `updatedAt`. */
  now?: () => string;
}

/** Title/url/number of a node, falling back to what the id alone tells us. */
function describeIssue(
  issue: Issue | null,
  id: string,
): {
  number: number | null;
  title: string;
  url: string | null;
  source: string;
} {
  const parsed = Number.parseInt(id, 10);
  return {
    number: issue?.number ?? (Number.isNaN(parsed) ? null : parsed),
    title: issue?.title ?? '',
    url: issue?.remoteRef ?? null,
    source: issue?.source ?? 'github',
  };
}

/**
 * Turn a graph plus an order into the persisted plan.
 *
 * Every Issue of the graph that is *not* in the order becomes an `excluded`
 * entry: the consolidated Pull Request reports them as known pending work, so a
 * hierarchy the user chose to trim never disappears silently.
 */
export function buildExecutionPlan(input: BuildExecutionPlanInput): ExecutionPlan {
  const now = input.now ?? isoNow;
  const at = now();
  const scheduled = new Set(input.order);
  const requested = new Set(input.requested);

  const issues: ExecutionPlanIssue[] = input.order.map((id, index) => {
    const node = input.graph.nodes.get(id);
    const relations = node?.relations;
    const described = describeIssue(node?.issue ?? null, id);

    return {
      id,
      number: described.number,
      title: described.title,
      url: described.url,
      source: described.source,
      position: index + 1,
      status: 'pending',
      origin: requested.has(id) ? 'requested' : 'discovered',
      // Only the constraints that survive inside the queue: a blocker left out
      // of it is reported in `excluded`, not enforced as a dependency.
      dependsOn: (relations?.blockedBy ?? []).filter((blocker) => scheduled.has(blocker)),
      parent: relations?.parent ?? null,
      priority: priorityOf(node?.issue?.labels ?? []),
      heuristic: (relations?.heuristic.length ?? 0) > 0,
      failedPhase: null,
      lastError: null,
      attempts: 0,
      blockedReason: null,
      startedAt: null,
      completedAt: null,
    };
  });

  const excluded: ExecutionPlanExcluded[] = [];
  for (const node of input.graph.nodes.values()) {
    if (scheduled.has(node.id)) continue;
    const described = describeIssue(node.issue, node.id);
    excluded.push({
      id: node.id,
      number: described.number,
      title: described.title,
      url: described.url,
      reason: 'Discovered in the hierarchy but not selected for this run',
    });
  }

  return {
    schemaVersion: 1,
    id: input.requested[0] ?? (input.order[0] as string),
    project: input.projectId,
    requested: [...input.requested],
    branchName: null,
    noBranch: input.noBranch ?? false,
    prReview: input.prReview ?? false,
    status: 'pending',
    createdAt: at,
    updatedAt: at,
    truncated: input.graph.truncated,
    issues,
    excluded,
  };
}

/** Read a persisted plan. Throws with the offending fields on invalid content. */
export async function loadExecutionPlan(path: string): Promise<ExecutionPlan> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf-8'));

  try {
    return executionPlanSchema.parse(raw) as ExecutionPlan;
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Invalid execution-plan.json at ${path}:\n${issues}`);
    }
    throw err;
  }
}

/**
 * Persist a plan atomically, creating the queue directory on first write.
 *
 * `updatedAt` is stamped here so no call site can forget it — the file is the
 * only record of how far a queue got, and a stale timestamp on it is worse than
 * none.
 */
export async function saveExecutionPlan(
  path: string,
  plan: ExecutionPlan,
  now: () => string = isoNow,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const stamped: ExecutionPlan = { ...plan, updatedAt: now() };
  await writeFileAtomic(path, `${JSON.stringify(stamped, null, 2)}\n`);
}

/**
 * The Issue the queue should work on next, or `null` when every one of them is
 * completed.
 *
 * The order of the lookups *is* the resume policy: an interrupted issue
 * (`in_progress`) and a failed one are retried before the queue moves on, and
 * each of them picks up from its own `tasks.json` (phase-level resume) rather
 * than from the start. A `completed` issue is never revisited — that is the
 * whole point of persisting the queue.
 */
export function nextQueueIssue(plan: ExecutionPlan): ExecutionPlanIssue | null {
  return (
    plan.issues.find((entry) => entry.status === 'in_progress') ??
    plan.issues.find((entry) => entry.status === 'failed') ??
    plan.issues.find((entry) => entry.status === 'pending') ??
    null
  );
}

/** Status of the queue derived from its entries. */
export function queueStatus(plan: ExecutionPlan): QueueStatus {
  if (plan.issues.some((entry) => entry.status === 'failed')) return 'failed';
  if (plan.issues.every((entry) => entry.status === 'completed')) return 'completed';
  if (plan.issues.some((entry) => entry.status !== 'pending')) return 'in_progress';
  return 'pending';
}

/** Whether every Issue of the queue has been resolved. */
export function isQueueComplete(plan: ExecutionPlan): boolean {
  return plan.issues.every((entry) => entry.status === 'completed');
}

/** Apply `patch` to one entry and recompute the queue status. Pure. */
function updateIssue(
  plan: ExecutionPlan,
  id: string,
  patch: Partial<ExecutionPlanIssue>,
): ExecutionPlan {
  const issues = plan.issues.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  const next: ExecutionPlan = { ...plan, issues };
  return { ...next, status: queueStatus(next) };
}

export function markQueueIssueInProgress(
  plan: ExecutionPlan,
  id: string,
  now: () => string = isoNow,
): ExecutionPlan {
  const current = plan.issues.find((entry) => entry.id === id);
  return updateIssue(plan, id, {
    status: 'in_progress',
    // Preserved across a resume: the queue reports when the work on this Issue
    // really began, not when it was last picked up.
    startedAt: current?.startedAt ?? now(),
    failedPhase: null,
    lastError: null,
  });
}

export function markQueueIssueCompleted(
  plan: ExecutionPlan,
  id: string,
  now: () => string = isoNow,
): ExecutionPlan {
  return updateIssue(plan, id, {
    status: 'completed',
    completedAt: now(),
    failedPhase: null,
    lastError: null,
  });
}

export function markQueueIssueFailed(
  plan: ExecutionPlan,
  id: string,
  failure: { phase: string | null; error: LastError | null },
): ExecutionPlan {
  return updateIssue(plan, id, {
    status: 'failed',
    failedPhase: failure.phase,
    lastError: failure.error,
  });
}

/** Record the branch every Issue of the queue shares. */
export function setQueueBranch(plan: ExecutionPlan, branchName: string): ExecutionPlan {
  return { ...plan, branchName };
}

/** Record the single Pull Request that consolidated the queue. */
export function setQueuePullRequest(
  plan: ExecutionPlan,
  pullRequest: PullRequestRef,
): ExecutionPlan {
  return { ...plan, pullRequest };
}
