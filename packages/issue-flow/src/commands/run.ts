import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { resetAgentInvocationState } from '../agents/invoke.js';
import { describeRunAgents, hasExplicitAgentSelection } from '../agents/resolve.js';
import {
  getActiveResilienceConfig,
  getAgentCliOverrides,
  initResilienceConfig,
  loadAgentConfig,
  loadIssuesConfig,
  loadRoutingConfig,
  loadWebConfig,
} from '../config.js';
import { JournalPublisher, MultiPublisher } from '../core/journal.js';
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
import { getSessionPublisher, setSessionPublisher } from '../core/session-publisher.js';
import {
  FilePublisher,
  MemoryPublisher,
  type SessionConfigurationSnapshot,
  type SessionPublisher,
} from '../core/session-state.js';
import { onShutdown } from '../core/shutdown.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getInactivityTimeout, isVerbose, setInactivityTimeout } from '../core/verbose.js';
import { backgroundRejection, spawnDetachedRun } from '../execution/detach.js';
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
} from '../execution/plan.js';
import { planQueue, type QueueDecision } from '../execution/queue.js';
import type { ExecutionPlan } from '../execution/types.js';
import { parseIssueArguments } from '../issues/args.js';
import { resolveCommandIssue } from '../issues/context.js';
import type { ResolvedIssue } from '../issues/types.js';
import { recommendedTarget } from '../routing/policy.js';
import {
  bindDiagnosticContext,
  flushDiagnostics,
  writeDiagnostic,
} from '../storage/diagnostics.js';
import { acquireRunLock, describeRunLockOwner } from '../storage/lock.js';
import type { IssuePaths } from '../storage/paths.js';
import { resolveIssuePaths, resolveProjectPaths, resolveQueuePaths } from '../storage/resolve.js';
import type { RunLock } from '../storage/schemas.js';
import type { UserStory } from '../types.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/logger.js';
import { runPipelineWithRenderer } from '../ui/pipeline-renderer.js';
import { printQueueSummary, printRunSummary, type QueueIssueSummary } from '../ui/summary.js';
import {
  describePreflight,
  getCurrentBranch,
  getHeadCommit,
  getProjectRoot,
  localBranchExists,
  preflightRepository,
} from '../utils/git.js';
import { getPackageVersion } from '../version.js';
import { ensureWebMonitor } from '../web/lock.js';
import { runExecute } from './execute.js';
import { runInit } from './init.js';
import { runPlan } from './plan.js';
import { runPr } from './pr.js';
import { runPrReview } from './pr-review.js';
import { runPrd } from './prd.js';
import { runReview } from './review.js';
import { reportIfOversized } from './run/oversized.js';
import {
  publishInstrumentedPhaseEnd,
  publishIssueDetails,
  publishStorySeed,
  toIssueNumber,
} from './run/publish.js';
import {
  buildPrQueueContext,
  closeIssue,
  primaryPrCreated,
  propagatePullRequest,
} from './run/pull-request.js';
import {
  type IssueRunResult,
  type PrReviewOutcome,
  QUEUE_PR_PHASES,
  QUEUE_PR_PHASES_WITH_REVIEW,
  type QueueFailureMode,
  type QueueRunContext,
  RUNNABLE_PHASES,
  RUNNABLE_PHASES_NO_BRANCH,
  RUNNABLE_PHASES_WITH_PR_REVIEW,
  RUNNABLE_QUEUE_PR_PHASES,
  RUNNABLE_QUEUE_PR_PHASES_WITH_REVIEW,
} from './run/types.js';

export { publishIssueDetails, publishStorySeed } from './run/publish.js';
export type { QueueFailureMode } from './run/types.js';

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

