import { DEFAULT_HEADLESS_TIMEOUT_MS, runHeadless } from '../core/headless.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { publishPhaseMetrics } from '../core/session-metrics.js';
import { loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { issuePlaceholders, resolveCommandIssue } from '../issues/context.js';
import type { ResolvedIssue } from '../issues/types.js';
import { resolvePolicyPlaceholders } from '../policy/placeholders.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import { printError, printSuccess, printWarning } from '../ui/logger.js';
import { applyAcceptanceToPlan, runAcceptanceGate } from '../verify/gate.js';
import { formatVerificationLine } from '../verify/present.js';
import { parseIssueReviewResult } from '../verify/review-result.js';

export async function runReview(issue: string, resolvedIssue?: ResolvedIssue): Promise<number> {
  const issueNumber = issue.replace(/^#/, '');
  const paths = await resolveIssuePaths(issueNumber);
  const tasksPath = paths.tasksFile;

  const resolution = await resolveCommandIssue(issueNumber, resolvedIssue);
  if (!resolution.ok) {
    return resolution.code;
  }

  const acceptance = await runAcceptanceGate({
    issueDir: paths.issueDir,
    addDirs: [paths.issueDir],
  });
  if (acceptance.verdict === 'failed') {
    try {
      const plan = await loadTaskPlan(tasksPath);
      const applied = applyAcceptanceToPlan(plan, acceptance);
      await saveTaskPlan(tasksPath, applied.plan);
    } catch {
      printError(formatVerificationLine(acceptance.verdict, acceptance.level));
    }
    return 1;
  }
  if (acceptance.verdict === 'unverified') {
    printWarning(formatVerificationLine(acceptance.verdict, acceptance.level));
  } else {
    printSuccess(formatVerificationLine(acceptance.verdict, acceptance.level));
  }
  const template = await loadPrompt('review');
  const prompt = applyPlaceholders(template, {
    // The repository's own conventions. Empty when it declares none, which is
    // what keeps the rendered prompt identical to the pre-policy one.
    ...(await resolvePolicyPlaceholders({ phase: 'review' })),
    __ISSUE_NUMBER__: issueNumber,
    __TASKS_PATH__: tasksPath,
    __PROGRESS_FILE__: paths.progressFile,
    __VERIFY_PATH__: paths.verifyFile,
    ...issuePlaceholders(resolution.resolved),
  });

  const startedAtMs = Date.now();
  let reviewContext: { storyIds: string[]; correctionCycle: number } | undefined;
  try {
    const plan = await loadTaskPlan(tasksPath);
    reviewContext = {
      storyIds: plan.userStories.map((story) => story.id),
      correctionCycle: plan.correctionCycle,
    };
  } catch {
    reviewContext = undefined;
  }
  const result = await runHeadless({
    prompt,
    maxTurns: 25,
    timeout: getGlobalTimeout() ?? DEFAULT_HEADLESS_TIMEOUT_MS,
    // json (not text) so the CLI reports usage: the envelope's `result` field
    // carries the same assistant text parseReviewResult() already consumed.
    outputFormat: 'json',
    allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
    addDirs: [paths.issueDir],
    statusMessage: `Reviewing issue #${issueNumber} resolution...`,
    phase: 'review',
    permission: 'read-only',
    ...(reviewContext ?? {}),
  });
  // Before the success check: the tokens were spent either way. A correction
  // cycle calls runReview() again and the reducer sums both invocations.
  publishPhaseMetrics('review', result.cost, startedAtMs, result.agent?.provider);

  if (!result.success) {
    printError(`Review failed: ${result.error}`);
    return 1;
  }

  const review = parseIssueReviewResult(result.result);
  if (!review.ok) {
    printError(`Invalid review result: ${review.error}`);
    try {
      const plan = await loadTaskPlan(tasksPath);
      plan.pipeline.reviewCompleted = false;
      plan.issueStatus = 'in_progress';
      plan.completedAt = null;
      plan.lastError = {
        category: 'review_protocol',
        message: review.error,
        at: new Date().toISOString(),
      };
      await saveTaskPlan(tasksPath, plan);
    } catch {
      /* Standalone review may have no task plan. */
    }
    return 1;
  }

  if (review.status === 'PASS') {
    // Update pipeline state
    try {
      const plan = await loadTaskPlan(tasksPath);
      if (plan.lastError?.category === 'review_protocol') plan.lastError = null;
      plan.pipeline.reviewCompleted = true;
      plan.lastReviewFindings = null;
      await saveTaskPlan(tasksPath, plan);
    } catch {
      // tasks.json may not exist
    }

    printSuccess('Review PASSED — implementation meets acceptance criteria');
    return 0;
  }

  printError('Review FAILED — issues found:');
  if (review.findings) {
    console.log(review.findings);
  }

  // Persist the findings so a correction cycle can act on them: without this,
  // a re-run of execute sees every userStories[].passes already true and
  // exits immediately without attempting any fix (see engine.ts's
  // "already complete" guards).
  try {
    const plan = await loadTaskPlan(tasksPath);
    plan.pipeline.reviewCompleted = false;
    if (plan.lastError?.category === 'review_protocol') plan.lastError = null;
    plan.issueStatus = 'in_progress';
    plan.completedAt = null;
    plan.lastReviewFindings = review.findings ?? 'Unknown findings';
    await saveTaskPlan(tasksPath, plan);
  } catch {
    // tasks.json may not exist
  }

  return 1;
}
