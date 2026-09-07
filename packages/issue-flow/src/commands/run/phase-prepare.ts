import { publishGitState } from '../../core/session-git.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../../core/state-manager.js';
import { printWarning } from '../../ui/logger.js';
import { localBranchExists } from '../../utils/git.js';
import { adoptQueueBranch, decideQueue } from './multi-issue.js';
import { bootstrapThroughIssueResolution } from './phase-bootstrap.js';
import {
  type PersistedPlanFlags,
  resolveBranchAndReviewModes,
  selectPhaseLists,
} from './phase-options.js';
import { publishIssueDetails, publishStorySeed } from './publish.js';
import { failure } from './types.js';

export type PreparedPhaseRun =
  | { kind: 'done'; result: import('./types.js').IssueRunResult }
  | {
      kind: 'ready';
      issueNumber: string;
      tasksPath: string;
      publisher: import('../../core/session-state.js').SessionPublisher;
      from: string | undefined;
      continueNumbering: boolean | undefined;
      startUs: number | undefined;
      executeRetry: { retryLimit: number | undefined; retryForever: boolean | undefined };
      initialBranch: string;
      agentSummary: Awaited<
        ReturnType<typeof import('./phase-config.js').buildAgentConfiguration>
      >['agentSummary'];
      resolvedIssue: import('../../issues/types.js').ResolvedIssue;
      effectiveNoBranch: boolean;
      effectivePrReview: boolean;
      inQueue: boolean;
      finalPr: import('../pr.js').PrQueueContext | undefined;
      activePhases: readonly import('../../core/pipeline.js').PipelinePhase[];
      phaseOrder: import('../../core/pipeline.js').PipelinePhase[];
      queueCommitScope: string | undefined;
      queue: import('./types.js').IssueSessionInput['queue'];
      producedBranch: string | null;
      plannedExecutionBranch: string | null;
      branchExistedBeforeExecution: boolean | null;
    };

async function loadModesAndPhases(input: {
  noBranch: boolean | undefined;
  prReview: boolean | undefined;
  tasksPath: string;
  queue: import('./types.js').IssueSessionInput['queue'];
}): Promise<{
  effectiveNoBranch: boolean;
  effectivePrReview: boolean;
  planIssueUrl: string | undefined;
  planBranch: string | undefined;
  planStories: import('../../types.js').UserStory[];
  inQueue: boolean;
  finalPr: import('../pr.js').PrQueueContext | undefined;
  activePhases: readonly import('../../core/pipeline.js').PipelinePhase[];
  phaseOrder: import('../../core/pipeline.js').PipelinePhase[];
}> {
  const { noBranch, prReview, tasksPath, queue } = input;
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
  const planBranch = modes.planBranch;
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

  return {
    effectiveNoBranch,
    effectivePrReview,
    planIssueUrl,
    planBranch,
    planStories,
    inQueue,
    finalPr,
    activePhases,
    phaseOrder,
  };
}

async function openPhaseSession(input: {
  issueNumber: string;
  tasksPath: string;
  queue: import('./types.js').IssueSessionInput['queue'];
  finalPr: import('../pr.js').PrQueueContext | undefined;
  effectiveNoBranch: boolean;
  planBranch: string | undefined;
  planIssueUrl: string | undefined;
  planStories: import('../../types.js').UserStory[];
  initialBranch: string;
  initialCommit: string | null;
  activePhases: readonly string[];
  sessionStartedAt: string;
  resolvedIssue: import('../../issues/types.js').ResolvedIssue;
  publisher: import('../../core/session-state.js').SessionPublisher;
  publishSessionStart: (
    phases: readonly string[],
    at: string,
    info?: {
      issueUrl?: string;
      branch?: string;
      branchCreated?: boolean | null;
      startCommit?: string | null;
    },
  ) => void;
}): Promise<{
  queueCommitScope: string | undefined;
  producedBranch: string | null;
  plannedExecutionBranch: string | null;
  branchExistedBeforeExecution: boolean | null;
  planBranch: string | undefined;
}> {
  const {
    issueNumber,
    tasksPath,
    queue,
    finalPr,
    effectiveNoBranch,
    planIssueUrl,
    planStories,
    initialBranch,
    initialCommit,
    activePhases,
    sessionStartedAt,
    resolvedIssue,
    publisher,
    publishSessionStart,
  } = input;
  let planBranch = input.planBranch;
  // Commit scope for this issue's stories: only a queue needs one, because
  // only there do several issues share a branch (and therefore a `git log`).
  const queueCommitScope = queue === undefined ? undefined : `issue-${issueNumber}`;
  // Branch this issue will work on, reported back so the queue can adopt the
  // first issue's choice for every later one.
  let producedBranch: string | null = null;
  const plannedExecutionBranch: string | null = planBranch ?? null;
  const branchExistedBeforeExecution =
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

  return {
    queueCommitScope,
    producedBranch,
    plannedExecutionBranch,
    branchExistedBeforeExecution,
    planBranch,
  };
}

