import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRuntimeConfig } from '../config/runtime.js';
import { parseJournal } from '../core/journal.js';
import { PIPELINE_PHASES, PipelineManager, type PipelinePhase } from '../core/pipeline.js';
import { loadTaskPlan } from '../core/state-manager.js';
import { loadExecutionPlan, nextQueueIssue, queueNeedsFinalization } from '../execution/plan.js';
import { resolveCommandIssue } from '../issues/context.js';
import { acquireExecutionSlot, describeSlotRefusal } from '../runtime/concurrency.js';
import {
  listStoredIssueEvents,
  listStoredIssueIds,
  listStoredQueues,
} from '../storage/db/queries.js';
import { listHeldRuns, saveRunHumanHold } from '../storage/db/repository.js';
import { describeRunLockOwner, type RunLockHandle } from '../storage/lock.js';
import { getIssuePaths, QUEUES_DIR_NAME } from '../storage/paths.js';
import { resolveIssuePaths, resolveProjectPaths } from '../storage/resolve.js';
import type { TaskPlan } from '../types.js';
import { printError, printInfo, printWarning } from '../ui/logger.js';
import { describePreflight, preflightRepository } from '../utils/git.js';
import { finishIssueClosure, persistClosureChoice } from './run/closure.js';
import { runPipeline } from './run.js';

/**
 * `issue-flow resume` — explicit recovery.
 *
 * Resumption already worked before this command existed, but only *implicitly*:
 * the user re-ran the same `run` and the pipeline happened to pick up where it
 * left off, because `PipelineManager` skips the phases already marked complete
 * and `nextQueueIssue()` treats a stale `in_progress` as "do this one first".
 * That is a coincidence of two mechanisms, not a contract — nothing said what
 * had been interrupted, nothing checked whether the repository was still in a
 * state to continue, and nothing distinguished "carry on" from "start over".
 *
 * This command makes each of those steps explicit, in this order:
 *
 * 1. **ownership** — a live owner refuses, a dead one is taken over;
 * 2. **plans** — `execution-plan.json` for a queue, `tasks.json` for an issue;
 * 3. **the journal** — the last `phase:start` with no `phase:end` is what was
 *    running when the process died, which is the one fact no snapshot keeps;
 * 4. **the preflight** — the repository is described, and a state a human has to
 *    settle stops the resume instead of being repaired;
 * 5. **the phase** — `PipelineManager.getNextPhase()`, the same answer `run`
 *    has always used, now stated out loud before anything runs.
 *
 * `run` is untouched: its auto-resume still works exactly as it did.
 */

export interface ResumeOptions {
  closeIssue?: boolean;
  /** Resume every unfinished issue of the project, not just one. */
  all?: boolean;
  /** Execution mode handed to the pipeline. Same values as `run`. */
  mode?: string;
}

interface ResumeTarget {
  issue: string;
  projectId: string;
  storageDriver: 'sqlite' | 'json';
  plan: TaskPlan;
  tasksFile: string;
  eventsFile: string;
  rotatedEventsFile: string;
}

export async function runResume(issue?: string, options: ResumeOptions = {}): Promise<number> {
  const mode = options.mode ?? 'auto';

  let project: Awaited<ReturnType<typeof resolveProjectPaths>>;
  try {
    project = await resolveProjectPaths();
  } catch (err) {
    printError(`Cannot resume: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // 0. A run a person took over is **alive** and holding the lock on purpose:
  // the pipeline is waiting for them, the watchdog is paused, and no phase has
  // advanced. Resuming it means handing control back, not starting anything —
  // and it has to happen before the ownership check, which would otherwise
  // refuse with "another run owns this project" and be exactly wrong (§32).
  const released = await releaseHeldRuns(project, issue);
  if (released > 0) return 0;

  // 1. Ownership, before reading anything else: a resume that runs beside a
  // live owner is the collision this whole layer exists to prevent.
  //
  // It goes through the same slot `run` takes, and for the same reason: above
  // the default ceiling a run holds a lock on its *unit*, so a resume taking the
  // project lock would exclude nothing and let two processes work the same issue.
  //
  // With no issue named, the ceiling is forced back to 1. A bare `resume` may
  // touch several issues and every pending queue, and there is no single unit it
  // could name — so it takes the project lock and excludes everything, which is
  // the conservative answer rather than a guess at scope.
  const { maxConcurrent } = await loadRuntimeConfig();
  const acquisition = await acquireExecutionSlot({
    projectDir: project.projectDir,
    projectRunLockFile: project.runLockFile,
    unitId: issue ?? 'resume',
    target: issue ?? 'resume',
    maxConcurrent: issue === undefined ? 1 : maxConcurrent,
  });
  if (!acquisition.ok) {
    printError(describeSlotRefusal(acquisition));
    printInfo('Wait for it to finish, or stop that process before resuming.');
    return 1;
  }
  const handle: RunLockHandle = acquisition.handle;
  if (handle.reclaimedFrom !== null) {
    printWarning(
      `Taking over an interrupted run: ${describeRunLockOwner(handle.reclaimedFrom)}. Its lock was stale.`,
    );
  }

  try {
    // Resume queue-owned delivery/closure as a queue, not as an isolated member.
    const queues =
      project.storageDriver === 'sqlite'
        ? await listStoredQueues({ projectId: project.projectId })
        : await Promise.all(
            (await readdir(join(project.projectDir, QUEUES_DIR_NAME)).catch(() => [])).map((id) =>
              loadExecutionPlan(
                join(project.projectDir, QUEUES_DIR_NAME, id, 'execution-plan.json'),
              ),
            ),
          );
    const pendingQueues = queues.filter(
      (candidate) =>
        candidate &&
        (issue
          ? candidate.id === issue.replace(/^#/, '') ||
            candidate.issues.some((entry) => entry.id === issue.replace(/^#/, ''))
          : queueNeedsFinalization(candidate) || nextQueueIssue(candidate) !== null),
    );
    const queueMembers = new Set<string>();
    for (const queue of pendingQueues) {
      if (!queue) continue;
      const code = await runPipeline(queue.requested, mode, undefined, undefined, undefined, {
        ...(options.closeIssue === undefined ? {} : { closeIssue: options.closeIssue }),
      });
      if (code !== 0 || !options.all || issue) return code;
      for (const member of queue.issues) queueMembers.add(member.id);
    }
    // 2. What is there to resume.
    const targets = await findTargets(project, issue, options.all === true);
    if (targets.length === 0) {
      printInfo(
        issue === undefined
          ? 'Nothing to resume: no issue in this project has an unfinished pipeline.'
          : `Nothing to resume: issue #${issue} has no task plan in this project.`,
      );
      return 0;
    }

    for (const target of targets) {
      if (queueMembers.has(target.issue)) continue;
      const code = await resumeOne(target, mode, options.closeIssue);
      if (code !== 0) return code;
    }
    return 0;
  } finally {
    await handle.release();
  }
}