/** Options `run` accepts on top of the phase selection ones. */
export interface RunPipelineOptions {
  /** `--yes`: accept the discovered hierarchy without confirmation. */
  yes?: boolean;
  /** `--only`: run just the issues informed, skipping discovery. */
  only?: boolean;
  /** `--cascade`: hierarchy of a container, without implementing it. */
  cascade?: boolean;
  /** `--background`: parent process should detach after confirmation. */
  background?: boolean;
  /** Hidden: this process is the child of a `--background` spawn. */
  detachedChild?: boolean;
  /** `--restart-web`: replace the machine-wide monitor once for this invocation. */
  restartWeb?: boolean;
  /** `--continue`: name the (automatic) User Story numbering continuity. */
  continueNumbering?: boolean;
  /** `--start-us <n>`: force the first plan of this run to start at `n`. */
  startUs?: number;
  /**
   * `--retry-limit <n>`: consecutive retries the `execute` phase may spend on a
   * transient failure. Absent means the engine default (`DEFAULTS.retryLimit`),
   * which is what every release before this flag existed used.
   */
  retryLimit?: number;
  /** `--retry-forever`: lift the retry count of the `execute` phase. */
  retryForever?: boolean;
  /**
   * `--on-issue-failure <mode>`: what one failing Issue does to the rest of a
   * queue. `stop` is the default and the behaviour of every release before the
   * flag existed.
   */
  onIssueFailure?: QueueFailureMode;
}

/** Attempts an Issue gets before the queue stops handing it out. */
const DEFAULT_MAX_ISSUE_ATTEMPTS = 2;

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
    );
  } finally {
    await ownership.release();
  }
}

/**
 * Phases that write to the repository — the working tree, the branch, or the
 * remote. The read-only ones (`init`, `prd`, `review`) produce artifacts under
 * the global storage and cannot be hurt by, nor hurt, a repository mid-rebase.
 */
const WRITING_PHASES: ReadonlySet<string> = new Set(['plan', 'execute', 'pr']);

/**
 * Refuse to hand the repository to an agent while it is in a state a human has
 * to settle first.
 *
 * **Nothing is repaired here.** A rebase in progress, an unresolved conflict, a
 * detached HEAD or a branch that is not the plan's are reported with the
 * command that gets out of them, and the phase fails. That is the Epic's second
 * limit: no destructive operation is ever run automatically to fix state, and
 * "the tool aborted my rebase overnight" is exactly the outcome it forbids.
 *
 * Two of the checks are deliberately left to `resume` rather than run here:
 *
 * - a **dirty tree** does not block mid-pipeline, because the phases of one run
 *   follow each other by design and uncommitted work between them is the
 *   pipeline's own doing;
 * - the **branch** is not compared either, because within a run the `plan`
 *   phase is what creates and checks it out, and a queue adopts a shared branch
 *   after its own plan ran.
 *
 * `resume` reads both strictly, because there the repository may have been
 * touched by anything at all in between.
 */
async function ensureRepositoryWritable(phase: string): Promise<void> {
  if (!WRITING_PHASES.has(phase)) return;

  const preflight = await preflightRepository({ intent: 'resume-same-phase' });
  if (preflight.ok) return;

  for (const line of describePreflight(preflight)) {
    printError(line);
  }
  throw new Error(`The repository is not in a state the ${phase} phase can write to`);
}

type RunOwnership =
  | { ok: true; interruptedBy: RunLock | null; release: () => Promise<void> }
  | { ok: false; owner: RunLock };

/**
 * Take the project's run lock, or report who holds it.
 *
 * A project whose storage cannot be resolved at all (no git repository yet, no
 * home directory) runs **without** a lock rather than not running: the guard
 * exists to stop two runs from colliding, and it must never be the reason a
 * single run cannot start.
 */
async function claimRunOwnership(target: string, detached = false): Promise<RunOwnership> {
  let lockFile: string;
  try {
    lockFile = (await resolveProjectPaths()).runLockFile;
  } catch {
    return { ok: true, interruptedBy: null, release: async () => {} };
  }

  const result = await acquireRunLock(lockFile, { target, detached });
  if (!result.ok) return result;

  return {
    ok: true,
    interruptedBy: result.handle.reclaimedFrom,
    release: () => result.handle.release(),
  };
}

interface IssueSessionInput {
  from?: string;
  noBranch?: boolean;
  prReview?: boolean;
  /** Identifiers the user asked for; only the standalone attempt needs them. */
  requested?: string[];
  runOptions?: RunPipelineOptions;
  /** One-shot restart request; queue members after the first never inherit it. */
  restartWeb?: boolean;
  queue?: QueueRunContext;
  /**
   * The dead owner whose lock this run took over. Recorded in the journal as
   * an interrupted run: something was executing here and never finished, and
   * that is the difference between a resume and a fresh start.
   */
  interruptedBy?: RunLock;
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
  resetAgentInvocationState();
  // Resolved once, at the top: every phase that runs below shares the process
  // cache, so the git call and the legacy migration happen a single time for
  // the whole run instead of once per phase.
  const paths = await resolveIssuePaths(issueNumber);
  try {
    const project = await resolveProjectPaths();
    bindDiagnosticContext({
      project: project.projectId,
      projectRoot: await getProjectRoot(),
      issue: issueNumber,
      sessionId: null,
      executionId: null,
      phase: null,
      story: null,
      harness: null,
      model: null,
    });
  } catch {}

