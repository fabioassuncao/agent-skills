import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execa } from 'execa';
import { describeRunAgents, hasExplicitAgentSelection } from '../agents/resolve.js';
import {
  getActiveResilienceConfig,
  getAgentCliOverrides,
  loadAgentConfig,
  loadIssuesConfig,
  loadRoutingConfig,
} from '../config.js';
import { PIPELINE_PHASES, PipelineManager, type PipelinePhase } from '../core/pipeline.js';
import { mostRecent } from '../core/pr-review/discovery.js';
import {
  type PrReviewRoundEntry,
  prReviewDir,
  readPrReviewIndex,
} from '../core/pr-review/report.js';
import { listPullRequests, publishGitState } from '../core/session-git.js';
import { getRunUsageTotals } from '../core/session-metrics.js';
import { getSessionPublisher } from '../core/session-publisher.js';
import type { SessionConfigurationSnapshot, SessionPublisher } from '../core/session-state.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { isVerbose } from '../core/verbose.js';
import { backgroundRejection } from '../execution/detach.js';
import { parseIssueArguments } from '../issues/args.js';
import { resolveCommandIssue } from '../issues/context.js';
import { recommendedTarget } from '../routing/policy.js';
import { bindDiagnosticContext } from '../storage/diagnostics.js';
import { describeRunLockOwner } from '../storage/lock.js';
import type { IssuePaths } from '../storage/paths.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/logger.js';
import { runPipelineWithRenderer } from '../ui/pipeline-renderer.js';
import { printRunSummary } from '../ui/summary.js';
import { getCurrentBranch, getHeadCommit, localBranchExists } from '../utils/git.js';
import { getPackageVersion } from '../version.js';
import { runExecute } from './execute.js';
import { runInit } from './init.js';
import { runPlan } from './plan.js';
import { runPr } from './pr.js';
import { runPrReview } from './pr-review.js';
import { runPrd } from './prd.js';
import { runReview } from './review.js';
import { adoptQueueBranch, decideQueue, detachAfterConfirm, runQueue } from './run/multi-issue.js';
import {
  type PersistedPlanFlags,
  resolveBranchAndReviewModes,
  resolveExecuteRetry,
  resolveStoryNumbering,
  selectPhaseLists,
} from './run/phase-options.js';
import {
  publishInstrumentedPhaseEnd,
  publishIssueDetails,
  publishStorySeed,
  toIssueNumber,
} from './run/publish.js';
import { closeIssue } from './run/pull-request.js';
import {
  claimRunOwnership,
  ensureRepositoryWritable,
  runIssueSession as runIssueSessionImpl,
} from './run/session.js';
import {
  failure,
  type IssueRunResult,
  type IssueSessionInput,
  type PrReviewOutcome,
  type RunPipelineOptions,
} from './run/types.js';

export { publishIssueDetails, publishStorySeed } from './run/publish.js';
export type { QueueFailureMode, RunPipelineOptions } from './run/types.js';

/** Bound session entry that closes over this module's phase orchestrator. */
const runIssueSession: import('./run/types.js').RunIssueSession = (issueNumber, mode, input) =>
  runIssueSessionImpl(issueNumber, mode, input, runPipelinePhases);

