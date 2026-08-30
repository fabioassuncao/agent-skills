import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePolicyPlaceholders } from '../policy/placeholders.js';
import { classify } from '../resilience/errors.js';
import type { RetryPolicy } from '../resilience/policy.js';
import { fixedBackoffPolicy, withRetry } from '../resilience/retry.js';
import type { ClaudeResult, EngineConfig, ResolvedPaths, TaskPlan, UserStory } from '../types.js';
import { printError, printInfo, printRetry, printSuccess, printWarning } from '../ui/logger.js';
import { printIterationHeader } from '../ui/progress.js';
import { printStartupHeader, printSummaryBox } from '../ui/summary.js';
import { committedStoryIds, getBaseBranch, isWorkingTreeClean } from '../utils/git.js';
import { sleep } from '../utils/retry.js';
import { executeClaude } from './executor.js';
import { divideUsage } from './metrics.js';
import { applyPlaceholders, loadPrompt } from './prompt-resolver.js';
import { publishGitState } from './session-git.js';
import {
  EXECUTE_PHASE,
  elapsedSecondsSince,
  getPhaseUsageTotals,
  publishIterationMetrics,
  publishStoryMetrics,
} from './session-metrics.js';
import { getSessionPublisher } from './session-publisher.js';
import { getShutdownSignal } from './shutdown.js';
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
  selectActiveStory,
  setLastError,
  trimErrorMessage,
} from './state-manager.js';
import {
  getInactivityTimeout,
  getOutputCallback,
  getStoryStageCallback,
  getStoryUpdateCallback,
  isVerbose,
} from './verbose.js';

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

/** What one pass of the execute loop produces, retry or not. */
interface ExecuteAttempt {
  result: ClaudeResult;
  /** When the attempt started, for `clearLastError`. */
  startedAt: string;
  /** How long the attempt took, for the metrics split across stories. */
  seconds: number;
  /** The stories as they were before the agent ran, for attribution. */
  storiesBefore: UserStory[];
}

/**
 * The execute loop's retry budget, unchanged in effect from the hand-rolled
 * loop it replaces: `retryLimit` counts *retries*, so the attempt budget is one
 * more than it, and `retryForever` lifts the count while `backoffMaxSeconds`
 * still caps the wait.
 */