  // The `resilience` key, installed once for the whole run. Every `gh` call
  // below reads it synchronously (`getActiveResilienceConfig()`), so it has to
  // be in place before the first phase resolves the Issue — and the journal
  // decision below is the first thing that reads it. Absent configuration
  // leaves the base table, so this is a no-op for a project that configured
  // nothing.
  const resilience = await initResilienceConfig();

  // The watchdog budget, when the project configured one and the CLI did not
  // override it. A flag wins because it is the higher rung of the same ladder.
  const configuredInactivity = resilience.watchdog?.inactivityTimeoutMs;
  if (configuredInactivity !== undefined && getInactivityTimeout() === undefined) {
    setInactivityTimeout(configuredInactivity);
  }

  // Read per issue rather than cached for the process: the configuration is
  // per project and cheap to read, and a cached value would leak a `--web`
  // decision from one invocation into the next inside the same process.
  const webConfig = await loadWebConfig();

  // Two independent surfaces over one event stream: the snapshot the dashboard
  // reads, and the append-only journal an audit reads. Neither implies the
  // other — `--web` without a journal is the common case, and a journal
  // without `--web` is what an unattended run wants.
  const surfaces: SessionPublisher[] = [];
  const journalEnabled = resilience.journal?.enabled === true;
  const persistSnapshot = webConfig.enabled || input.runOptions?.detachedChild === true;
  if (persistSnapshot || journalEnabled) {
    // resolveIssuePaths never creates directories, and a run may well be the
    // first thing to touch this issue's global folder — so the writer creates
    // it. Only when a surface asked for it: with monitoring off and no journal
    // the pipeline still creates nothing at all (issue 25, US-009).
    await mkdir(paths.issueDir, { recursive: true });
  }
  if (persistSnapshot) {
    surfaces.push(
      new FilePublisher(paths.sessionFile, {
        logLimit: webConfig.logLimit,
        includeLogs: webConfig.includeLogs,
      }),
    );
  }
  if (journalEnabled) {
    surfaces.push(
      new JournalPublisher(paths.eventsFile, paths.rotatedEventsFile, {
        logLimit: webConfig.logLimit,
        includeLogs: webConfig.includeLogs,
        ...(resilience.journal?.maxFileBytes === undefined
          ? {}
          : { maxFileBytes: resilience.journal.maxFileBytes }),
      }),
    );
  }
  // The snapshot writer stays the primary surface, so `snapshot()` and
  // `version()` keep answering exactly what the dashboard answered before.
  // With no disk surface the reducer still runs in memory: the terminal
  // renders that snapshot, and US-009 is preserved because nothing is written.
  const publisher: SessionPublisher =
    surfaces.length === 0
      ? new MemoryPublisher()
      : surfaces.length === 1
        ? (surfaces[0] as SessionPublisher)
        : new MultiPublisher(surfaces);
  setSessionPublisher(publisher);

  // Recorded through the publisher rather than printed, so it lands in the
  // journal beside the events of the run that replaced it.
  if (input.interruptedBy !== undefined) {
    const previous = input.interruptedBy;
    publisher.publish({
      type: 'log',
      at: isoNow(),
      level: 'warn',
      message: `Previous run interrupted: ${describeRunLockOwner(previous)}. Its lock was stale and has been taken over.`,
    });
  }

  // A null handle (port in use, ...) means the pipeline runs without a server.
  // ensureWebMonitor reuses an already-running, healthy instance instead of
  // binding a second one (US-001), or spawns it detached when none exists
  // (US-002) — either way the returned handle never owns a local server that
  // this process would need to close.
  if (webConfig.enabled) {
    await ensureWebMonitor(
      {
        publisher,
        port: webConfig.port,
        host: webConfig.host,
        refreshSeconds: webConfig.refreshSeconds,
      },
      { restart: input.restartWeb === true },
    );
  }

  let result: IssueRunResult = {
    code: 1,
    failedPhase: null,
    branchName: null,
    storyCount: 0,
    elapsedSeconds: 0,
  };