async function resumeOne(
  target: ResumeTarget,
  mode: string,
  closeIssue?: boolean,
): Promise<number> {
  const phases = activePhases(target.plan);
  const manager = new PipelineManager(target.plan, target.tasksFile, phases);
  const next = manager.getNextPhase();

  if (closeIssue !== undefined) {
    await persistClosureChoice(target.tasksFile, closeIssue);
    target.plan.closeIssue = closeIssue;
  }
  if (next === null) {
    if (mode === 'manual') return 0;
    if (target.plan.closeIssue || target.plan.lastError?.category === 'issue_closure') {
      const resolution = await resolveCommandIssue(target.issue);
      if (!resolution.ok) return resolution.code;
      return finishIssueClosure(target.tasksFile, target.issue, resolution.resolved.source);
    }
    printInfo(`Issue #${target.issue} has every phase complete; nothing to resume.`);
    return 0;
  }

  // 3. What was running when the process died. The snapshot cannot answer this
  // — it only knows the phase failed or never ended — so the journal does.
  const interrupted = await lastUnfinishedPhase(target);
  if (interrupted !== null) {
    printInfo(`Issue #${target.issue} was interrupted during the '${interrupted}' phase.`);
  }

  // 4. The repository, described and never repaired. Continuing the very phase
  // that was interrupted is the one case where uncommitted work is expected;
  // anything else would be carrying changes into work they do not belong to.
  const sameWork = interrupted === next;
  const preflight = await preflightRepository({
    expectedBranch: target.plan.noBranch === true ? null : target.plan.branchName,
    intent: sameWork ? 'resume-same-phase' : 'new-phase',
  });
  if (!preflight.ok) {
    printError(`Cannot resume issue #${target.issue}: the repository needs attention first.`);
    for (const line of describePreflight(preflight)) {
      printError(line);
    }
    return 1;
  }

  // 5. The phase, stated before anything runs.
  printInfo(`Resuming issue #${target.issue} from the '${next}' phase.`);
  return runPipeline(target.issue, mode, next, undefined, undefined, {
    only: true,
    ...(closeIssue === undefined ? {} : { closeIssue }),
  });
}

/** The phase set this plan's pipeline actually has, so `pr-review` is honoured. */
function activePhases(plan: TaskPlan): readonly PipelinePhase[] {
  const base =
    plan.noBranch === true
      ? PIPELINE_PHASES.filter((phase) => phase !== 'pr')
      : [...PIPELINE_PHASES];
  return plan.prReview?.enabled === true ? [...base, 'pr-review'] : base;
}

/**
 * The phase the journal shows as started and never ended.
 *
 * Both generations are read, oldest first, because a run long enough to rotate
 * its journal is exactly the kind that gets interrupted. A missing or
 * unreadable journal answers `null`: the resume continues from the plan, which
 * is what it did before a journal existed.
 */
