import { runHeadless } from '../core/headless.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { issuePlaceholders, resolveCommandIssue } from '../issues/context.js';
import type { ResolvedIssue } from '../issues/types.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import { printError, printSuccess } from '../ui/logger.js';

export interface ReviewResult {
  status: 'PASS' | 'FAIL';
  findings?: string;
}

/**
 * Parse the <review-result> block from headless output.
 */
function parseReviewResult(output: string): ReviewResult {
  const match = output.match(/<review-result>([\s\S]*?)<\/review-result>/);
  if (!match) {
    // Try to detect PASS/FAIL from the raw output
    if (/STATUS:\s*PASS/i.test(output)) {
      return { status: 'PASS' };
    }
    if (/STATUS:\s*FAIL/i.test(output)) {
      const findingsMatch = output.match(/FINDINGS:([\s\S]*?)(?:$|<\/)/);
      return { status: 'FAIL', findings: findingsMatch?.[1]?.trim() ?? 'Unknown findings' };
    }
    // Default to PASS if no explicit status found and no errors
    return { status: 'PASS' };
  }

  const block = match[1];
  if (/STATUS:\s*PASS/i.test(block)) {
    return { status: 'PASS' };
  }

  const findingsMatch = block.match(/FINDINGS:([\s\S]*)/);
  return {
    status: 'FAIL',
    findings: findingsMatch?.[1]?.trim() ?? 'Unknown findings',
  };
}

export async function runReview(issue: string, resolvedIssue?: ResolvedIssue): Promise<number> {
  const issueNumber = issue.replace(/^#/, '');
  const paths = await resolveIssuePaths(issueNumber);
  const tasksPath = paths.tasksFile;

  const resolution = await resolveCommandIssue(issueNumber, resolvedIssue);
  if (!resolution.ok) {
    return resolution.code;
  }

  const template = await loadPrompt('review');
  const prompt = applyPlaceholders(template, {
    __ISSUE_NUMBER__: issueNumber,
    __TASKS_PATH__: tasksPath,
    ...issuePlaceholders(resolution.resolved),
  });

  const result = await runHeadless({
    prompt,
    maxTurns: 25,
    timeout: getGlobalTimeout() ?? 300_000,
    outputFormat: 'text',
    allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
    addDirs: [paths.issueDir],
    statusMessage: `Reviewing issue #${issueNumber} resolution...`,
  });

  if (!result.success) {
    printError(`Review failed: ${result.error}`);
    return 1;
  }

  const review = parseReviewResult(result.result);

  if (review.status === 'PASS') {
    // Update pipeline state
    try {
      const plan = await loadTaskPlan(tasksPath);
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
    plan.lastReviewFindings = review.findings ?? 'Unknown findings';
    await saveTaskPlan(tasksPath, plan);
  } catch {
    // tasks.json may not exist
  }

  return 1;
}
