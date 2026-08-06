import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { loadIssuesConfig, loadWebConfig } from '../config.js';
import {
  PIPELINE_PHASES,
  PIPELINE_PHASES_NO_BRANCH,
  PIPELINE_PHASES_WITH_PR_REVIEW,
  PipelineManager,
  type PipelinePhase,
} from '../core/pipeline.js';
import { mostRecent } from '../core/pr-review/discovery.js';
import {
  type PrReviewRoundEntry,
  prReviewDir,
  readPrReviewIndex,
} from '../core/pr-review/report.js';
import { listPullRequests, publishGitState } from '../core/session-git.js';
import { beginUsageScope, getRunUsageTotals } from '../core/session-metrics.js';
import { setSessionPublisher } from '../core/session-publisher.js';
import { FilePublisher, NullPublisher, type SessionPublisher } from '../core/session-state.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { isVerbose } from '../core/verbose.js';
import {
  markQueueIssueCompleted,
  markQueueIssueFailed,
  markQueueIssueInProgress,
  nextQueueIssue,
  saveExecutionPlan,
  setQueueBranch,
  setQueuePullRequest,
} from '../execution/plan.js';
import { planQueue, type QueueDecision } from '../execution/queue.js';
import type { ExecutionPlan, ExecutionPlanIssue } from '../execution/types.js';
import { parseIssueArguments } from '../issues/args.js';
import { resolveCommandIssue } from '../issues/context.js';
import { getProvider } from '../issues/registry.js';
import type { Issue, IssueSource, ResolvedIssue } from '../issues/types.js';
import type { IssuePaths } from '../storage/paths.js';
import { resolveIssuePaths, resolveProjectPaths, resolveQueuePaths } from '../storage/resolve.js';
import type { PullRequestRef, UserStory } from '../types.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/logger.js';
import { runPipelineWithRenderer } from '../ui/pipeline-renderer.js';
import {
  printQueueSummary,
  printRunSummary,
  type QueueIssueSummary,
  type RunSummaryPrReview,
} from '../ui/summary.js';
import { ensureWebMonitor } from '../web/lock.js';
import { runExecute } from './execute.js';
import { runInit } from './init.js';
import { runPlan } from './plan.js';
import { type PrQueueContext, runPr } from './pr.js';
import { runPrReview } from './pr-review.js';
import { runPrd } from './prd.js';
import { runReview } from './review.js';

/**
 * Numeric form of an identifier, or `null` when the origin uses a non-numeric
 * one. Published as-is in session.json: a local id like 'auth-refactor' has no
 * number, and reporting it as 0 would claim an Issue that does not exist.
 */