async function lastUnfinishedPhase(target: ResumeTarget): Promise<string | null> {
  const entries =
    target.storageDriver === 'sqlite'
      ? await listStoredIssueEvents({ projectId: target.projectId, issueId: target.issue })
      : parseJournal(
          `${await readIfPresent(target.rotatedEventsFile)}${await readIfPresent(target.eventsFile)}`,
        );
  if (entries.length === 0) return null;

  const open: string[] = [];
  for (const entry of entries) {
    const event = entry.event;
    const phaseValue = (event as unknown as Record<string, unknown>).phase;
    const phase = typeof phaseValue === 'string' ? phaseValue : null;
    if (event.type === 'phase:start' && phase !== null) {
      open.push(phase);
    } else if (event.type === 'phase:end' && phase !== null) {
      const index = open.lastIndexOf(phase);
      if (index >= 0) open.splice(index, 1);
    }
  }
  return open.at(-1) ?? null;
}

async function readIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Which issues to resume.
 *
 * A named issue is taken at its word. Without one, the queue decides when there
 * is a queue — `nextQueueIssue()` is already the project's answer to "which one
 * first" — and otherwise the unfinished issues are ordered by when they were
 * last attempted, so `resume` alone picks up the most recent work.
 */
async function findTargets(
  project: Awaited<ReturnType<typeof resolveProjectPaths>>,
  issue: string | undefined,
  all: boolean,
): Promise<ResumeTarget[]> {
  if (issue !== undefined) {
    const target = await loadTarget(project, issue);
    return target === null ? [] : [target];
  }

  const unfinished = await unfinishedTargets(project);
  if (all) return unfinished;
  return unfinished.slice(0, 1);
}

/** Every issue whose plan is not finished, most recently attempted first. */
async function unfinishedTargets(
  project: Awaited<ReturnType<typeof resolveProjectPaths>>,
): Promise<ResumeTarget[]> {
  let ids: string[];
  try {
    ids =
      project.storageDriver === 'sqlite'
        ? await listStoredIssueIds({ projectId: project.projectId })
        : await readdir(project.issuesDir);
  } catch {
    return [];
  }

  const targets: ResumeTarget[] = [];
  for (const id of ids) {
    const target = await loadTarget(project, id);
    if (target === null) continue;
    const pendingClosure = target.plan.closeIssue === true && !target.plan.issueClosedAt;
    if (target.plan.issueStatus === 'completed' && !pendingClosure) continue;
    const manager = new PipelineManager(target.plan, target.tasksFile, activePhases(target.plan));
    if (
      manager.getNextPhase() === null &&
      !pendingClosure &&
      target.plan.lastError?.category !== 'issue_closure'
    )
      continue;
    targets.push(target);
  }

  return targets.sort((a, b) => attemptedAt(b.plan) - attemptedAt(a.plan));
}

function attemptedAt(plan: TaskPlan): number {
  const at = Date.parse(plan.lastAttemptAt ?? '');
  return Number.isNaN(at) ? 0 : at;
}

async function loadTarget(
  project: Awaited<ReturnType<typeof resolveProjectPaths>>,
  issue: string,
): Promise<ResumeTarget | null> {
  let paths: ReturnType<typeof getIssuePaths>;
  try {
    paths =
      project.storageDriver === 'sqlite'
        ? await resolveIssuePaths(issue)
        : getIssuePaths(project.projectId, issue);
  } catch {
    // Not a usable issue identifier — a stray file in `issues/`, for instance.
    return null;
  }

  try {
    const plan = await loadTaskPlan(paths.tasksFile);
    return {
      issue,
      projectId: project.projectId,
      storageDriver: project.storageDriver,
      plan,
      tasksFile: paths.tasksFile,
      eventsFile: paths.eventsFile,
      rotatedEventsFile: paths.rotatedEventsFile,
    };
  } catch {
    return null;
  }
}

/**
 * Hand control back to the pipeline for every run this resume covers.
 *
 * Returns how many holds were released. Zero means nothing was held and the
 * ordinary resume should proceed.
 *
 * Releasing is always explicit — nothing here infers that a person is finished,
 * because a run that resumed itself when the terminal went quiet would be the
 * failure the hold exists to prevent.
 */
async function releaseHeldRuns(
  project: Awaited<ReturnType<typeof resolveProjectPaths>>,
  issue: string | undefined,
): Promise<number> {
  if (project.storageDriver !== 'sqlite') return 0;

  let held: Awaited<ReturnType<typeof listHeldRuns>>;
  try {
    held = await listHeldRuns({
      projectId: project.projectId,
      databaseOptions: project.databaseOptions,
    });
  } catch {
    // No hold is readable, so there is nothing to release and the ordinary
    // resume path is the right one.
    return 0;
  }
  const targets = issue === undefined ? held : held.filter((run) => run.issueId === issue);
  if (targets.length === 0) return 0;

  for (const run of targets) {
    await saveRunHumanHold(
      {
        tasksPath: '',
        projectId: project.projectId,
        // The write is keyed by run and project; the remaining context fields
        // are not read by it, and the run's own row already knows its issue.
        projectRoot: project.projectDir,
        issueId: run.issueId ?? '',
        databaseOptions: project.databaseOptions,
      },
      run.runId,
      null,
    );
    printInfo(
      `Handed control back to the pipeline for ${
        run.issueId === null ? `run ${run.runId}` : `issue #${run.issueId}`
      }, held since ${run.since}.`,
    );
  }
  return targets.length;
}
