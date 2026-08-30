import { getActiveResilienceConfig, loadIssuesConfig } from '../../config.js';
import { beginUsageScope, type getRunUsageTotals } from '../../core/session-metrics.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../../core/state-manager.js';
import { spawnDetachedRun } from '../../execution/detach.js';
import {
  markQueueIssueBlocked,
  markQueueIssueCompleted,
  markQueueIssueFailed,
  markQueueIssueInProgress,
  markQueueIssueSkipped,
  nextQueueIssue,
  saveExecutionPlan,
  setQueueBranch,
  setQueuePullRequest,
} from '../../execution/plan.js';
import { planQueue, type QueueDecision } from '../../execution/queue.js';
import type { ExecutionPlan } from '../../execution/types.js';
import { resolveCommandIssue } from '../../issues/context.js';
import type { ResolvedIssue } from '../../issues/types.js';
import {
  resolveIssuePaths,
  resolveProjectPaths,
  resolveQueuePaths,
} from '../../storage/resolve.js';
import { printError, printInfo, printSuccess, printWarning } from '../../ui/logger.js';
import { printQueueSummary, type QueueIssueSummary } from '../../ui/summary.js';
import {
  buildPrQueueContext,
  closeIssue,
  primaryPrCreated,
  propagatePullRequest,
} from './pull-request.js';
import type {
  PrReviewOutcome,
  QueueFailureMode,
  RunIssueSession,
  RunPipelineOptions,
} from './types.js';

/** Attempts an Issue gets before the queue stops handing it out. */
export const DEFAULT_MAX_ISSUE_ATTEMPTS = 2;

export interface DecideQueueInput {
  requested: string[];
  resolved: ResolvedIssue;
  noBranch: boolean;
  prReview: boolean;
  runOptions: RunPipelineOptions;
}

/**
 * Ask the planner whether this invocation is a queue, resolving the storage
 * paths it needs.
 *
 * A failure here degrades to a single-issue run when only one issue was asked
 * for — discovery is an enrichment, and losing it must never cost the user the
 * pipeline. With several issues informed there is nothing to degrade to: the
 * user asked for a queue, so the error is reported and the run stops.
 */