function toIssueNumber(id: string): number | null {
  const parsed = Number.parseInt(id, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Seed the snapshot with the stories a `tasks.json` already holds on disk, so
 * the monitor shows the plan instead of "no user story yet" until the first
 * execute iteration republishes them.
 *
 * Must be called **after** `session:start`, which resets the snapshot through
 * `createInitialSnapshot()`. An empty plan publishes nothing: the event would
 * bump the publisher's version without adding any content.
 *
 * Returns whether anything was published.
 */
export function publishStorySeed(
  publisher: SessionPublisher,
  stories: readonly UserStory[],
  at: string,
): boolean {
  if (stories.length === 0) return false;
  publisher.publish({ type: 'stories:update', at, stories: [...stories] });
  return true;
}

/**
 * Publish the Issue's structural data (title, description, labels, state) so
 * the panel shows what is being implemented without a detour through GitHub.
 *
 * Same window as the story seed: right after `session:start`, which resets the
 * snapshot. The data comes from the `ResolvedIssue` the run already holds — no
 * extra provider call — and the description goes out whole, untruncated.
 */
export function publishIssueDetails(publisher: SessionPublisher, issue: Issue, at: string): void {
  publisher.publish({
    type: 'issue:update',
    at,
    number: issue.number,
    // Left undefined (rather than null) when the origin has no remote, so the
    // reducer keeps whatever URL session:start already published.
    url: issue.remoteRef ?? undefined,
    title: issue.title,
    description: issue.body,
    labels: issue.labels,
    state: issue.state,
  });
}

/** Runnable phase lists (excluding 'init' which is handled separately). */
const RUNNABLE_PHASES: PipelinePhase[] = ['prd', 'plan', 'execute', 'review', 'pr'];
const RUNNABLE_PHASES_NO_BRANCH: PipelinePhase[] = ['prd', 'plan', 'execute', 'review'];
const RUNNABLE_PHASES_WITH_PR_REVIEW: PipelinePhase[] = [...RUNNABLE_PHASES, 'pr-review'];

/**
 * Phases of a queue's closing pass: the work is already committed by the
 * per-issue runs, so all that is left is the single consolidated Pull Request.
 */
const QUEUE_PR_PHASES = ['init', 'pr'] as const satisfies readonly PipelinePhase[];
const QUEUE_PR_PHASES_WITH_REVIEW = [
  'init',
  'pr',
  'pr-review',
] as const satisfies readonly PipelinePhase[];
const RUNNABLE_QUEUE_PR_PHASES: PipelinePhase[] = ['pr'];
const RUNNABLE_QUEUE_PR_PHASES_WITH_REVIEW: PipelinePhase[] = ['pr', 'pr-review'];

/**
 * What the `pr-review` phase left behind, for the steps that run after it: the
 * automatic issue close, the highlighted warning and the final summary.
 *
 * Same shape the summary consumes: `requestedChanges` drives the close
 * suppression and is true on exit code 2 even when the plan is gone.
 */
type PrReviewOutcome = RunSummaryPrReview;

/**
 * Recover the verdict and the report path the `pr-review` phase produced.
 *
 * Best-effort by design: the exit code already tells whether changes were
 * requested, so a missing plan or index costs the summary a detail, never the
 * decision to keep the issue open.
 */
async function readPrReviewOutcome(
  issue: string,
  tasksPath: string,
  requestedChanges: boolean,
): Promise<PrReviewOutcome> {
  const outcome: PrReviewOutcome = { requestedChanges, recommendation: null, reportPath: null };
  try {
    const plan = await loadTaskPlan(tasksPath);
    outcome.recommendation = plan.prReview?.lastRecommendation ?? null;

    const pullRequest = plan.prReview?.pullRequestNumber;
    if (pullRequest !== undefined) {
      const dir = await prReviewDir({ issue, pullRequest });
      const index = await readPrReviewIndex(dir);
      const last = index?.rounds.reduce<PrReviewRoundEntry | null>(
        (latest, entry) => (latest === null || entry.round > latest.round ? entry : latest),
        null,
      );
      if (last) {
        outcome.reportPath = join(dir, last.reportPath);
        outcome.recommendation ??= last.recommendation;
      }
    }
  } catch {
    /* non-critical */
  }
  return outcome;
}

/** Options `run` accepts on top of the phase selection ones. */
export interface RunPipelineOptions {
  /** `--yes`: accept the discovered hierarchy without confirmation. */
  yes?: boolean;
  /** `--only`: run just the issues informed, skipping discovery. */
  only?: boolean;
}

/**
 * Everything a queue hands to the run of one of its issues.
 *
 * Its presence is what tells `runPipelinePhases` it is a member of a queue
 * rather than a standalone pipeline: the Pull Request moves to the end of the
 * queue, the branch is shared, commits carry the issue scope, and the terminal
 * summary is the queue's, not the issue's.
 */
interface QueueRunContext {
  plan: ExecutionPlan;
  planFile: string;
  entry: ExecutionPlanIssue;
  /** True when `init` already ran in this process for the queue. */
  preChecked: boolean;
  /** Issue already resolved by the planner, if this is the primary one. */
  resolved?: ResolvedIssue;
  /**
   * Set on the final pass of a queue, which runs no implementation phase at
   * all: only `pr` (and the optional `pr-review`), for the single Pull Request
   * that consolidates every issue.
   */
  finalPr?: PrQueueContext;
}

/** What one issue's run reports back to the caller. */
interface IssueRunResult {
  code: number;
  /** Phase that failed, `null` on success. */
  failedPhase: string | null;
  /** `branchName` of the issue's plan once the `plan` phase produced one. */
  branchName: string | null;
  storyCount: number;
  elapsedSeconds: number;
  /** Verdict of the `pr-review` phase, when it ran. */
  review?: PrReviewOutcome | null;
  /** Set when the run stopped to hand control over to a queue. */
  queue?: { plan: ExecutionPlan; resumed: boolean; resolved: ResolvedIssue };
}

/**
 * Entry point of `issue-flow run`.
 *
 * Accepts one issue (the historical form, untouched) or several. The first
 * attempt runs as a plain single-issue pipeline; only if the planner decides
 * this invocation is really a queue does it hand control over to
 * {@link runQueue} — and that decision is taken before any session is
 * published, so nothing was written on the way.
 */
export async function runPipeline(
  issue: string | readonly string[],
  mode: string,
  from?: string,
  noBranch?: boolean,
  prReview?: boolean,
  options: RunPipelineOptions = {},
): Promise<number> {
  let requested: string[];
  try {
    requested = parseIssueArguments(typeof issue === 'string' ? [issue] : issue);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const first = await runIssueSession(requested[0] as string, mode, {
    from,
    noBranch,
    prReview,
    requested,
    runOptions: options,
  });

  if (first.queue === undefined) {
    return first.code;
  }

  return runQueue(first.queue.plan, { mode, from, noBranch, prReview }, first.queue.resolved);
}

interface IssueSessionInput {
  from?: string;
  noBranch?: boolean;
  prReview?: boolean;
  /** Identifiers the user asked for; only the standalone attempt needs them. */
  requested?: string[];
  runOptions?: RunPipelineOptions;
  queue?: QueueRunContext;
}

/**
 * Run one issue with its own session publisher and web monitor registration.
 *
 * This is the body `runPipeline` always had; a queue calls it once per issue,
 * which is what gives each of them its own `session.json` (and therefore its
 * own card in the monitor) inside a single process.
 */
async function runIssueSession(
  issueNumber: string,
  mode: string,
  input: IssueSessionInput,
): Promise<IssueRunResult> {
  // Resolved once, at the top: every phase that runs below shares the process
  // cache, so the git call and the legacy migration happen a single time for
  // the whole run instead of once per phase.
  const paths = await resolveIssuePaths(issueNumber);

  // Read per issue rather than cached for the process: the configuration is
  // per project and cheap to read, and a cached value would leak a `--web`
  // decision from one invocation into the next inside the same process.
  const webConfig = await loadWebConfig();
  let publisher: SessionPublisher = new NullPublisher();
  if (webConfig.enabled) {
    // resolveIssuePaths never creates directories, and a run may well be the
    // first thing to touch this issue's global folder — so the writer creates
    // it. Only under --web: with monitoring off the pipeline still creates
    // nothing at all (US-009).
    await mkdir(paths.issueDir, { recursive: true });
    publisher = new FilePublisher(paths.sessionFile, {
      logLimit: webConfig.logLimit,
      includeLogs: webConfig.includeLogs,
    });
  }
  setSessionPublisher(publisher);

  // A null handle (port in use, ...) means the pipeline runs without a server.
  // ensureWebMonitor reuses an already-running, healthy instance instead of
  // binding a second one (US-001), or spawns it detached when none exists
  // (US-002) — either way the returned handle never owns a local server that
  // this process would need to close.
  if (webConfig.enabled) {
    await ensureWebMonitor({
      publisher,
      port: webConfig.port,
      host: webConfig.host,
      refreshSeconds: webConfig.refreshSeconds,
    });
  }

  let result: IssueRunResult = {
    code: 1,
    failedPhase: null,
    branchName: null,
    storyCount: 0,
    elapsedSeconds: 0,
  };
  try {
    result = await runPipelinePhases(issueNumber, paths, mode, publisher, input);
    return result;
  } finally {
    // A run that only decided to become a queue published nothing: closing the
    // session here would write a `session.json` for a pipeline that never ran.
    if (result.queue === undefined) {
      publisher.publish({
        type: 'session:end',
        at: isoNow(),
        status: result.code === 0 ? 'completed' : 'failed',
      });
    }
    // The web monitor is no longer this process's to close (US-002): it is a
    // detached, single machine-wide instance meant to outlive the pipeline
    // and serve other invocations. Only this run's own publication ends here.
    await publisher.close();
    setSessionPublisher(undefined);
  }
}

async function runPipelinePhases(
  issueNumber: string,
  paths: IssuePaths,
  mode: string,
  publisher: SessionPublisher,
  input: IssueSessionInput,
): Promise<IssueRunResult> {
  const { from, noBranch, prReview, queue } = input;
  const tasksPath = paths.tasksFile;
  const sessionId = randomUUID();

  // Refined with the provider's own number once the Issue is resolved.
  let publishedIssueNumber = toIssueNumber(issueNumber);

  const publishSessionStart = (
    phases: readonly string[],
    at: string,
    info?: { issueUrl?: string; branch?: string },
  ): void => {
    publisher.publish({
      type: 'session:start',
      at,
      sessionId,
      issueNumber: publishedIssueNumber,
      issueUrl: info?.issueUrl,
      branch: info?.branch,
      phases: [...phases],
      environment: { node: process.version, platform: process.platform },
    });
  };

  printInfo(`Starting pipeline for issue #${issueNumber} (mode: ${mode})`);

  // Loaded before the checks so init knows which origin the user is heading
  // for: with a local one, a missing gh must not fail the environment.
  const issuesConfig = await loadIssuesConfig();

  // Phase 1: Init check. Inside a queue it already ran for the whole run, so
  // the environment is not probed once per issue — the phase is still
  // published, keeping every issue's session shape identical.
  const sessionStartedAt = isoNow();
  if (queue?.preChecked !== true) {
    printInfo('Running prerequisite checks...');
    const initCode = await runInit(issuesConfig.preferredProvider);
    if (initCode !== 0) {
      publishSessionStart(PIPELINE_PHASES, sessionStartedAt);
      publisher.publish({ type: 'phase:start', at: sessionStartedAt, phase: 'init' });
      publisher.publish({
        type: 'phase:end',
        at: isoNow(),
        phase: 'init',
        success: false,
        error: 'Prerequisites not met',
      });
      printError('Prerequisites not met. Fix the issues above and try again.');
      return failure(1);
    }
  }

  // The origin is settled once, here, and the decision travels to every phase.
  // Resolving per phase would query the providers five times and could ask the
  // user about the same divergence five times.
  const resolution = await resolveCommandIssue(issueNumber, queue?.resolved, {
    config: issuesConfig,
  });
  if (!resolution.ok) {
    return failure(resolution.code);
  }
  const resolvedIssue = resolution.resolved;
  publishedIssueNumber = resolvedIssue.issue.number;

  // Everything above is what a queue needs to exist: prerequisites checked and
  // the primary Issue resolved, but not a single phase run and not a single
  // event published. This is where a run learns it is really a queue.
  if (queue === undefined) {
    const decision = await decideQueue({
      requested: input.requested ?? [issueNumber],
      resolved: resolvedIssue,
      noBranch: noBranch ?? false,
      prReview: prReview ?? false,
      runOptions: input.runOptions ?? {},
    });
    if (decision.kind === 'stop') {
      return failure(decision.code);
    }
    if (decision.kind === 'queue') {
      return {
        ...failure(0),
        queue: { plan: decision.plan, resumed: decision.resumed, resolved: resolvedIssue },
      };
    }
  }

  // Resolve noBranch mode: persisted value takes precedence on resume
  let effectiveNoBranch = noBranch ?? false;
  // Resolve pr-review mode: flag > persisted value > default (off). Unlike
  // --no-branch, the flag wins: the phase adds a step at the end instead of
  // changing what the earlier phases did, so opting in on resume is safe.
  let effectivePrReview = prReview ?? false;
  let planIssueUrl: string | undefined;
  let planBranch: string | undefined;
  // Kept from the same read as planIssueUrl/planBranch — seeding the snapshot
  // must not cost a second trip to disk.
  let planStories: UserStory[] = [];
  try {
    const existingPlan = await loadTaskPlan(tasksPath);
    const persistedNoBranch = existingPlan.noBranch ?? false;
    planIssueUrl = existingPlan.issueUrl || undefined;
    planBranch = existingPlan.branchName || undefined;
    planStories = existingPlan.userStories;
    effectivePrReview = prReview ?? existingPlan.prReview?.enabled ?? false;

    // Only warn when the user explicitly passed a flag that conflicts with the persisted value
    if (noBranch !== undefined && noBranch !== persistedNoBranch) {
      if (persistedNoBranch) {
        printWarning(
          'This pipeline was started with --no-branch. Ignoring current flag; using persisted mode.',
        );
      } else {
        printWarning(
          'This pipeline was started without --no-branch. Ignoring current flag; using persisted mode.',
        );
      }
    }

    // Persisted mode wins on resume
    effectiveNoBranch = persistedNoBranch;
  } catch {
    // No tasks.json yet — use the CLI flag as-is
  }

  // The CLI rejects --pr-review with --no-branch, but the persisted no-branch
  // mode can only be known here. Without a pr phase there is no Pull Request
  // to review, so the opt-in is dropped instead of failing a resumed run.
  if (effectiveNoBranch && effectivePrReview) {
    printWarning(
      'This pipeline runs with --no-branch and opens no PR. Skipping the pr-review phase.',
    );
    effectivePrReview = false;
  }

  // Persist the opt-in as soon as we know it, not only after the `plan` phase.
  // A mid-pipeline `--pr-review` (e.g. `--from pr --pr-review`) never re-enters
  // the plan runner, and without `enabled: true` a later resume without the flag
  // would drop the phase even when `prReviewCompleted` is still false.
  if (effectivePrReview) {
    try {
      const plan = await loadTaskPlan(tasksPath);
      if (plan.prReview?.enabled !== true) {
        plan.prReview = { ...plan.prReview, enabled: true, rounds: plan.prReview?.rounds ?? 0 };
        await saveTaskPlan(tasksPath, plan);
      }
    } catch {
      // No tasks.json yet — the plan runner persists it after creating the file.
    }
  }

  // Inside a queue the Pull Request is opened once, after the last issue, so
  // `pr` (and with it `pr-review`) leaves the per-issue phase list. The list is
  // the same one `--no-branch` uses, but the branch is still created: what
  // changes is who opens the Pull Request, not whether there is a branch.
  const inQueue = queue !== undefined;
  // The queue's last pass implements nothing: it only opens the single Pull
  // Request that covers every issue already committed to the shared branch.
  const finalPr = queue?.finalPr;
  const activePhases = finalPr
    ? effectivePrReview
      ? QUEUE_PR_PHASES_WITH_REVIEW
      : QUEUE_PR_PHASES
    : inQueue
      ? PIPELINE_PHASES_NO_BRANCH
      : effectiveNoBranch
        ? PIPELINE_PHASES_NO_BRANCH
        : effectivePrReview
          ? PIPELINE_PHASES_WITH_PR_REVIEW
          : PIPELINE_PHASES;
  const phaseOrder = finalPr
    ? effectivePrReview
      ? RUNNABLE_QUEUE_PR_PHASES_WITH_REVIEW
      : RUNNABLE_QUEUE_PR_PHASES
    : inQueue
      ? RUNNABLE_PHASES_NO_BRANCH
      : effectiveNoBranch
        ? RUNNABLE_PHASES_NO_BRANCH
        : effectivePrReview
          ? RUNNABLE_PHASES_WITH_PR_REVIEW
          : RUNNABLE_PHASES;

  // The phase list is only known after resolving --no-branch, so the init
  // phase (which already ran) is published retroactively with real timestamps.
  publishSessionStart(activePhases, sessionStartedAt, {
    issueUrl: planIssueUrl ?? resolvedIssue.issue.remoteRef ?? undefined,
    branch: planBranch,
  });
  // Right after session:start (which resets the snapshot) and before any phase
  // event, so the first /api/status poll already answers with the Issue and
  // the plan.
  publishIssueDetails(publisher, resolvedIssue.issue, sessionStartedAt);
  publishStorySeed(publisher, planStories, sessionStartedAt);
  publisher.publish({ type: 'phase:start', at: sessionStartedAt, phase: 'init' });
  publisher.publish({ type: 'phase:end', at: isoNow(), phase: 'init', success: true });
  await publishGitState(publisher);

  // Determine starting phase
  let startPhase: PipelinePhase = 'prd';
  if (from) {
    if (!(activePhases as readonly string[]).includes(from)) {
      const validPhases = activePhases.filter((p) => p !== 'init').join(', ');
      // Check if the phase exists in the full set but is excluded by --no-branch
      if (effectiveNoBranch && (PIPELINE_PHASES as readonly string[]).includes(from)) {
        printError(
          `The '${from}' phase is not available in --no-branch mode. Valid phases: ${validPhases}`,
        );
      } else {
        printError(`Invalid phase: ${from}. Valid phases: ${validPhases}`);
      }
      return failure(1);
    }
    startPhase = from as PipelinePhase;
  } else {
    // Try to auto-resume from pipeline state
    try {
      const plan = await loadTaskPlan(tasksPath);
      const mgr = new PipelineManager(plan, tasksPath, activePhases);
      const nextPhase = mgr.getNextPhase();
      if (nextPhase && nextPhase !== 'init') {
        startPhase = nextPhase;
        printInfo(`Resuming from phase: ${startPhase}`);
      }
    } catch {
      // No tasks.json yet — start from beginning
    }
  }

  // Validate resume prerequisites if starting from a later phase
  if (from) {
    try {
      const plan = await loadTaskPlan(tasksPath);
      const mgr = new PipelineManager(plan, tasksPath, activePhases);
      if (!mgr.canResume(startPhase)) {
        printError(`Cannot resume from ${startPhase}: prerequisite phases not complete`);
        return failure(1);
      }
    } catch {
      if (startPhase !== 'prd') {
        printError(`Cannot resume from ${startPhase}: no pipeline state found`);
        return failure(1);
      }
    }
  }

  // A phase that is not part of this run's list (the closing pass of a queue
  // runs only `pr`) starts the renderer at the beginning rather than at -1.
  const startIdx = Math.max(phaseOrder.indexOf(startPhase), 0);

  // Commit scope for this issue's stories: only a queue needs one, because
  // only there do several issues share a branch (and therefore a `git log`).
  const queueCommitScope = queue === undefined ? undefined : `issue-${issueNumber}`;
  // Branch the `plan` phase settled on, reported back so the queue can adopt
  // the first issue's choice for every later one.
  let producedBranch: string | null = null;

  // Build phase runner functions that throw on failure
  const makeRunner = (fn: () => Promise<number>, phase: string) => async () => {
    const code = await fn();
    if (code !== 0) {
      throw new Error(`Phase ${phase} failed with exit code ${code}`);
    }
  };

  const runners: Record<string, () => Promise<void>> = {
    prd: makeRunner(() => runPrd(issueNumber, resolvedIssue), 'prd'),
    plan: async () => {
      await makeRunner(() => runPlan(issueNumber, resolvedIssue), 'plan')();
      // Persist the phase-selection modes into the newly created tasks.json
      if (effectiveNoBranch || effectivePrReview) {
        try {
          const plan = await loadTaskPlan(tasksPath);
          if (effectiveNoBranch) {
            plan.noBranch = true;
          }
          if (effectivePrReview) {
            plan.prReview = { ...plan.prReview, enabled: true, rounds: plan.prReview?.rounds ?? 0 };
          }
          await saveTaskPlan(tasksPath, plan);
        } catch {
          /* non-critical: tasks.json may not exist yet if plan phase didn't create it */
        }
      }
      // A queue shares one branch: the first issue's plan decides it, every
      // later issue has it written over whatever slug the agent derived from
      // its own title. The `execute` prompt then finds the branch already
      // checked out instead of creating a second one — the creation logic
      // itself is untouched.
      if (queue !== undefined && !effectiveNoBranch) {
        producedBranch = await adoptQueueBranch(tasksPath, queue.plan.branchName);
      }
    },
    execute: makeRunner(
      () => runExecute(undefined, { issue: issueNumber, commitScope: queueCommitScope }),
      'execute',
    ),
    review: async () => {
      // Read maxCorrectionCycles
      let maxCycles = 3;
      try {
        const plan = await loadTaskPlan(tasksPath);
        maxCycles = plan.maxCorrectionCycles;
      } catch {
        /* use default */
      }

      let code = await runReview(issueNumber, resolvedIssue);

      // Auto-correction loop on failure
      let cycle = 0;
      while (code !== 0 && cycle < maxCycles) {
        cycle++;
        printWarning(`Review failed. Starting correction cycle ${cycle}/${maxCycles}...`);
        publisher.publish({ type: 'correction:cycle', at: isoNow(), cycle, maxCycles });

        // Update correction cycle in tasks.json
        try {
          const plan = await loadTaskPlan(tasksPath);
          plan.correctionCycle = cycle;
          await saveTaskPlan(tasksPath, plan);
        } catch {
          /* non-critical */
        }

        // Re-execute
        const execCode = await runExecute(undefined, {
          issue: issueNumber,
          commitScope: queueCommitScope,
        });
        if (execCode !== 0) {
          throw new Error('Correction execution failed');
        }

        // Re-review
        code = await runReview(issueNumber, resolvedIssue);
      }

      if (code !== 0) {
        throw new Error(`Review failed after ${maxCycles} correction cycles`);
      }
    },
    pr: makeRunner(
      // The options argument is omitted outside a queue so a standalone run
      // calls `runPr` exactly as it always did.
      () =>
        finalPr === undefined
          ? runPr(issueNumber, resolvedIssue)
          : runPr(issueNumber, resolvedIssue, { queue: finalPr }),
      'pr',
    ),
  };

  // Filled by the pr-review runner; read after the pipeline finishes. Held in a
  // box because a `let` written only inside a closure keeps its initial `null`
  // narrowing at the read site.
  const reviewBox: { outcome: PrReviewOutcome | null } = { outcome: null };
  if (effectivePrReview) {
    runners['pr-review'] = async () => {
      // `yes` because the run is autonomous: the phase must never stop to ask
      // which Pull Request it is reviewing.
      const code = await runPrReview(undefined, { issue: issueNumber, yes: true });
      if (code === 1) {
        throw new Error('Phase pr-review failed with exit code 1');
      }
      // Exit code 2 is a verdict, not a failure: the review ran, the report is
      // on disk and the pipeline keeps going.
      reviewBox.outcome = await readPrReviewOutcome(issueNumber, tasksPath, code === 2);
    };
  }

  // Publish phase:start/phase:end around every runner without touching the
  // listr2 renderer (pipeline-renderer.ts stays publication-free). Commit/PR
  // enrichment happens only at these boundaries (and at iteration end, in
  // engine.ts) — never per HTTP request.
  const instrumentedRunners = Object.fromEntries(
    Object.entries(runners).map(([phase, fn]) => [
      phase,
      async () => {
        publisher.publish({ type: 'phase:start', at: isoNow(), phase });
        try {
          await fn();
          await publishGitState(publisher);
          publisher.publish({ type: 'phase:end', at: isoNow(), phase, success: true });
        } catch (err) {
          await publishGitState(publisher);
          publisher.publish({
            type: 'phase:end',
            at: isoNow(),
            phase,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    ]),
  );

  // Run pipeline with listr2 renderer — startup header printed above, summary below
  const result = await runPipelineWithRenderer({
    phases: phaseOrder,
    startIndex: startIdx,
    verbose: isVerbose(),
    runners: instrumentedRunners,
    tasksPath,
  });

  if (!result.success) {
    printError(`Phase ${result.failedPhase} failed`);
    return {
      ...failure(1),
      failedPhase: result.failedPhase ?? null,
      branchName: producedBranch,
      elapsedSeconds: result.overallElapsedSeconds,
    };
  }

  // A PR review asking for changes is not a pipeline failure, but the work is
  // not done either: the warning is highlighted and the issue stays open.
  const review = reviewBox.outcome;
  if (review?.requestedChanges) {
    console.log('');
    printWarning('PR review requested changes — the Pull Request is not ready to merge.');
    if (review.reportPath !== null) {
      console.log(`  Report: ${review.reportPath}`);
    }
  }

  // Close the issue through whoever owns it. A provider without close() (a
  // read-only origin) has nothing to do here, so the step is simply skipped.
  // REQUEST_CHANGES also leaves the local plan unfinished: marking
  // `issueStatus: completed` while `prReviewCompleted` is false would lie to
  // every tool that keys off the local status.
  // Inside a queue the issues are closed once, after the consolidated Pull
  // Request: closing one here would announce it as done while the branch that
  // carries its work has not even been proposed yet.
  if (review?.requestedChanges) {
    printInfo('Issue left open until the review blockers are addressed.');
  } else if (!inQueue) {
    await closeIssue(issueNumber, resolvedIssue.source);
  }

  // Get branch and story count
  let branchName = 'unknown';
  try {
    const proc = await execa('git', ['branch', '--show-current'], { reject: false });
    branchName = proc.stdout?.toString().trim() ?? 'unknown';
  } catch {
    /* non-critical */
  }

  let storyCount = 0;
  let planPrUrl: string | null = null;
  try {
    const plan = await loadTaskPlan(tasksPath);
    storyCount = plan.userStories.length;
    // The `pr` phase records the Pull Request it opened; trusting it spares a
    // round-trip to the GitHub CLI below.
    planPrUrl = plan.pullRequest?.url ?? null;

    plan.lastAttemptAt = isoNow();
    if (!review?.requestedChanges) {
      plan.issueStatus = 'completed';
      plan.completedAt = isoNow();
    }
    await saveTaskPlan(tasksPath, plan);
  } catch {
    /* non-critical */
  }

  // Inside a queue the run is not over: the summary, the Pull Request and the
  // totals belong to the queue, which prints them once at the end.
  if (inQueue) {
    if (finalPr === undefined) {
      printSuccess(`Issue #${issueNumber} completed (${storyCount} stories).`);
    }
    return {
      code: 0,
      failedPhase: null,
      branchName: producedBranch ?? (branchName === 'unknown' ? null : branchName),
      storyCount,
      elapsedSeconds: result.overallElapsedSeconds,
      review,
    };
  }

  // Get PR URL for summary. Only GitHub-hosted Issues have a pull request to
  // look up, and --no-branch never opens one. Falling back to the GitHub CLI
  // uses the branch actually checked out: a query without a head branch would
  // return an unrelated Pull Request.
  let prUrl = 'unknown';
  if (!effectiveNoBranch && resolvedIssue.source === 'github') {
    if (planPrUrl !== null) {
      prUrl = planPrUrl;
    } else if (branchName !== 'unknown' && branchName !== '') {
      try {
        const latest = mostRecent(await listPullRequests(branchName));
        if (latest !== null) {
          prUrl = latest.url;
        }
      } catch {
        /* non-critical */
      }
    }
  }

  printRunSummary({
    issueNumber,
    branchName,
    noBranch: effectiveNoBranch,
    storyCount,
    elapsedSeconds: result.overallElapsedSeconds,
    prUrl,
    prReview: review,
    // Process-owned counters: the session snapshot is empty whenever web
    // monitoring is off, so it cannot be the source of these totals.
    usage: getRunUsageTotals(),
  });

  return {
    code: 0,
    failedPhase: null,
    branchName: branchName === 'unknown' ? null : branchName,
    storyCount,
    elapsedSeconds: result.overallElapsedSeconds,
  };
}

interface DecideQueueInput {
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
async function decideQueue(input: DecideQueueInput): Promise<QueueDecision> {
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
      confirm: { yes: input.runOptions.yes, only: input.runOptions.only },
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
 */
async function runQueue(
  initialPlan: ExecutionPlan,
  options: { mode: string; from?: string; noBranch?: boolean; prReview?: boolean },
  resolvedPrimary?: ResolvedIssue,
): Promise<number> {
  const planFile = (await resolveQueuePaths(initialPlan.id)).planFile;
  let plan = initialPlan;

  const queueUsage = beginUsageScope();
  const startedAtMs = Date.now();
  const summaries: QueueIssueSummary[] = [];
  let firstOfThisRun = true;

  try {
    while (true) {
      const entry = nextQueueIssue(plan);
      if (entry === null) break;

      plan = markQueueIssueInProgress(plan, entry.id);
      await saveExecutionPlan(planFile, plan);

      printInfo(
        `Queue ${entry.position}/${plan.issues.length}: issue #${entry.id}${entry.title === '' ? '' : ` — ${entry.title}`}`,
      );

      const issueUsage = beginUsageScope();
      let result: IssueRunResult;
      try {
        result = await runIssueSession(entry.id, options.mode, {
          // `--from` addresses the issue the queue is resuming, never the ones
          // that come after it — those start from their own beginning.
          from: firstOfThisRun ? options.from : undefined,
          noBranch: options.noBranch,
          queue: {
            plan,
            planFile,
            entry,
            preChecked: true,
            resolved: entry.id === initialPlan.id ? resolvedPrimary : undefined,
          },
        });
      } finally {
        firstOfThisRun = false;
      }
      const usage = issueUsage.end();

      if (result.code !== 0) {
        plan = markQueueIssueFailed(plan, entry.id, {
          phase: result.failedPhase,
          error: {
            category: 'queue_issue_failed',
            message: `Issue #${entry.id} failed${result.failedPhase === null ? '' : ` in phase ${result.failedPhase}`}`,
            at: isoNow(),
          },
        });
        await saveExecutionPlan(planFile, plan);

        printError(
          `Queue stopped at issue #${entry.id}${result.failedPhase === null ? '' : ` (phase ${result.failedPhase})`}. ` +
            'The branch and every commit made so far were kept.',
        );
        printInfo(`Resume with: issue-flow run ${plan.requested.join(',')}`);
        return result.code;
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

    return await finishQueue(
      plan,
      planFile,
      summaries,
      startedAtMs,
      queueUsage.totals(),
      options,
      resolvedPrimary,
    );
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
  usage: ReturnType<typeof getRunUsageTotals>,
  options: { mode: string; noBranch?: boolean; prReview?: boolean },
  resolvedPrimary?: ResolvedIssue,
): Promise<number> {
  let current = plan;
  let review: PrReviewOutcome | null = null;

  // One Pull Request for the whole queue, and only when there is a branch to
  // propose and no Pull Request has been opened for this queue yet.
  if (!current.noBranch && options.noBranch !== true && current.pullRequest === undefined) {
    const outcome = await runIssueSession(current.id, options.mode, {
      prReview: options.prReview ?? current.prReview,
      queue: {
        plan: current,
        planFile,
        entry: current.issues[0] as ExecutionPlanIssue,
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
    usage,
    prReview: review,
  });

  return 0;
}

/**
 * The context the consolidated Pull Request needs: what was implemented, in
 * which order, and what is knowingly left pending.
 *
 * "Pending" is the honest half of the report — the issues the user chose not to
 * run, and any review findings still recorded on an issue's plan. Both would
 * otherwise be invisible to whoever reviews the Pull Request.
 */
async function buildPrQueueContext(plan: ExecutionPlan): Promise<PrQueueContext> {
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
async function propagatePullRequest(plan: ExecutionPlan): Promise<PullRequestRef | null> {
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

/** An {@link IssueRunResult} carrying nothing but an exit code. */
function failure(code: number): IssueRunResult {
  return { code, failedPhase: null, branchName: null, storyCount: 0, elapsedSeconds: 0 };
}

/**
 * Close an Issue through whoever owns it.
 *
 * A provider without `close()` (a read-only origin) has nothing to do here, so
 * the step is simply skipped, and a failure is a warning: the work is done
 * either way, and an Issue left open is a nuisance, not a broken pipeline.
 */
async function closeIssue(issueNumber: string, source: IssueSource): Promise<void> {
  try {
    const provider = getProvider(source);
    if (provider.close !== undefined) {
      printInfo('Closing issue...');
      await provider.close(issueNumber);
    }
  } catch {
    printWarning('Failed to close issue automatically');
  }
}

/**
 * Make an issue's task plan use the queue's branch.
 *
 * With no branch decided yet, whatever the `plan` phase produced becomes the
 * queue's branch (the first issue names it, from its own title). From then on
 * the value is written over every later issue's plan, so `execute.md`'s
 * "check it out or create from main" finds the branch already there.
 */
async function adoptQueueBranch(
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