function verificationForSummary(
  value: {
    verdict: 'passed' | 'failed' | 'unverified' | null;
    level: string | null;
  } | null,
): { verdict: 'passed' | 'failed' | 'unverified'; level: string | null } | null {
  if (value === null || value.verdict === null) return null;
  return { verdict: value.verdict, level: value.level };
}

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

  if (options.background === true && options.detachedChild !== true) {
    const reason = backgroundRejection(mode);
    if (reason !== null) {
      printError(reason);
      return 1;
    }
    return detachAfterConfirm(requested, noBranch, prReview, options);
  }

  // Ownership of the run, for the whole invocation — a queue is one run, not
  // one per issue. Two invocations in the same repository share a working tree
  // and a branch, so "a different issue" is not a different lock.
  const ownership = await claimRunOwnership(requested[0] as string, options.detachedChild === true);
  if (!ownership.ok) {
    printError(
      `Another issue-flow run owns this project: ${describeRunLockOwner(ownership.owner)}.`,
    );
    printInfo('Wait for it to finish, or stop that process before running again.');
    return 1;
  }

  try {
    const first = await runIssueSession(requested[0] as string, mode, {
      from,
      noBranch,
      prReview,
      requested,
      runOptions: options,
      restartWeb: options.restartWeb,
      ...(ownership.interruptedBy === null ? {} : { interruptedBy: ownership.interruptedBy }),
    });

    if (first.queue === undefined) {
      return first.code;
    }

    return runQueue(
      first.queue.plan,
      { mode, from, noBranch, prReview, runOptions: options },
      first.queue.resolved,
      runIssueSession,
    );
  } finally {
    await ownership.release();
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
  const { continueNumbering, startUs } = resolveStoryNumbering(input.runOptions);
  const executeRetry = resolveExecuteRetry(input.runOptions);
  const tasksPath = paths.tasksFile;
  const sessionId = randomUUID();
  bindDiagnosticContext({
    sessionId,
    issue: issueNumber,
    executionId: null,
    phase: null,
    story: null,
    harness: null,
    model: null,
  });
  const [initialBranch, initialCommit] = await Promise.all([
    getCurrentBranch().catch(() => ''),
    getHeadCommit(),
  ]);

  // Refined with the provider's own number once the Issue is resolved.
  let publishedIssueNumber = toIssueNumber(issueNumber);

  const publishSessionStart = (
    phases: readonly string[],
    at: string,
    info?: {
      issueUrl?: string;
      branch?: string;
      branchCreated?: boolean | null;
      startCommit?: string | null;
    },
  ): void => {
    publisher.publish({
      type: 'session:start',
      at,
      sessionId,
      issueNumber: publishedIssueNumber,
      issueUrl: info?.issueUrl,
      branch: info?.branch,
      branchCreated: info?.branchCreated,
      startCommit: info?.startCommit,
      phases: [...phases],
      configuration: configurationSnapshot,
      environment: {
        node: process.version,
        platform: process.platform,
        agent: agentSummary.defaultProvider,
        model: agentSummary.defaultModel,
        cliVersion: getPackageVersion(),
      },
    });
  };

  const agentSummary = await describeRunAgents(
    prReview
      ? ['prd', 'plan', 'execute', 'review', 'pr', 'pr-review']
      : ['prd', 'plan', 'execute', 'review', 'pr'],
  );
  const fallbacks = getActiveResilienceConfig().providers?.chain ?? [];
  const routingConfig = await loadRoutingConfig();
  const agentConfig = await loadAgentConfig();
  const displayedPhases = Object.entries(agentSummary.byPhase).map(([phase, resolved]) => {
    const recommended =
      routingConfig.mode === 'active' &&
      routingConfig.policy === 'recommended' &&
      !hasExplicitAgentSelection(
        agentConfig,
        getAgentCliOverrides(),
        phase as keyof typeof agentSummary.byPhase,
      )
        ? recommendedTarget(phase as keyof typeof agentSummary.byPhase)
        : null;
    return {
      phase,
      provider: recommended?.provider ?? resolved.provider,
      model: recommended?.model ?? resolved.model,
      providerSource: recommended ? ('recommended' as const) : resolved.origin.provider,
      modelSource: recommended ? ('recommended' as const) : resolved.origin.model,
    };
  });
  const configurationSnapshot: SessionConfigurationSnapshot = {
    precedence: ['default', 'global', 'project', 'env', 'cli', 'step override'],
    defaultProvider: {
      value: agentSummary.defaultProvider,
      source: agentSummary.defaultOrigin.provider,
    },
    defaultModel: {
      value: agentSummary.defaultModel,
      source: agentSummary.defaultOrigin.model,
    },
    phases: displayedPhases.map((resolved) => ({
      phase: resolved.phase,
      provider: { value: resolved.provider, source: resolved.providerSource },
      model: { value: resolved.model, source: resolved.modelSource },
    })),
    fallbacks,
    overrides: displayedPhases
      .filter(
        (resolved) =>
          resolved.provider !== agentSummary.defaultProvider ||
          resolved.model !== agentSummary.defaultModel,
      )
      .map(
        (resolved) =>
          `${resolved.phase}: ${resolved.provider}${resolved.model ? ` · ${resolved.model}` : ''}`,
      ),
  };
  printInfo(
    `Issue Flow v${getPackageVersion()} · starting pipeline for issue #${issueNumber} (mode: ${mode}, agent: ${agentSummary.label})`,
  );

  // Loaded before the checks so init knows which origin the user is heading
  // for: with a local one, a missing gh must not fail the environment.
  const issuesConfig = await loadIssuesConfig();

  // Phase 1: Init check. Inside a queue it already ran for the whole run, so
  // the environment is not probed once per issue — the phase is still
  // published, keeping every issue's session shape identical.
  const sessionStartedAt = isoNow();
  if (queue?.preChecked !== true) {
    if (isVerbose()) {
      printInfo('Running prerequisite checks...');
    }
    const initCode = await runInit(issuesConfig.preferredProvider, { compact: !isVerbose() });
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

  // Resolve noBranch / pr-review against any persisted plan (precedences differ —
  // see resolveBranchAndReviewModes).
  let persistedFlags: PersistedPlanFlags | null = null;
  try {
    const existingPlan = await loadTaskPlan(tasksPath);
    persistedFlags = {
      noBranch: existingPlan.noBranch ?? false,
      prReviewEnabled: existingPlan.prReview?.enabled ?? false,
      issueUrl: existingPlan.issueUrl || undefined,
      branchName: existingPlan.branchName || undefined,
      userStories: existingPlan.userStories,
    };
  } catch {
    // No tasks.json yet — resolvers use the CLI flag as-is
  }

  const modes = resolveBranchAndReviewModes({
    noBranch,
    prReview,
    persisted: persistedFlags,
  });
  for (const warning of modes.warnings) {
    printWarning(warning);
  }
  const { effectiveNoBranch, effectivePrReview } = modes;
  const planIssueUrl = modes.planIssueUrl;
  let planBranch = modes.planBranch;
  const planStories = modes.planStories;

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

  const inQueue = queue !== undefined;
  const finalPr = queue?.finalPr;
  const { activePhases, phaseOrder } = selectPhaseLists({
    finalPr: finalPr !== undefined,
    inQueue,
    effectiveNoBranch,
    effectivePrReview,
  });

  // Commit scope for this issue's stories: only a queue needs one, because
  // only there do several issues share a branch (and therefore a `git log`).
  const queueCommitScope = queue === undefined ? undefined : `issue-${issueNumber}`;
  // Branch this issue will work on, reported back so the queue can adopt the
  // first issue's choice for every later one.
  let producedBranch: string | null = null;
  let plannedExecutionBranch: string | null = planBranch ?? null;
  let branchExistedBeforeExecution =
    effectiveNoBranch || planBranch === undefined || planBranch === null
      ? null
      : await localBranchExists(planBranch).catch(() => null);

  // Adopted **before** the phases run, not only after `plan`: an issue whose
  // plan phase is already complete (it was run standalone before joining the
  // queue, or the queue is being resumed) never re-enters the plan runner, and
  // would otherwise send `execute` at a branch of its own.
  if (queue !== undefined && finalPr === undefined && !effectiveNoBranch) {
    producedBranch = await adoptQueueBranch(tasksPath, queue.plan.branchName);
    if (producedBranch !== null) {
      planBranch = producedBranch;
    }
  }

  // The phase list is only known after resolving --no-branch, so the init
  // phase (which already ran) is published retroactively with real timestamps.
  publishSessionStart(activePhases, sessionStartedAt, {
    issueUrl: planIssueUrl ?? resolvedIssue.issue.remoteRef ?? undefined,
    branch: effectiveNoBranch ? initialBranch : planBranch,
    branchCreated: effectiveNoBranch ? false : branchExistedBeforeExecution === true ? false : null,
    startCommit: initialCommit,
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

  // Build phase runner functions that throw on failure
  const makeRunner = (fn: () => Promise<number>, phase: string) => async () => {
    await ensureRepositoryWritable(phase);
    const code = await fn();
    if (code !== 0) {
      throw new Error(`Phase ${phase} failed with exit code ${code}`);
    }
  };

  const runners: Record<string, () => Promise<void>> = {
    prd: makeRunner(() => runPrd(issueNumber, resolvedIssue), 'prd'),
    plan: async () => {
      await makeRunner(
        () =>
          runPlan(issueNumber, resolvedIssue, {
            continueFlag: continueNumbering,
            startUs,
            ...(effectiveNoBranch && initialBranch ? { branchName: initialBranch } : {}),
          }),
        'plan',
      )();
      // Read the newly-created plan once: publish its stories immediately so
      // the first execute iteration never points at a story absent from the
      // snapshot, and persist phase-selection modes from the same object.
      try {
        const plan = await loadTaskPlan(tasksPath);
        if (!effectiveNoBranch) {
          plannedExecutionBranch = plan.branchName;
          branchExistedBeforeExecution = await localBranchExists(plan.branchName).catch(() => null);
          publisher.publish({
            type: 'git:update',
            at: isoNow(),
            branchCreated: branchExistedBeforeExecution === true ? false : null,
          });
        }
        publishStorySeed(publisher, plan.userStories, isoNow());
        if (effectiveNoBranch || effectivePrReview) {
          if (effectiveNoBranch) plan.noBranch = true;
          if (effectivePrReview) {
            plan.prReview = { ...plan.prReview, enabled: true, rounds: plan.prReview?.rounds ?? 0 };
          }
          await saveTaskPlan(tasksPath, plan);
        }
      } catch {
        /* non-critical: tasks.json may not exist yet if plan phase didn't create it */
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
      () =>
        runExecute(undefined, {
          issue: issueNumber,
          commitScope: queueCommitScope,
          ...executeRetry,
        }),
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
          ...executeRetry,
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
          if (
            phase === 'execute' &&
            branchExistedBeforeExecution === false &&
            plannedExecutionBranch !== null &&
            (await getCurrentBranch().catch(() => '')) === plannedExecutionBranch
          ) {
            publisher.publish({ type: 'git:update', at: isoNow(), branchCreated: true });
          }
          await publishGitState(publisher);
          await publishInstrumentedPhaseEnd(publisher, phase, issueNumber, true);
        } catch (err) {
          await publishGitState(publisher);
          await publishInstrumentedPhaseEnd(
            publisher,
            phase,
            issueNumber,
            false,
            err instanceof Error ? err.message : String(err),
          );
          throw err;
        }
      },
    ]),
  );

  // Run pipeline with listr2 renderer — startup header printed above, summary below
  const phaseSuffixes: Record<string, string> = {};
  for (const [phase, resolved] of Object.entries(agentSummary.byPhase)) {
    if (resolved.provider !== agentSummary.defaultProvider) {
      phaseSuffixes[phase] = resolved.model
        ? `${resolved.provider} · ${resolved.model}`
        : resolved.provider;
    }
  }

  const result = await runPipelineWithRenderer({
    phases: phaseOrder,
    startIndex: startIdx,
    verbose: isVerbose(),
    runners: instrumentedRunners,
    tasksPath,
    phaseSuffixes,
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
    verification: verificationForSummary(getSessionPublisher().snapshot().verification),
  });

  return {
    code: 0,
    failedPhase: null,
    branchName: branchName === 'unknown' ? null : branchName,
    storyCount,
    elapsedSeconds: result.overallElapsedSeconds,
  };
}