export async function decideQueue(input: DecideQueueInput): Promise<QueueDecision> {
  const primary = input.requested[0] as string;
  const single = input.requested.length === 1;

  if (single && input.runOptions.only === true) {
    return { kind: 'single' };
  }

  try {
    const [project, queuePaths] = await Promise.all([
      resolveProjectPaths(),
      resolveQueuePaths(primary),
    ]);

    return await planQueue({
      requested: input.requested,
      source: input.resolved.source,
      known: [input.resolved.issue],
      projectId: project.projectId,
      planFile: queuePaths.planFile,
      noBranch: input.noBranch,
      prReview: input.prReview,
      confirm: {
        yes: input.runOptions.yes,
        only: input.runOptions.only,
        cascade: input.runOptions.cascade,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (single) {
      printWarning(
        `Could not inspect related issues (${message}). Running issue #${primary} alone.`,
      );
      return { kind: 'single' };
    }
    printError(`Could not plan the execution of ${input.requested.length} issues: ${message}`);
    return { kind: 'stop', code: 1 };
  }
}

/**
 * Confirm the queue (if needed) and spawn the same command without `--background`.
 * The child acquires the lock with `detached: true` and writes `run.log`.
 */
export async function detachAfterConfirm(
  requested: string[],
  noBranch: boolean | undefined,
  prReview: boolean | undefined,
  options: RunPipelineOptions,
): Promise<number> {
  const childFlags = [...process.argv.slice(2)];
  if (options.yes !== true && options.only !== true) {
    try {
      const issuesConfig = await loadIssuesConfig();
      const resolution = await resolveCommandIssue(requested[0] as string, undefined, {
        config: issuesConfig,
      });
      if (resolution.ok) {
        const decision = await decideQueue({
          requested,
          resolved: resolution.resolved,
          noBranch: noBranch ?? false,
          prReview: prReview ?? false,
          runOptions: options,
        });
        if (decision.kind === 'stop') return decision.code;
        if (decision.kind === 'queue' && !childFlags.includes('--yes')) childFlags.push('--yes');
        if (decision.kind === 'single' && !childFlags.includes('--only')) childFlags.push('--only');
      }
    } catch {
      // Discovery is an enrichment; a detach still starts the run that was asked for.
    }
  }

  const paths = await resolveIssuePaths(requested[0] as string);
  const { pid, logFile } = await spawnDetachedRun({ paths, argv: childFlags });
  printSuccess(`Detached run started (pid ${pid}).`);
  printInfo(`Log: ${logFile}`);
  printInfo('Follow with: issue-flow ps');
  printInfo(`Stop with: kill ${pid}`);
  return 0;
}

/**
 * Run a queue of issues: one shared branch, one process, one issue at a time.
 *
 * Each issue goes through the very same phases a single-issue run does
 * (`prd` → `plan` → `execute` → `review`), with its own `tasks.json`, its own
 * session and its own usage scope. The queue owns only what is shared: the
 * order, the branch, the Pull Request and the consolidated totals.
 *
 * A failure stops the queue where it happened, records the issue and the phase,
 * and leaves every commit and the branch exactly as they are — the next
 * invocation resumes from the failed issue without redoing the ones before it.
 *
 * `runIssueSession` is injected so this module never imports the session (or
 * phases) layer — that would close a cycle through `decideQueue` /
 * `adoptQueueBranch`, which phases call.
 */
export async function runQueue(
  initialPlan: ExecutionPlan,
  options: {
    mode: string;
    from?: string;
    noBranch?: boolean;
    prReview?: boolean;
    runOptions?: RunPipelineOptions;
  },
  resolvedPrimary: ResolvedIssue | undefined,
  runIssueSession: RunIssueSession,
): Promise<number> {
  const planFile = (await resolveQueuePaths(initialPlan.id)).planFile;
  let plan = initialPlan;

  const queueUsage = beginUsageScope();
  const startedAtMs = Date.now();
  const summaries: QueueIssueSummary[] = [];
  let firstOfThisRun = true;

  const resilience = getActiveResilienceConfig();
  const failureMode: QueueFailureMode =
    options.runOptions?.onIssueFailure ??
    (resilience.queue?.onIssueFailure as QueueFailureMode | undefined) ??
    'stop';
  const maxIssueAttempts = resilience.queue?.maxIssueAttempts ?? DEFAULT_MAX_ISSUE_ATTEMPTS;

  // Ids this invocation is done with. Without it, an Issue that exhausted its
  // attempts would be handed back out on the very next lookup — `failed` comes
  // before `pending` in the resumption policy, which is right *across*
  // invocations and wrong inside one.
  const exhausted = new Set<string>();
  const failedIds = new Set<string>();

  try {
    while (true) {
      const entry = nextQueueIssue(plan, { exclude: exhausted });
      if (entry === null) break;

      plan = markQueueIssueInProgress(plan, entry.id);
      await saveExecutionPlan(planFile, plan);

      printInfo(
        `Queue ${entry.position}/${plan.issues.length}: issue #${entry.id}${entry.title === '' ? '' : ` — ${entry.title}`}`,
      );

      const issueUsage = beginUsageScope();
      let result: Awaited<ReturnType<RunIssueSession>>;
      try {
        result = await runIssueSession(entry.id, options.mode, {
          // `--from` addresses the issue the queue is resuming, never the ones
          // that come after it — those start from their own beginning.
          from: firstOfThisRun ? options.from : undefined,
          noBranch: options.noBranch,
          // `--start-us` belongs to the first issue this invocation runs; the
          // ones after it continue from the history those plans just wrote.
          runOptions: {
            ...options.runOptions,
            startUs: firstOfThisRun ? options.runOptions?.startUs : undefined,
          },
          queue: {
            plan,
            preChecked: true,
            resolved: entry.id === initialPlan.id ? resolvedPrimary : undefined,
          },
        });
      } finally {
        firstOfThisRun = false;
        // Ending here (not only on the happy path) keeps a thrown error from
        // leaving an orphan accumulator on top of the scope stack, where it
        // would silently become "the current scope" for everything after it.
        issueUsage.end();
      }
      const usage = issueUsage.totals();

      if (result.code !== 0) {
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
          return result.code;
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
          continue;
        }

        // `skip`: not a verdict on the eleven other Issues in the queue.
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
        continue;
      }

      // The first issue names the branch; every later one is made to adopt it.
      if (plan.branchName === null && result.branchName !== null) {
        plan = setQueueBranch(plan, result.branchName);
      }
      plan = markQueueIssueCompleted(plan, entry.id);
      await saveExecutionPlan(planFile, plan);

      summaries.push({
        id: entry.id,
        title: entry.title,
        storyCount: result.storyCount,
        elapsedSeconds: result.elapsedSeconds,
        usage,
      });
    }

    const code = await finishQueue(
      plan,
      planFile,
      summaries,
      startedAtMs,
      queueUsage,
      options,
      resolvedPrimary,
      runIssueSession,
    );

    if (failedIds.size > 0) {
      // The queue went as far as it could, and that is worth reporting as a
      // failure even though the independent work landed.
      printError(
        `${failedIds.size} issue(s) did not finish: ${[...failedIds].map((id) => `#${id}`).join(', ')}.`,
      );
      printInfo(`Resume with: issue-flow run ${plan.requested.join(',')}`);
      return code === 0 ? 1 : code;
    }
    return code;
  } finally {
    queueUsage.end();
  }
}

/**
 * Everything that happens once every issue of the queue is done: the single
 * consolidated Pull Request, closing the issues and reporting. Split out so the
 * loop above stays about scheduling.
 */
async function finishQueue(
  plan: ExecutionPlan,
  planFile: string,
  summaries: QueueIssueSummary[],
  startedAtMs: number,
  /** Read only after the consolidated Pull Request ran, so its cost counts. */
  queueUsage: { totals: () => ReturnType<typeof getRunUsageTotals> },
  options: { mode: string; noBranch?: boolean; prReview?: boolean },
  resolvedPrimary: ResolvedIssue | undefined,
  runIssueSession: RunIssueSession,
): Promise<number> {
  let current = plan;
  let review: PrReviewOutcome | null = null;

  // One Pull Request for the whole queue, and only when there is a branch to
  // propose and no Pull Request has been opened for this queue yet.
  const alreadyOpened = current.pullRequest !== undefined || (await primaryPrCreated(current));
  if (!current.noBranch && options.noBranch !== true && !alreadyOpened) {
    const outcome = await runIssueSession(current.id, options.mode, {
      prReview: options.prReview ?? current.prReview,
      queue: {
        plan: current,
        preChecked: true,
        resolved: resolvedPrimary,
        finalPr: await buildPrQueueContext(current),
      },
    });
    review = outcome.review ?? null;

    if (outcome.code !== 0) {
      printError('The consolidated Pull Request could not be created.');
      await saveExecutionPlan(planFile, current);
      return outcome.code;
    }

    const pullRequest = await propagatePullRequest(current);
    if (pullRequest !== null) {
      current = setQueuePullRequest(current, pullRequest);
    }
  }

  await saveExecutionPlan(planFile, current);

  // A review asking for changes leaves every issue open, exactly as it does for
  // a single-issue run: the work is proposed, not accepted.
  if (review?.requestedChanges === true) {
    printInfo('Issues left open until the review blockers are addressed.');
  } else {
    for (const entry of current.issues) {
      await closeIssue(entry.id, entry.source);
    }
  }

  printQueueSummary({
    queueId: current.id,
    branchName: current.branchName,
    issues: summaries,
    excluded: current.excluded.map((entry) => ({ id: entry.id, title: entry.title })),
    elapsedSeconds: Math.round((Date.now() - startedAtMs) / 1000),
    prUrl: current.pullRequest?.url ?? null,
    // Read here, after the consolidated Pull Request (and the optional
    // pr-review) already ran: reading it before would report a queue total
    // that leaves out the phase that just spent tokens.
    usage: queueUsage.totals(),
    prReview: review,
  });

  return 0;
}

/**
 * Make an issue's task plan use the queue's branch.
 *
 * With no branch decided yet, whatever the `plan` phase produced becomes the
 * queue's branch (the first issue names it, from its own title). From then on
 * the value is written over every later issue's plan, so `execute.md`'s
 * "check it out or create from main" finds the branch already there.
 */
export async function adoptQueueBranch(
  tasksPath: string,
  queueBranch: string | null,
): Promise<string | null> {
  try {
    const plan = await loadTaskPlan(tasksPath);
    if (queueBranch === null || queueBranch === '') {
      return plan.branchName === '' ? null : plan.branchName;
    }
    if (plan.branchName !== queueBranch) {
      plan.branchName = queueBranch;
      await saveTaskPlan(tasksPath, plan);
    }
    return queueBranch;
  } catch {
    // No tasks.json (the plan phase failed to write one): the queue keeps the
    // branch it already had, and the phase failure is reported on its own.
    return queueBranch;
  }
}
