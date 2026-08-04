import { execa } from 'execa';
import { runHeadless } from '../core/headless.js';
import { runPhaseWithRetry } from '../core/phase-runner.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { issuePlaceholders, resolveCommandIssue } from '../issues/context.js';
import type { Issue, ResolvedIssue } from '../issues/types.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import { printError, printSuccess } from '../ui/logger.js';
import { isTransientFailure } from '../utils/retry.js';

/**
 * Extract a PR URL from headless output.
 */
function parsePrUrl(output: string): string | null {
  const match = output.match(/(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/);
  return match?.[1] ?? null;
}

/**
 * The numeric id inside a PR URL, so later phases (`pr-review`) address the
 * Pull Request without querying GitHub again.
 */
function parsePrNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)/);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * The `Closes #N` line for the PR body, empty when the Issue has no remote
 * counterpart: GitHub only understands the reference for Issues it hosts, and
 * an invented `#N` would silently point at an unrelated Issue.
 */
function issueClosesLine(issue: Issue, fallbackId: string): string {
  if (issue.remoteRef === null) {
    return '';
  }
  return `Closes #${issue.number ?? fallbackId}`;
}

export async function runPr(issue: string, resolvedIssue?: ResolvedIssue): Promise<number> {
  const issueNumber = issue.replace(/^#/, '');
  const paths = await resolveIssuePaths(issueNumber);
  const tasksPath = paths.tasksFile;

  const resolution = await resolveCommandIssue(issueNumber, resolvedIssue);
  if (!resolution.ok) {
    return resolution.code;
  }

  // Get current branch
  let branchName: string;
  try {
    const proc = await execa('git', ['branch', '--show-current'], { reject: false });
    branchName = proc.stdout?.toString().trim() ?? '';
    if (!branchName) {
      printError('Could not determine current branch');
      return 1;
    }
  } catch {
    printError('Failed to get current branch');
    return 1;
  }

  const template = await loadPrompt('pr');
  const prompt = applyPlaceholders(template, {
    __ISSUE_NUMBER__: issueNumber,
    __BRANCH_NAME__: branchName,
    __TASKS_PATH__: tasksPath,
    __ISSUE_CLOSES__: issueClosesLine(resolution.resolved.issue, issueNumber),
    ...issuePlaceholders(resolution.resolved),
  });

  let headlessOutput = '';

  const outcome = await runPhaseWithRetry({
    phase: 'pr',
    attempt: async () => {
      const result = await runHeadless({
        prompt,
        maxTurns: 15,
        timeout: getGlobalTimeout() ?? 300_000,
        outputFormat: 'text',
        allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
        addDirs: [paths.issueDir],
        statusMessage: `Creating PR for issue #${issueNumber}...`,
      });

      if (!result.success) {
        return {
          ok: false,
          transient: isTransientFailure(1, result.error ?? ''),
          error: `PR creation failed: ${result.error}`,
        };
      }

      headlessOutput = result.result;
      return { ok: true };
    },
  });

  if (!outcome.ok) {
    printError(outcome.error ?? `PR creation failed for issue #${issueNumber}`);
    return 1;
  }

  const prUrl = parsePrUrl(headlessOutput);

  // Update pipeline state
  try {
    const plan = await loadTaskPlan(tasksPath);
    plan.pipeline.prCreated = true;
    const prNumber = prUrl === null ? null : parsePrNumber(prUrl);
    // Without a URL the PR is still assumed created (the phase succeeded), but
    // there is nothing trustworthy to record: an invented number would send
    // `pr-review` at an unrelated Pull Request.
    if (prUrl !== null && prNumber !== null) {
      plan.pullRequest = {
        number: prNumber,
        url: prUrl,
        headBranch: branchName,
        createdAt: isoNow(),
      };
    }
    await saveTaskPlan(tasksPath, plan);
  } catch {
    // tasks.json may not exist
  }

  if (prUrl) {
    printSuccess(`PR created: ${prUrl}`);
  } else {
    printSuccess('PR creation completed');
  }
  return 0;
}