function executeRetryPolicy(config: EngineConfig): RetryPolicy {
  return fixedBackoffPolicy(
    config.retryLimit + 1,
    config.backoffBaseSeconds,
    config.backoffMaxSeconds,
    { retryForever: config.retryForever },
  );
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
 * Commit message formats handed to the execute prompt.
 *
 * Without a scope they are byte-for-byte what the prompt has always spelled
 * out, so a single-issue run produces the same history it always did. With one
 * — the only case being several issues sharing a branch — the issue becomes a
 * conventional-commit scope, which is what makes `git log` on the shared branch
 * readable per issue.
 *
 * `convention` is the repository's own commit convention, when it declares one.
 * The hard-coded `feat` is wrong for most stories under Conventional Commits: a
 * bug fix committed as `feat:` corrupts a changelog and a semver bump computed
 * from the history. So a repository that declared a convention gets a `<type>`
 * placeholder and the instruction to choose; one that declared none keeps the
 * exact string it always had.
 */
export function commitPlaceholders(
  scope?: string,
  convention?: string | null,
): Record<string, string> {
  const suffix = scope === undefined || scope === '' ? '' : `(${scope})`;
  const declared = convention !== undefined && convention !== null && convention !== '';

  return {
    __COMMIT_MESSAGE__: declared
      ? `<type>${suffix}: [Story ID] - [Story Title]`
      : `feat${suffix}: [Story ID] - [Story Title]`,
    __FIX_COMMIT_MESSAGE__: `fix${suffix}: address review findings`,
  };
}

/**
 * The watchdog budget of one iteration, from the process-wide setting.
 *
 * Absent means the default; `0` turns the watchdog off. Reading it here rather
 * than threading it through the engine's config keeps it a single value per
 * process, which is what it is.
 */
function inactivityOptions(): { inactivityTimeoutMs?: number } {
  const configured = getInactivityTimeout();
  return configured === undefined ? {} : { inactivityTimeoutMs: configured };
}

/**
 * Mark as passing every pending story whose commit is already on the branch.
 *
 * Two conditions, and both are required:
 *
 * - the story's id appears in a commit subject of this branch, which is what
 *   the execute prompt writes (`<type>(scope): US-001 - Title`);
 * - the working tree is **clean**, so nothing is half-applied. A dirty tree
 *   means work in flight, and adopting a story on that basis would call
 *   finished something that is not.
 *
 * Returns the ids it adopted. Never throws: a git that cannot answer, or a plan
 * that cannot be written, leaves the loop doing exactly what it did before.
 */
async function adoptCommittedStories(tasksPath: string): Promise<string[]> {
  try {
    const plan = await loadTaskPlan(tasksPath);
    const pending = plan.userStories.filter((story) => !story.passes);
    if (pending.length === 0) return [];

    if (!(await isWorkingTreeClean())) return [];

    const committed = await committedStoryIds(await getBaseBranch());
    const adopted = pending.filter((story) => committed.has(story.id)).map((story) => story.id);
    if (adopted.length === 0) return [];

    await saveTaskPlan(tasksPath, {
      ...plan,
      userStories: plan.userStories.map((story) =>
        adopted.includes(story.id) ? { ...story, passes: true } : story,
      ),
    });
    return adopted;
  } catch {
    return [];
  }
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

  // Load prompt template. The root is handed over rather than rediscovered:
  // it was resolved once by `resolvePaths()`, and a second `git rev-parse` here
  // would be a subprocess per run for an answer already in hand.
  const promptTemplate = await loadPrompt('execute', { projectRoot: paths.projectRoot });

  // The repository's own conventions, resolved once for the whole loop: they
  // cannot change mid-run, and every iteration renders the same projection.
  const policy = await resolvePolicyPlaceholders({ root: paths.projectRoot });

  // Print startup header
  printStartupHeader(config, plan);

  const startTime = Date.now();
  let i = 0;
  let totalRetryCount = 0;

  // Main loop
  while (true) {
    // Check iteration limit
    if (config.maxIterations !== undefined && i >= config.maxIterations) {
      break;
    }

    i++;

    // Safety net for the crash between a story's commit and the agent writing
    // `passes: true` (scenario I). The commit is the durable fact; the plan is
    // written after it, so a process that died in between leaves work that is
    // done and a plan that says it is not — and the next iteration redoes it on
    // top of a commit that already exists.
    //
    // This never *replaces* the agent's `passes`, which stays the primary
    // source: it only closes the window the agent cannot close itself.
    const adopted = await adoptCommittedStories(paths.prdFile);
    if (adopted.length > 0) {
      printInfo(
        `Adopting ${adopted.join(', ')}: already committed on this branch with a clean tree.`,
      );
      plan = await loadTaskPlan(paths.prdFile);
      if (plan.userStories.every((story) => story.passes) && plan.lastReviewFindings === null) {
        // Everything the loop was going to do is already done.
        break;
      }
    }

    // One iteration is one attempt of the Claude CLI, retried in place by the
    // project's single retry executor (`resilience/retry.ts`). A retry costs no
    // iteration budget, exactly as the `i--` it replaces cost none. Everything a
    // retried attempt has to redo — re-reading the plan, republishing
    // `iteration:start`, re-rendering the prompt — lives inside `attempt`,
    // because the loop this used to be written as re-ran all of it too.
    const attempted = await withRetry<ExecuteAttempt>(
      async () => {
        // Re-read plan to get latest state
        plan = await loadTaskPlan(paths.prdFile);
        // Publish the plan before naming its active story. This covers direct
        // `issue-flow execute` runs and resumes that never pass through the
        // plan runner, while retaining the empty-plan no-op contract.
        if (plan.userStories.length > 0) {
          getSessionPublisher().publish({
            type: 'stories:update',
            at: isoNow(),
            stories: plan.userStories,
          });
        }
        // Baseline for story attribution: whatever was still pending before the
        // agent ran is what this iteration can claim credit for.
        const storiesBefore = plan.userStories;

        // Highest-priority story with passes: false — the same rule
        // prompts/execute.md gives the agent. Computed once, here, and shared by
        // the published event and the verbose terminal header, so every surface
        // agrees on who is active instead of each deriving its own heuristic.
        const activeStoryId = selectActiveStory(plan.userStories)?.id;
        getSessionPublisher().publish({
          type: 'iteration:start',
          at: isoNow(),
          iteration: i,
          storyId: activeStoryId,
        });
        getStoryStageCallback()?.(activeStoryId);

        if (isVerbose()) {
          printIterationHeader(i, config.maxIterations, plan.userStories, activeStoryId);
        }

        // Apply placeholders to prompt
        const prompt = applyPlaceholders(promptTemplate, {
          __PRD_FILE__: paths.prdFile,
          __PROGRESS_FILE__: paths.progressFile,
          ...policy,
          // The convention comes off the projection above rather than from a second
          // discovery: one resolution per run is the whole point of the cache.
          ...commitPlaceholders(config.commitScope, policy.__COMMIT_CONVENTION__),
        });

        const startedAt = isoNow();
        plan = markIssueInProgress(plan, startedAt);
        await saveTaskPlan(paths.prdFile, plan);

        // Execute Claude
        const startedAtMs = Date.now();
        const result = await executeClaude(prompt, inactivityOptions());
        const seconds = elapsedSecondsSince(startedAtMs);

        if (result.exitCode !== 0) {
          // A failed iteration still burned tokens: report them on the execute
          // phase, with no attribution to any story.
          publishIterationMetrics(i, result.cost, seconds);
        }

        return { result, startedAt, seconds, storiesBefore };
      },
      {
        policy: executeRetryPolicy(config),
        // A `Ctrl+C` during a fifteen-minute backoff must stop in that instant,
        // not fifteen minutes later. `abortableDelay` resolves `false` on the
        // abort, which `withRetry` reports as `aborted` rather than a failure.
        signal: getShutdownSignal(),
        // The exit code and the output are all the evidence the CLI leaves
        // behind, which is exactly what `isTransientFailure()` used to be given
        // here — `classify()` is the same verdict plus the kind.
        evaluate: ({ result }) =>
          result.exitCode === 0
            ? null
            : classify({ source: 'agent', exitCode: result.exitCode, stdout: result.output }),
        onAttempt: async ({ value, attempt, failure, willRetry, delayMs }) => {
          if (failure === null) return;

          const errorMessage = trimErrorMessage(value.result.output);

          if (!failure.retryable) {
            plan = await loadTaskPlan(paths.prdFile);
            plan = setLastError(plan, 'fatal_claude_failure', errorMessage);
            await saveTaskPlan(paths.prdFile, plan);
            return;
          }

          // Recorded even on the attempt that spends the last of the budget:
          // the run ends on a transient failure, and the plan has to say so.
          totalRetryCount++;
          plan = await loadTaskPlan(paths.prdFile);
          plan = setLastError(plan, 'transient_claude_failure', errorMessage);
          await saveTaskPlan(paths.prdFile, plan);
          if (!willRetry) return;

          const delaySeconds = delayMs / 1000;
          getSessionPublisher().publish({
            type: 'retry',
            at: isoNow(),
            attempt,
            delaySeconds,
            reason: 'transient_claude_failure',
            kind: failure.kind,
          });

          if (isVerbose()) {
            emitLog('');
          }
          printRetry(
            `Transient Claude failure on iteration ${i} (attempt ${attempt}). Retrying in ${delaySeconds}s.`,
          );
        },
      },
    );

    const {
      result,
      seconds: iterationSeconds,
      storiesBefore: storiesBeforeIteration,
    } = attempted.value;
    const iterationStartedAt = attempted.value.startedAt;

    if (result.exitCode !== 0) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      plan = await loadTaskPlan(paths.prdFile);
      printSummaryBox(
        'failed',
        i,
        totalRetryCount,
        elapsed,
        plan,
        attempted.exhausted
          ? `Exceeded retry limit (${config.retryLimit}) on transient errors`
          : `Claude CLI failed with exit code ${result.exitCode}`,
        getPhaseUsageTotals(EXECUTE_PHASE),
      );
      return result.exitCode;
    }

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
        printSummaryBox(
          'success',
          i,
          totalRetryCount,
          elapsed,
          plan,
          undefined,
          getPhaseUsageTotals(EXECUTE_PHASE),
        );
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
    getPhaseUsageTotals(EXECUTE_PHASE),
  );
  return 1;
}
