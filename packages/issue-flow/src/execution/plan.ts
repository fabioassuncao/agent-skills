import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ZodError } from 'zod';
import { isoNow } from '../core/state-manager.js';
import type { DependencyGraph } from '../issues/graph.js';
import type { Issue } from '../issues/types.js';
import { getQueueRepository, loadStoredQueue, saveStoredQueue } from '../storage/db/repository.js';
import { executionPlanSchema } from '../storage/schemas.js';
import type { LastError, PullRequestRef } from '../types.js';
import { writeFileAtomic } from '../utils/fs.js';
import { isContainer } from './containers.js';
import { priorityOf } from './order.js';
import type {
  ExecutionPlan,
  ExecutionPlanExcluded,
  ExecutionPlanIssue,
  QueueIssueRole,
  QueueIssueStatus,
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

function parentOf(graph: DependencyGraph, id: string): string | null {
  for (const node of graph.nodes.values()) {
    if (node.relations.children.includes(id)) return node.id;
  }
  return null;
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
    const children = relations?.children ?? [];
    const role: QueueIssueRole = isContainer({
      issue: node?.issue ?? null,
      children,
    })
      ? 'container'
      : 'executable';

    return {
      id,
      number: described.number,
      title: described.title,
      url: described.url,
      source: described.source,
      position: index + 1,
      status: 'pending',
      origin: requested.has(id) ? 'requested' : 'discovered',
      role,
      externalDependencies: (relations?.blockedBy ?? []).filter(
        (blocker) =>
          !scheduled.has(blocker) && input.graph.nodes.get(blocker)?.issue?.state !== 'closed',
      ),
      // Only the constraints that survive inside the queue: a blocker left out
      // of it is reported in `excluded`, not enforced as a dependency.
      dependsOn: (relations?.blockedBy ?? []).filter((blocker) => scheduled.has(blocker)),
      parent: relations?.parent ?? parentOf(input.graph, id),
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
      reason:
        node.issue?.state === 'closed'
          ? 'Already closed before this run'
          : 'Discovered in the hierarchy but not selected for this run',
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
  const repository = getQueueRepository(path);
  if (repository !== undefined) {
    const stored = await loadStoredQueue(repository);
    if (stored !== null) return stored;
  }
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
  const stamped: ExecutionPlan = { ...plan, updatedAt: now() };
  const repository = getQueueRepository(path);
  if (repository !== undefined) {
    await saveStoredQueue(repository, stamped);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
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
export interface NextQueueIssueOptions {
  /**
   * Ids this invocation is done with, however they ended. A queue that skips a
   * failing Issue and comes back to it needs a way to say "not this one again",
   * or "come back later" becomes "come back forever".
   */
  exclude?: ReadonlySet<string>;
}

/**
 * Whether every dependency this Issue declares *inside the queue* is finished.
 *
 * The execution order already places dependencies first, so this only bites
 * once an entry stops being `completed` — skipped, blocked or failed. Handing
 * out an Issue whose blocker was skipped is how a queue produces work that
 * cannot compile.
 */
function dependenciesSatisfied(plan: ExecutionPlan, entry: ExecutionPlanIssue): boolean {
  return entry.dependsOn.every((id) => {
    const dependency = plan.issues.find((candidate) => candidate.id === id);
    if (dependency === undefined) return true;
    // A container is not work: waiting on it would deadlock the children
    // that complete it.
    if (dependency.role === 'container') return true;
    return dependency.status === 'completed';
  });
}

/**
 * The Issue to work on next.
 *
 * The order of the four lookups is the resumption policy:
 * an interrupted Issue first (it was mid-flight), then one that failed on a
 * previous invocation, then the untouched ones, and only at the end the ones
 * this queue deliberately set aside — which is what "go on with the
 * independent work and come back to it" means in one line.
 *
 * `blocked` is absent on purpose: it needs a human, and no ordering of the
 * queue changes that.
 */
export function nextQueueIssue(
  plan: ExecutionPlan,
  options: NextQueueIssueOptions = {},
): ExecutionPlanIssue | null {
  const exclude = options.exclude ?? new Set<string>();
  const eligible = (status: QueueIssueStatus) => (entry: ExecutionPlanIssue) =>
    entry.role !== 'container' &&
    entry.status === status &&
    !exclude.has(entry.id) &&
    dependenciesSatisfied(plan, entry);

  return (
    plan.issues.find(eligible('in_progress')) ??
    plan.issues.find(eligible('failed')) ??
    plan.issues.find(eligible('pending')) ??
    plan.issues.find(eligible('skipped')) ??
    null
  );
}

/**
 * Status of the queue derived from its entries.
 *
 * `skipped` is *not* terminal — the queue means to come back to it — so a queue
 * holding one is still `in_progress`. `blocked` is: nothing the queue can do
 * moves it, so a queue that ends with one ends `failed`, which is what a person
 * needs to see.
 */
export function queueStatus(plan: ExecutionPlan): QueueStatus {
  if (plan.issues.some((entry) => entry.status === 'failed' || entry.status === 'blocked')) {
    return 'failed';
  }
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

function completeResolvedContainers(plan: ExecutionPlan, now: () => string): ExecutionPlan {
  let next = plan;
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of next.issues) {
      if (entry.role !== 'container' || entry.status === 'completed') continue;
      const children = next.issues.filter((candidate) => candidate.parent === entry.id);
      if (children.length === 0) continue;
      if (children.every((child) => child.status === 'completed')) {
        next = updateIssue(next, entry.id, {
          status: 'completed',
          completedAt: now(),
          failedPhase: null,
          lastError: null,
        });
        changed = true;
      }
    }
  }
  return next;
}

export function markQueueIssueCompleted(
  plan: ExecutionPlan,
  id: string,
  now: () => string = isoNow,
): ExecutionPlan {
  return completeResolvedContainers(
    updateIssue(plan, id, {
      status: 'completed',
      completedAt: now(),
      failedPhase: null,
      lastError: null,
    }),
    now,
  );
}

export function markQueueIssueFailed(
  plan: ExecutionPlan,
  id: string,
  failure: { phase: string | null; error: LastError | null },
): ExecutionPlan {
  const current = plan.issues.find((entry) => entry.id === id);
  return updateIssue(plan, id, {
    status: 'failed',
    failedPhase: failure.phase,
    lastError: failure.error,
    attempts: (current?.attempts ?? 0) + 1,
  });
}

/**
 * Set an Issue aside and come back to it later.
 *
 * The difference from `failed` is the whole point of `--on-issue-failure skip`:
 * a failure that stopped this attempt is not a verdict on the eleven other
 * Issues in the queue, and `skipped` is the status that says "not now" rather
 * than "not at all". `attempts` is incremented here because the counter is what
 * keeps "come back later" from becoming "come back forever".
 */
export function markQueueIssueSkipped(
  plan: ExecutionPlan,
  id: string,
  failure: { phase: string | null; error: LastError | null },
): ExecutionPlan {
  const current = plan.issues.find((entry) => entry.id === id);
  return updateIssue(plan, id, {
    status: 'skipped',
    failedPhase: failure.phase,
    lastError: failure.error,
    attempts: (current?.attempts ?? 0) + 1,
  });
}

/**
 * Stop working on an Issue until a person looks at it.
 *
 * `blocked` is never handed back out by `nextQueueIssue`: waiting cannot fix
 * a missing credential or a repository mid-rebase, and a queue that could
 * unblock itself would spin on the same cause forever.
 */
export function markQueueIssueBlocked(
  plan: ExecutionPlan,
  id: string,
  reason: string,
  failure: { phase: string | null; error: LastError | null },
): ExecutionPlan {
  const current = plan.issues.find((entry) => entry.id === id);
  return updateIssue(plan, id, {
    status: 'blocked',
    blockedReason: reason,
    failedPhase: failure.phase,
    lastError: failure.error,
    attempts: (current?.attempts ?? 0) + 1,
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

/** Completed implementation can still owe PR delivery, review or explicit closure. */
export function queueNeedsFinalization(plan: ExecutionPlan): boolean {
  return (
    (!plan.noBranch && (!plan.pullRequest || (plan.prReview && !plan.prReviewCompleted))) ||
    (plan.closeIssue === true &&
      plan.issues.some(
        (entry) => entry.status === 'completed' && !(plan.closedIssueIds ?? []).includes(entry.id),
      ))
  );
}