  // What a `Ctrl+C` leaves behind. Registered for the duration of this issue
  // only — a queue runs several, and each must checkpoint its own plan — and
  // deliberately split across the two shutdown phases: the state is written
  // while the agent is still alive, and the surfaces are closed after it is
  // gone, so nothing the checkpoint published is lost on the way out.
  const releaseCheckpoint = onShutdown({
    phase: 'checkpoint',
    run: async () => {
      await pauseIssue(paths.tasksFile, issueNumber);
      publisher.publish({
        type: 'log',
        at: isoNow(),
        level: 'warn',
        message: `Interrupted during issue #${issueNumber}. A checkpoint was saved; resume with \`issue-flow resume ${issueNumber}\`.`,
      });
      publisher.publish({ type: 'session:end', at: isoNow(), status: 'failed' });
    },
  });
  const releaseClose = onShutdown({
    phase: 'close',
    run: async () => {
      await publisher.close();
    },
  });

  try {
    result = await runPipelinePhases(issueNumber, paths, mode, publisher, input);
    if (result.code !== 0) {
      await reportIfOversized(issueNumber, paths, result);
    }
    return result;
  } finally {
    releaseCheckpoint();
    releaseClose();
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
    writeDiagnostic({
      level: result.code === 0 ? 'info' : 'error',
      message: `Issue Flow session ${result.code === 0 ? 'completed' : 'failed'}`,
      context: { code: result.code, failedPhase: result.failedPhase },
    });
    await flushDiagnostics();
    setSessionPublisher(undefined);
  }
}

/**
 * Mark an interrupted issue as paused, in the one place resumption reads.
 *
 * `pipeline` still says which phases finished — that is what `resume` continues
 * from — and `runState` is what says *why* the run is not running: paused by a
 * person, not failed, not still going. Before this field, a `Ctrl+C` left
 * `issueStatus: 'in_progress'` and nothing else, and the difference between
 * "someone stopped it" and "it died" was unrecoverable.
 *
 * Never throws: a checkpoint that cannot be written must not stop the rest of
 * the shutdown, and the phases already marked complete are still on disk.
 */
async function pauseIssue(tasksFile: string, issueNumber: string): Promise<void> {
  try {
    const plan = await loadTaskPlan(tasksFile);
    await saveTaskPlan(tasksFile, {
      ...plan,
      runState: {
        ...(plan.runState ?? {
          currentPhase: null,
          attempt: 0,
          lastHeartbeatAt: null,
          blockedReason: null,
          owner: null,
        }),
        status: 'paused',
        lastHeartbeatAt: isoNow(),
      },
    });
  } catch {
    // No plan yet (interrupted before the `plan` phase), or an unreadable one.
    printWarning(`Could not write a checkpoint for issue #${issueNumber}.`);
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
  // User Story numbering flags (issue #36). `--start-us` names a starting
  // point, so the queue only ever hands it to the first issue it runs —
  // applying it to each one would give them all the same ids, the very
  // collision #36 set out to remove. Every later issue continues from history,
  // which by then already includes the plans written earlier in this run.
  const continueNumbering = input.runOptions?.continueNumbering;
  const startUs = input.runOptions?.startUs;
  // Retry budget of the `execute` phase (`--retry-limit`, `--retry-forever`).
  // Left `undefined` when the flags are absent so `createConfig()` applies the
  // engine defaults — passing a number here would make `run` diverge from
  // `execute` the moment one of those defaults changes.
  const executeRetry = {
    retryLimit: input.runOptions?.retryLimit,
    retryForever: input.runOptions?.retryForever,
  };
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
/**
 * Confirm the queue (if needed) and spawn the same command without `--background`.
 * The child acquires the lock with `detached: true` and writes `run.log`.
 */
async function detachAfterConfirm(
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
  options: {
    mode: string;
    from?: string;
    noBranch?: boolean;
    prReview?: boolean;
    runOptions?: RunPipelineOptions;
  },
  resolvedPrimary?: ResolvedIssue,
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
      let result: IssueRunResult;
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
  resolvedPrimary?: ResolvedIssue,
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

/** An {@link IssueRunResult} carrying nothing but an exit code. */
function failure(code: number): IssueRunResult {
  return { code, failedPhase: null, branchName: null, storyCount: 0, elapsedSeconds: 0 };
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
