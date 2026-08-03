import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execa } from 'execa';
import { loadWebConfig } from '../config.js';
import {
  PIPELINE_PHASES,
  PIPELINE_PHASES_NO_BRANCH,
  PipelineManager,
  type PipelinePhase,
} from '../core/pipeline.js';
import { publishGitState } from '../core/session-git.js';
import { setSessionPublisher } from '../core/session-publisher.js';
import { FilePublisher, NullPublisher, type SessionPublisher } from '../core/session-state.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { isVerbose } from '../core/verbose.js';
import { formatDuration, printError, printInfo, printSuccess, printWarning } from '../ui/logger.js';
import { runPipelineWithRenderer } from '../ui/pipeline-renderer.js';
import { startWebServer, type WebServerHandle } from '../web/server.js';
import { runExecute } from './execute.js';
import { runInit } from './init.js';
import { runPlan } from './plan.js';
import { runPr } from './pr.js';
import { runPrd } from './prd.js';
import { runReview } from './review.js';

/** Runnable phase lists (excluding 'init' which is handled separately). */
const RUNNABLE_PHASES: PipelinePhase[] = ['prd', 'plan', 'execute', 'review', 'pr'];
const RUNNABLE_PHASES_NO_BRANCH: PipelinePhase[] = ['prd', 'plan', 'execute', 'review'];

export async function runPipeline(
  issue: string,
  mode: string,
  from?: string,
  noBranch?: boolean,
): Promise<number> {
  const issueNumber = issue.replace(/^#/, '');
  const issueDir = join('issues', issueNumber);

  const webConfig = await loadWebConfig();
  const publisher: SessionPublisher = webConfig.enabled
    ? new FilePublisher(join(issueDir, 'session.json'), {
        logLimit: webConfig.logLimit,
        includeLogs: webConfig.includeLogs,
      })
    : new NullPublisher();
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
    exitCode = await runPipelinePhases(issueNumber, issueDir, mode, publisher, from, noBranch);
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
  issueDir: string,
  mode: string,
  publisher: SessionPublisher,
  from?: string,
  noBranch?: boolean,
): Promise<number> {
  const tasksPath = join(issueDir, 'tasks.json');
  const sessionId = randomUUID();

  const publishSessionStart = (
    phases: readonly string[],
    at: string,
    info?: { issueUrl?: string; branch?: string },
  ): void => {
    publisher.publish({
      type: 'session:start',
      at,
      sessionId,
      issueNumber: Number.parseInt(issueNumber, 10) || 0,
      issueUrl: info?.issueUrl,
      branch: info?.branch,
      phases: [...phases],
      environment: { node: process.version, platform: process.platform },
    });
  };

  printInfo(`Starting pipeline for issue #${issueNumber} (mode: ${mode})`);

  // Phase 1: Init check
  printInfo('Running prerequisite checks...');
  const sessionStartedAt = isoNow();
  const initCode = await runInit();
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

  // Resolve noBranch mode: persisted value takes precedence on resume
  let effectiveNoBranch = noBranch ?? false;
  let planIssueUrl: string | undefined;
  let planBranch: string | undefined;
  try {
    const existingPlan = await loadTaskPlan(tasksPath);
    const persistedNoBranch = existingPlan.noBranch ?? false;
    planIssueUrl = existingPlan.issueUrl || undefined;
    planBranch = existingPlan.branchName || undefined;

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

  const activePhases = effectiveNoBranch ? PIPELINE_PHASES_NO_BRANCH : PIPELINE_PHASES;
  const phaseOrder = effectiveNoBranch ? RUNNABLE_PHASES_NO_BRANCH : RUNNABLE_PHASES;

  // The phase list is only known after resolving --no-branch, so the init
  // phase (which already ran) is published retroactively with real timestamps.
  publishSessionStart(activePhases, sessionStartedAt, {
    issueUrl: planIssueUrl,
    branch: planBranch,
  });
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
    prd: makeRunner(() => runPrd(issueNumber), 'prd'),
    plan: async () => {
      await makeRunner(() => runPlan(issueNumber), 'plan')();
      // Persist noBranch into the newly created tasks.json
      if (effectiveNoBranch) {
        try {
          const plan = await loadTaskPlan(tasksPath);
          plan.noBranch = true;
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

      let code = await runReview(issueNumber);

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
        code = await runReview(issueNumber);
      }

      if (code !== 0) {
        throw new Error(`Review failed after ${maxCycles} correction cycles`);
      }
    },
    pr: makeRunner(() => runPr(issueNumber), 'pr'),
  };

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

  // Close the issue
  printInfo('Closing issue...');
  try {
    await execa('gh', ['issue', 'close', issueNumber], { reject: false });
  } catch {
    printWarning('Failed to close issue automatically');
  }

  // Get PR URL for summary (skip in --no-branch mode)
  let prUrl = 'unknown';
  if (!effectiveNoBranch) {
    try {
      const proc = await execa(
        'gh',
        ['pr', 'list', '--head', '', '--json', 'url', '--limit', '1'],
        { reject: false },
      );
      const parsed = JSON.parse(proc.stdout?.toString() ?? '[]');
      if (parsed[0]?.url) {
        prUrl = parsed[0].url;
      }
    } catch {
      /* non-critical */
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
  try {
    const plan = await loadTaskPlan(tasksPath);
    storyCount = plan.userStories.length;

    // Mark as completed
    plan.issueStatus = 'completed';
    plan.completedAt = isoNow();
    plan.lastAttemptAt = isoNow();
    await saveTaskPlan(tasksPath, plan);
  } catch {
    /* non-critical */
  }

  const totalDuration = formatDuration(result.overallElapsedSeconds);

  console.log('');
  printSuccess(`Pipeline complete for issue #${issueNumber}!`);
  console.log(`  Branch:   ${branchName}${effectiveNoBranch ? ' (current)' : ''}`);
  console.log(`  Stories:  ${storyCount}`);
  console.log(`  Duration: ${totalDuration}`);
  if (!effectiveNoBranch) {
    console.log(`  PR:       ${prUrl}`);
  }

  return 0;
}
