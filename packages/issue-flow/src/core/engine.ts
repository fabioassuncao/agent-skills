import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineConfig, ResolvedPaths, TaskPlan, UserStory } from '../types.js';
import { printError, printInfo, printRetry, printSuccess, printWarning } from '../ui/logger.js';
import { printIterationHeader } from '../ui/progress.js';
import { printStartupHeader, printSummaryBox } from '../ui/summary.js';
import { isTransientFailure, retryDelaySeconds, sleep } from '../utils/retry.js';
import { executeClaude } from './executor.js';
import { divideUsage } from './metrics.js';
import { applyPlaceholders, loadPrompt } from './prompt-resolver.js';
import { publishGitState } from './session-git.js';
import {
  elapsedSecondsSince,
  publishIterationMetrics,
  publishStoryMetrics,
} from './session-metrics.js';
import { getSessionPublisher } from './session-publisher.js';
import {
  allStoriesPass,
  applyStoryMetrics,
  clearLastError,
  hasPendingCorrection,
  initializeState,
  isoNow,
  loadTaskPlan,
  markIssueCompleted,
  markIssueInProgress,
  saveTaskPlan,
  setLastError,
  trimErrorMessage,
} from './state-manager.js';
import { getOutputCallback, getStoryUpdateCallback, isVerbose } from './verbose.js';

/**
 * Emit a message through the output callback if available, otherwise console.log.
 * Used for bare console.log calls in engine functions so they route through listr2.
 */
function emitLog(message: string): void {
  const cb = getOutputCallback();
  if (cb) {
    // Skip empty lines in listr2 context — they don't render meaningfully
    if (message) {
      cb(message);
    }
  } else {
    console.log(message);
  }
}

/**
 * Ids of the stories that flipped from `passes: false` to `passes: true`
 * between the two readings of the plan taken around one execute iteration.
 *
 * Stories already passing before the iteration, and stories that only exist in
 * the newer plan, are never attributed: nothing says this iteration paid for
 * them.
 */
function newlyCompletedStoryIds(before: UserStory[], after: UserStory[]): string[] {
  const wasPassing = new Map(before.map((story) => [story.id, story.passes]));
  return after
    .filter((story) => story.passes && wasPassing.get(story.id) === false)
    .map((story) => story.id);
}

/**
 * Initialize the progress file if it doesn't exist.
 */
async function ensureProgressFile(progressFile: string): Promise<void> {
  if (!existsSync(progressFile)) {
    const content = `# Issue Flow Progress Log\nStarted: ${new Date().toString()}\n---\n`;
    await writeFile(progressFile, content, 'utf-8');
  }
}

/**
 * Archive previous run artifacts if the branch has changed.
 */
