import { randomUUID } from 'node:crypto';
import { loadIssuesConfig } from '../../config.js';
import { PIPELINE_PHASES } from '../../core/pipeline.js';
import { isoNow } from '../../core/state-manager.js';
import { isVerbose } from '../../core/verbose.js';
import { resolveCommandIssue } from '../../issues/context.js';
import { bindDiagnosticContext } from '../../storage/diagnostics.js';
import type { IssuePaths } from '../../storage/paths.js';
import { printError, printInfo } from '../../ui/logger.js';
import { getCurrentBranch, getHeadCommit } from '../../utils/git.js';
import { getPackageVersion } from '../../version.js';
import { runInit } from '../init.js';
import { buildAgentConfiguration } from './phase-config.js';
import { resolveExecuteRetry, resolveStoryNumbering } from './phase-options.js';
import { toIssueNumber } from './publish.js';
import { failure } from './types.js';

export type BootstrapResult =
  | { kind: 'done'; result: import('./types.js').IssueRunResult }
  | {
      kind: 'continue';
      issueNumber: string;
      paths: import('../../storage/paths.js').IssuePaths;
      mode: string;
      publisher: import('../../core/session-state.js').SessionPublisher;
      input: import('./types.js').IssueSessionInput;
      from: string | undefined;
      noBranch: boolean | undefined;
      prReview: boolean | undefined;
      queue: import('./types.js').IssueSessionInput['queue'];
      continueNumbering: boolean | undefined;
      startUs: number | undefined;
      executeRetry: { retryLimit: number | undefined; retryForever: boolean | undefined };
      tasksPath: string;
      sessionId: string;
      initialBranch: string;
      initialCommit: string | null;
      publishedIssueNumber: number | null;
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
      agentSummary: Awaited<
        ReturnType<typeof import('./phase-config.js').buildAgentConfiguration>
      >['agentSummary'];
      configurationSnapshot: Awaited<
        ReturnType<typeof import('./phase-config.js').buildAgentConfiguration>
      >['configurationSnapshot'];
      sessionStartedAt: string;
      resolvedIssue: import('../../issues/types.js').ResolvedIssue;
    };

async function runInitGate(input: {
  queue: import('./types.js').IssueSessionInput['queue'];
  issuesConfig: Awaited<ReturnType<typeof import('../../config.js').loadIssuesConfig>>;
  publishSessionStart: (phases: readonly string[], at: string) => void;
  publisher: import('../../core/session-state.js').SessionPublisher;
}): Promise<
  | { kind: 'done'; result: import('./types.js').IssueRunResult }
  | { kind: 'ok'; sessionStartedAt: string }
> {
  const { queue, issuesConfig, publishSessionStart, publisher } = input;
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
      return { kind: 'done', result: failure(1) };
    }
  }

  return { kind: 'ok', sessionStartedAt };
}

async function beginBootstrapLocals(
  issueNumber: string,
  paths: IssuePaths,
  runOptions: import('./types.js').RunPipelineOptions | undefined,
): Promise<{
  continueNumbering: boolean | undefined;
  startUs: number | undefined;
  executeRetry: { retryLimit: number | undefined; retryForever: boolean | undefined };
  tasksPath: string;
  sessionId: string;
  initialBranch: string;
  initialCommit: string | null;
}> {
  const { continueNumbering, startUs } = resolveStoryNumbering(runOptions);
  const executeRetry = resolveExecuteRetry(runOptions);
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
  return {
    continueNumbering,
    startUs,
    executeRetry,
    tasksPath,
    sessionId,
    initialBranch,
    initialCommit,
  };
}

async function resolvePrimaryIssue(
  issueNumber: string,
  queue: import('./types.js').IssueSessionInput['queue'],
  issuesConfig: Awaited<ReturnType<typeof loadIssuesConfig>>,
): Promise<
  | { kind: 'done'; result: import('./types.js').IssueRunResult }
  | { kind: 'ok'; resolvedIssue: import('../../issues/types.js').ResolvedIssue }
> {
  // The origin is settled once, here, and the decision travels to every phase.
  // Resolving per phase would query the providers five times and could ask the
  // user about the same divergence five times.
  const resolution = await resolveCommandIssue(issueNumber, queue?.resolved, {
    config: issuesConfig,
  });
  if (!resolution.ok) {
    return { kind: 'done', result: failure(resolution.code) };
  }
  return { kind: 'ok', resolvedIssue: resolution.resolved };
}

export async function bootstrapThroughIssueResolution(
  issueNumber: string,
  paths: import('../../storage/paths.js').IssuePaths,
  mode: string,
  publisher: import('../../core/session-state.js').SessionPublisher,
  input: import('./types.js').IssueSessionInput,
): Promise<BootstrapResult> {
  const { from, noBranch, prReview, queue } = input;
  const {
    continueNumbering,
    startUs,
    executeRetry,
    tasksPath,
    sessionId,
    initialBranch,
    initialCommit,
  } = await beginBootstrapLocals(issueNumber, paths, input.runOptions);
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

  const { agentSummary, configurationSnapshot } = await buildAgentConfiguration(prReview);

  printInfo(
    `Issue Flow v${getPackageVersion()} · starting pipeline for issue #${issueNumber} (mode: ${mode}, agent: ${agentSummary.label})`,
  );

  // Loaded before the checks so init knows which origin the user is heading
  // for: with a local one, a missing gh must not fail the environment.
  const issuesConfig = await loadIssuesConfig();

  const initGate = await runInitGate({
    queue,
    issuesConfig,
    publishSessionStart,
    publisher,
  });
  if (initGate.kind === 'done') return initGate;
  const sessionStartedAt = initGate.sessionStartedAt;

  const resolved = await resolvePrimaryIssue(issueNumber, queue, issuesConfig);
  if (resolved.kind === 'done') return resolved;
  const resolvedIssue = resolved.resolvedIssue;
  publishedIssueNumber = resolvedIssue.issue.number;

  return {
    kind: 'continue',
    issueNumber,
    paths,
    mode,
    publisher,
    input,
    from,
    noBranch,
    prReview,
    queue,
    continueNumbering,
    startUs,
    executeRetry,
    tasksPath,
    sessionId,
    initialBranch,
    initialCommit,
    publishedIssueNumber,
    publishSessionStart,
    agentSummary,
    configurationSnapshot,
    sessionStartedAt,
    resolvedIssue,
  };
}
