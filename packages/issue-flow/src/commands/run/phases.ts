import type { SessionPublisher } from '../../core/session-state.js';
import { isVerbose } from '../../core/verbose.js';
import type { IssuePaths } from '../../storage/paths.js';
import { printError } from '../../ui/logger.js';
import { runPipelineWithRenderer } from '../../ui/pipeline-renderer.js';
import { finalizeSuccessfulIssueRun } from './phase-finalize.js';
import { preparePhaseRun } from './phase-prepare.js';
import { buildInstrumentedPhaseRunners } from './phase-runners.js';
import { resolveStartPhase } from './phase-start.js';
import { failure, type IssueRunResult, type IssueSessionInput } from './types.js';

export async function runPipelinePhases(
  issueNumber: string,
  paths: IssuePaths,
  mode: string,
  publisher: SessionPublisher,
  input: IssueSessionInput,
): Promise<IssueRunResult> {
  const prepared = await preparePhaseRun(issueNumber, paths, mode, publisher, input);
  if (prepared.kind === 'done') {
    return prepared.result;
  }
  const {
    tasksPath,
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
  } = prepared;
  let { producedBranch, plannedExecutionBranch, branchExistedBeforeExecution } = prepared;
  const startResolved = await resolveStartPhase({
    from,
    activePhases,
    effectiveNoBranch,
    tasksPath,
  });
  if (!startResolved.ok) {
    return failure(1);
  }
  const startPhase = startResolved.startPhase;
  // A phase that is not part of this run's list (the closing pass of a queue
  // runs only `pr`) starts the renderer at the beginning rather than at -1.
  const startIdx = Math.max(phaseOrder.indexOf(startPhase), 0);
  const branchState = {
    producedBranch,
    plannedExecutionBranch,
    branchExistedBeforeExecution,
  };
  const { instrumentedRunners, reviewBox } = buildInstrumentedPhaseRunners({
    issueNumber,
    tasksPath,
    publisher,
    resolvedIssue,
    queue,
    finalPr,
    continueNumbering,
    startUs,
    executeRetry,
    effectiveNoBranch,
    effectivePrReview,
    initialBranch,
    queueCommitScope,
    branchState,
  });
  // Run pipeline with listr2 renderer — startup header printed above, summary below
  const phaseSuffixes = phaseSuffixesFor(agentSummary);
  const result = await runPipelineWithRenderer({
    phases: phaseOrder,
    startIndex: startIdx,
    verbose: isVerbose(),
    runners: instrumentedRunners,
    tasksPath,
    phaseSuffixes,
  });
  producedBranch = branchState.producedBranch;
  plannedExecutionBranch = branchState.plannedExecutionBranch;
  branchExistedBeforeExecution = branchState.branchExistedBeforeExecution;
  if (!result.success) {
    printError(`Phase ${result.failedPhase} failed`);
    return {
      ...failure(1),
      failedPhase: result.failedPhase ?? null,
      branchName: producedBranch,
      elapsedSeconds: result.overallElapsedSeconds,
    };
  }
  return finalizeSuccessfulIssueRun({
    issueNumber,
    tasksPath,
    resolvedIssue,
    review: reviewBox.outcome,
    inQueue,
    finalPr,
    producedBranch,
    effectiveNoBranch,
    elapsedSeconds: result.overallElapsedSeconds,
  });
}
function phaseSuffixesFor(agentSummary: {
  defaultProvider: string;
  byPhase: Record<string, { provider: string; model?: string | null }>;
}): Record<string, string> {
  const phaseSuffixes: Record<string, string> = {};
  for (const [phase, resolved] of Object.entries(agentSummary.byPhase)) {
    if (resolved.provider !== agentSummary.defaultProvider) {
      phaseSuffixes[phase] = resolved.model
        ? `${resolved.provider} · ${resolved.model}`
        : resolved.provider;
    }
  }
  return phaseSuffixes;
}