async function maybeHandoffToQueue(input: {
  queue: import('./types.js').IssueSessionInput['queue'];
  issueNumber: string;
  requested: string[] | undefined;
  resolvedIssue: import('../../issues/types.js').ResolvedIssue;
  noBranch: boolean | undefined;
  prReview: boolean | undefined;
  runOptions: import('./types.js').RunPipelineOptions | undefined;
}): Promise<PreparedPhaseRun | null> {
  const { queue, issueNumber, requested, resolvedIssue, noBranch, prReview, runOptions } = input;
  if (queue !== undefined) return null;
  const decision = await decideQueue({
    requested: requested ?? [issueNumber],
    resolved: resolvedIssue,
    noBranch: noBranch ?? false,
    prReview: prReview ?? false,
    runOptions: runOptions ?? {},
  });
  if (decision.kind === 'stop') {
    return { kind: 'done', result: failure(decision.code) };
  }
  if (decision.kind === 'queue') {
    return {
      kind: 'done',
      result: {
        ...failure(0),
        queue: { plan: decision.plan, resumed: decision.resumed, resolved: resolvedIssue },
      },
    };
  }
  return null;
}

export async function preparePhaseRun(
  issueNumber: string,
  paths: import('../../storage/paths.js').IssuePaths,
  mode: string,
  publisher: import('../../core/session-state.js').SessionPublisher,
  input: import('./types.js').IssueSessionInput,
): Promise<PreparedPhaseRun> {
  const boot = await bootstrapThroughIssueResolution(issueNumber, paths, mode, publisher, input);
  if (boot.kind === 'done') return boot;
  const {
    from,
    noBranch,
    prReview,
    queue,
    continueNumbering,
    startUs,
    executeRetry,
    tasksPath,
    initialBranch,
    initialCommit,
    publishSessionStart,
    agentSummary,
    sessionStartedAt,
    resolvedIssue,
  } = boot;
  // Everything above is what a queue needs to exist: prerequisites checked and
  // the primary Issue resolved, but not a single phase run and not a single
  // event published. This is where a run learns it is really a queue.
  const handoff = await maybeHandoffToQueue({
    queue,
    issueNumber,
    requested: input.requested,
    resolvedIssue,
    noBranch,
    prReview,
    runOptions: input.runOptions,
  });
  if (handoff !== null) return handoff;

  const modes = await loadModesAndPhases({ noBranch, prReview, tasksPath, queue });
  const {
    effectiveNoBranch,
    effectivePrReview,
    planIssueUrl,
    planStories,
    inQueue,
    finalPr,
    activePhases,
    phaseOrder,
  } = modes;
  let planBranch = modes.planBranch;

  const opened = await openPhaseSession({
    issueNumber,
    tasksPath,
    queue,
    finalPr,
    effectiveNoBranch,
    planBranch,
    planIssueUrl,
    planStories,
    initialBranch,
    initialCommit,
    activePhases,
    sessionStartedAt,
    resolvedIssue,
    publisher,
    publishSessionStart,
  });
  const { queueCommitScope, producedBranch, plannedExecutionBranch, branchExistedBeforeExecution } =
    opened;
  planBranch = opened.planBranch;

  return {
    kind: 'ready',
    issueNumber,
    tasksPath,
    publisher,
    from,
    continueNumbering,
    startUs,
    executeRetry,
    initialBranch,
    agentSummary,
    resolvedIssue,
    effectiveNoBranch,
    effectivePrReview,
    inQueue,
    finalPr,
    activePhases,
    phaseOrder,
    queueCommitScope,
    queue,
    producedBranch,
    plannedExecutionBranch,
    branchExistedBeforeExecution,
  };
}