async function archiveIfBranchChanged(plan: TaskPlan, paths: ResolvedPaths): Promise<void> {
  const { lastBranchFile, archiveDir, prdFile, progressFile } = paths;

  if (!existsSync(lastBranchFile)) {
    return;
  }

  const currentBranch = plan.branchName ?? '';
  let lastBranch = '';

  try {
    lastBranch = (await readFile(lastBranchFile, 'utf-8')).trim();
  } catch {
    return;
  }

  if (currentBranch && lastBranch && currentBranch !== lastBranch) {
    const dateStr = new Date().toISOString().split('T')[0];
    const folderName = lastBranch.replace(/^issue\//, '').replace(/[<>:"|?*\\]/g, '_');
    const archiveFolder = join(archiveDir, `${dateStr}-${folderName}`);

    printInfo(`Archiving previous run: ${lastBranch}`);
    await mkdir(archiveFolder, { recursive: true });

    if (existsSync(prdFile)) {
      await cp(prdFile, join(archiveFolder, 'tasks.json'));
    }
    if (existsSync(progressFile)) {
      await cp(progressFile, join(archiveFolder, 'progress.txt'));
    }

    printInfo(`   Archived to: ${archiveFolder}`);

    // Reset progress file for new run
    await writeFile(
      progressFile,
      `# Issue Flow Progress Log\nStarted: ${new Date().toString()}\n---\n`,
      'utf-8',
    );
  }
}

/**
 * Write the current branch to the last-branch tracking file.
 */
async function trackBranch(plan: TaskPlan, lastBranchFile: string): Promise<void> {
  const branch = plan.branchName ?? '';
  if (branch) {
    await writeFile(lastBranchFile, `${branch}\n`, 'utf-8');
  }
}

/**
 * Run the issue-flow engine loop.
 *
 * This replicates the full execution flow:
 * 1. Load and initialize task plan state
 * 2. Check for early exit (already complete)
 * 3. Archive previous run if branch changed
 * 4. Resolve prompt
 * 5. Main loop: iterate, execute Claude, handle results
 * 6. Print summary
 */
export async function runEngine(config: EngineConfig, paths: ResolvedPaths): Promise<number> {
  // Load task plan
  if (!existsSync(paths.prdFile)) {
    printError(`PRD file not found at ${paths.prdFile}`);
    if (config.issueNumber) {
      emitLog(`Have you run the resolve-issue skill for issue #${config.issueNumber} first?`);
    }
    return 1;
  }

  let plan = await loadTaskPlan(paths.prdFile);
  plan = initializeState(plan);
  await saveTaskPlan(paths.prdFile, plan);

  // Check if already completed. A pending correction (a failed review whose
  // findings haven't been addressed yet) always overrides this, even though
  // every userStories[].passes is already true — otherwise a correction
  // cycle's re-run of execute would exit here without ever looking at what
  // the review found.
  if (plan.issueStatus === 'completed' && allStoriesPass(plan) && !hasPendingCorrection(plan)) {
    emitLog(`Issue already marked complete in ${paths.prdFile}`);
    return 0;
  }

  // Warn if marked complete but stories still pending
  if (plan.issueStatus === 'completed' && !allStoriesPass(plan)) {
    printWarning(
      'Issue marked completed but some stories are still pending. Resetting to in_progress.',
    );
    plan = markIssueInProgress(plan);
    plan = setLastError(
      plan,
      'invalid_completion_state',
      'tasks.json claimed the issue was completed before every story had passes=true.',
    );
    await saveTaskPlan(paths.prdFile, plan);
  }

  // Check if all stories already pass
  if (allStoriesPass(plan) && !hasPendingCorrection(plan)) {
    emitLog('All user stories already pass. Marking issue as completed.');
    plan = markIssueCompleted(plan);
    await saveTaskPlan(paths.prdFile, plan);
    return 0;
  }

  // Archive previous run if branch changed
  await archiveIfBranchChanged(plan, paths);

  // Track current branch
  await trackBranch(plan, paths.lastBranchFile);

  // Initialize progress file
  await ensureProgressFile(paths.progressFile);

  // Load prompt template
  const promptTemplate = await loadPrompt('execute');

  // Print startup header
  printStartupHeader(config, plan);

  const startTime = Date.now();
  let i = 0;
  let retryCount = 0;
  let totalRetryCount = 0;

  // Main loop
  while (true) {
    // Check iteration limit
    if (config.maxIterations !== undefined && i >= config.maxIterations) {
      break;
    }

    i++;
    getSessionPublisher().publish({ type: 'iteration:start', at: isoNow(), iteration: i });

    // Re-read plan to get latest state
    plan = await loadTaskPlan(paths.prdFile);
    // Baseline for story attribution: whatever was still pending before the
    // agent ran is what this iteration can claim credit for.
    const storiesBeforeIteration = plan.userStories;

    if (isVerbose()) {
      printIterationHeader(i, config.maxIterations, plan.userStories);
    }

    // Apply placeholders to prompt
    const prompt = applyPlaceholders(promptTemplate, {
      __PRD_FILE__: paths.prdFile,
      __PROGRESS_FILE__: paths.progressFile,
    });

    const iterationStartedAt = isoNow();
    plan = markIssueInProgress(plan, iterationStartedAt);
    await saveTaskPlan(paths.prdFile, plan);

    // Execute Claude
    const iterationStartedAtMs = Date.now();
    const result = await executeClaude(prompt);
    const iterationSeconds = elapsedSecondsSince(iterationStartedAtMs);

    if (result.exitCode !== 0) {
      // A failed iteration still burned tokens: report them on the execute
      // phase, with no attribution to any story.
      publishIterationMetrics(i, result.cost, iterationSeconds);

      const errorMessage = trimErrorMessage(result.output);

      if (isTransientFailure(result.exitCode, result.output)) {
        retryCount++;
        totalRetryCount++;
        plan = await loadTaskPlan(paths.prdFile);
        plan = setLastError(plan, 'transient_claude_failure', errorMessage);
        await saveTaskPlan(paths.prdFile, plan);

        if (!config.retryForever && retryCount > config.retryLimit) {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          plan = await loadTaskPlan(paths.prdFile);
          printSummaryBox(
            'failed',
            i,
            totalRetryCount,
            elapsed,
            plan,
            `Exceeded retry limit (${config.retryLimit}) on transient errors`,
          );
          return result.exitCode;
        }

        const delaySeconds = retryDelaySeconds(
          retryCount,
          config.backoffBaseSeconds,
          config.backoffMaxSeconds,
        );
        getSessionPublisher().publish({
          type: 'retry',
          at: isoNow(),
          attempt: retryCount,
          delaySeconds,
          reason: 'transient_claude_failure',
        });

        if (isVerbose()) {
          emitLog('');
        }
        printRetry(
          `Transient Claude failure on iteration ${i} (attempt ${retryCount}). Retrying in ${delaySeconds}s.`,
        );

        // Stay within current iteration budget
        i--;
        await sleep(delaySeconds);
        continue;
      }

      // Fatal failure
      plan = await loadTaskPlan(paths.prdFile);
      plan = setLastError(plan, 'fatal_claude_failure', errorMessage);
      await saveTaskPlan(paths.prdFile, plan);

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      printSummaryBox(
        'failed',
        i,
        totalRetryCount,
        elapsed,
        plan,
        `Claude CLI failed with exit code ${result.exitCode}`,
      );
      return result.exitCode;
    }

    // Success — reset retry counter
    retryCount = 0;
    plan = await loadTaskPlan(paths.prdFile);
    plan = clearLastError(plan, iterationStartedAt);
    await saveTaskPlan(paths.prdFile, plan);

    // Notify story progress listeners (e.g., listr2 subtasks)
    const storyUpdateCb = getStoryUpdateCallback();
    if (storyUpdateCb) {
      storyUpdateCb(plan.userStories);
    }
    getSessionPublisher().publish({
      type: 'stories:update',
      at: isoNow(),
      stories: plan.userStories,
    });

    // Story attribution — an approximation by construction: the CLI reports a
    // single usage for the whole iteration, so the stories that flipped to
    // passing in it split tokens, cost and duration evenly. With none, nothing
    // is attributed and the whole cost stays on the execute phase. Published
    // after stories:update, which rebuilds the stories array.
    const completedStoryIds = newlyCompletedStoryIds(storiesBeforeIteration, plan.userStories);
    if (completedStoryIds.length > 0) {
      const storyShare = divideUsage(result.cost, completedStoryIds.length);
      const storySeconds = Math.round(iterationSeconds / completedStoryIds.length);
      for (const storyId of completedStoryIds) {
        publishStoryMetrics(storyId, storyShare, storySeconds);
      }

      // The same shares also land on tasks.json, so the numbers outlive the
      // session and are readable with web monitoring off. Persisting them is
      // observational: a write failure must never change the iteration's
      // outcome, so the plan in memory only advances when the write succeeded.
      const planWithMetrics = applyStoryMetrics(plan, completedStoryIds, storyShare, storySeconds);
      try {
        await saveTaskPlan(paths.prdFile, planWithMetrics);
        plan = planWithMetrics;
      } catch {
        // Metrics are a nice-to-have; the iteration succeeded regardless.
      }
    }

    getSessionPublisher().publish({ type: 'iteration:end', at: isoNow(), iteration: i });
    publishIterationMetrics(i, result.cost, iterationSeconds);
    // Low-frequency commit/PR enrichment: iteration end is one of the only
    // two sanctioned points (the other is phase boundaries in run.ts).
    await publishGitState(getSessionPublisher());

    // Check for completion signal
    if (result.output.includes('<promise>COMPLETE</promise>')) {
      plan = await loadTaskPlan(paths.prdFile);
      if (allStoriesPass(plan) && !hasPendingCorrection(plan)) {
        plan = markIssueCompleted(plan);
        await saveTaskPlan(paths.prdFile, plan);

        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        printSummaryBox('success', i, totalRetryCount, elapsed, plan);
        return 0;
      }

      plan = setLastError(
        plan,
        'invalid_completion_signal',
        hasPendingCorrection(plan)
          ? 'Claude returned <promise>COMPLETE</promise> while lastReviewFindings was still set.'
          : 'Claude returned <promise>COMPLETE</promise> before every story had passes=true.',
      );
      await saveTaskPlan(paths.prdFile, plan);

      emitLog('');
      printWarning(
        hasPendingCorrection(plan)
          ? 'Claude returned a completion signal, but lastReviewFindings is still set. Ignoring completion and continuing.'
          : 'Claude returned a completion signal, but tasks.json still has pending stories. Ignoring completion and continuing.',
      );
    }

    if (isVerbose()) {
      printSuccess(`Iteration ${i} complete. Continuing...`);
    }
    await sleep(2);
  }

  // Reached max iterations
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  plan = await loadTaskPlan(paths.prdFile);
  printSummaryBox(
    'incomplete',
    config.maxIterations ?? i,
    totalRetryCount,
    elapsed,
    plan,
    'Reached max iterations without completing all tasks.',
  );
  return 1;
}
