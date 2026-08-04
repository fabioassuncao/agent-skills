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
import { getRunUsageTotals } from '../core/session-metrics.js';
import { setSessionPublisher } from '../core/session-publisher.js';
import { FilePublisher, NullPublisher, type SessionPublisher } from '../core/session-state.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { isVerbose } from '../core/verbose.js';
import { resolveCommandIssue } from '../issues/context.js';
import { getProvider } from '../issues/registry.js';
import type { Issue } from '../issues/types.js';
import type { IssuePaths } from '../storage/paths.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import type { UserStory } from '../types.js';
import { printError, printInfo, printWarning } from '../ui/logger.js';
import { runPipelineWithRenderer } from '../ui/pipeline-renderer.js';
import { printRunSummary, type RunSummaryPrReview } from '../ui/summary.js';
import { startWebServer, type WebServerHandle } from '../web/server.js';
import { runExecute } from './execute.js';
import { runInit } from './init.js';
import { runPlan } from './plan.js';
import { runPr } from './pr.js';
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

export async function runPipeline(
  issue: string,
  mode: string,
  from?: string,
  noBranch?: boolean,
  prReview?: boolean,
): Promise<number> {
  const issueNumber = issue.replace(/^#/, '');
  // Resolved once, at the top: every phase that runs below shares the process
  // cache, so the git call and the legacy migration happen a single time for
  // the whole run instead of once per phase.
  const paths = await resolveIssuePaths(issueNumber);

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
  let webServer: WebServerHandle | null = null;
  if (webConfig.enabled) {
    webServer = await startWebServer({
      publisher,
      port: webConfig.port,
      host: webConfig.host,
      refreshSeconds: webConfig.refreshSeconds,
    });
  }

  let exitCode = 1;
  try {
    exitCode = await runPipelinePhases(
      issueNumber,
      paths,
      mode,
      publisher,
      from,
      noBranch,
      prReview,
    );
    return exitCode;
  } finally {
    publisher.publish({
      type: 'session:end',
      at: isoNow(),
      status: exitCode === 0 ? 'completed' : 'failed',
    });
    await webServer?.close();
    await publisher.close();
    setSessionPublisher(undefined);
  }
}

async function runPipelinePhases(
  issueNumber: string,
  paths: IssuePaths,
  mode: string,
  publisher: SessionPublisher,
  from?: string,
  noBranch?: boolean,
  prReview?: boolean,
): Promise<number> {
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

  // Phase 1: Init check
  printInfo('Running prerequisite checks...');
  const sessionStartedAt = isoNow();
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
    return 1;
  }

  // The origin is settled once, here, and the decision travels to every phase.
  // Resolving per phase would query the providers five times and could ask the
  // user about the same divergence five times.
  const resolution = await resolveCommandIssue(issueNumber, undefined, { config: issuesConfig });
  if (!resolution.ok) {
    return resolution.code;
  }
  const resolvedIssue = resolution.resolved;
  publishedIssueNumber = resolvedIssue.issue.number;

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

  const activePhases = effectiveNoBranch
    ? PIPELINE_PHASES_NO_BRANCH
    : effectivePrReview
      ? PIPELINE_PHASES_WITH_PR_REVIEW
      : PIPELINE_PHASES;
  const phaseOrder = effectiveNoBranch
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
      return 1;
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
        return 1;
      }
    } catch {
      if (startPhase !== 'prd') {
        printError(`Cannot resume from ${startPhase}: no pipeline state found`);
        return 1;
      }
    }
  }

  const startIdx = phaseOrder.indexOf(startPhase);

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
    },
    execute: makeRunner(() => runExecute(undefined, { issue: issueNumber }), 'execute'),
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
        const execCode = await runExecute(undefined, { issue: issueNumber });
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
    pr: makeRunner(() => runPr(issueNumber, resolvedIssue), 'pr'),
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
    return 1;
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
  if (review?.requestedChanges) {
    printInfo('Issue left open until the review blockers are addressed.');
  } else {
    try {
      const provider = getProvider(resolvedIssue.source);
      if (provider.close !== undefined) {
        printInfo('Closing issue...');
        await provider.close(issueNumber);
      }
    } catch {
      printWarning('Failed to close issue automatically');
    }
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

  return 0;
}
