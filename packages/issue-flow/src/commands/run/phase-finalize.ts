import { execa } from 'execa';
import { mostRecent } from '../../core/pr-review/discovery.js';
import { listPullRequests } from '../../core/session-git.js';
import { getRunUsageTotals } from '../../core/session-metrics.js';
import { getSessionPublisher } from '../../core/session-publisher.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../../core/state-manager.js';
import type { ResolvedIssue } from '../../issues/types.js';
import { printInfo, printSuccess, printWarning } from '../../ui/logger.js';
import { printRunSummary } from '../../ui/summary.js';
import type { PrQueueContext } from '../pr.js';
import { verificationForSummary } from './publish.js';
import { closeIssue } from './pull-request.js';
import type { IssueRunResult, PrReviewOutcome } from './types.js';

export async function applyReviewOutcomeAndClose(input: {
  issueNumber: string;
  resolvedIssue: ResolvedIssue;
  review: PrReviewOutcome | null;
  inQueue: boolean;
}): Promise<void> {
  const { issueNumber, resolvedIssue, review, inQueue } = input;

  // A PR review asking for changes is not a pipeline failure, but the work is
  // not done either: the warning is highlighted and the issue stays open.
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
}

async function resolveSummaryPrUrl(input: {
  effectiveNoBranch: boolean;
  source: ResolvedIssue['source'];
  planPrUrl: string | null;
  branchName: string;
}): Promise<string> {
  let prUrl = 'unknown';
  if (!input.effectiveNoBranch && input.source === 'github') {
    if (input.planPrUrl !== null) {
      prUrl = input.planPrUrl;
    } else if (input.branchName !== 'unknown' && input.branchName !== '') {
      try {
        const latest = mostRecent(await listPullRequests(input.branchName));
        if (latest !== null) {
          prUrl = latest.url;
        }
      } catch {
        /* non-critical */
      }
    }
  }
  return prUrl;
}

export async function finalizeSuccessfulIssueRun(input: {
  issueNumber: string;
  tasksPath: string;
  resolvedIssue: ResolvedIssue;
  review: PrReviewOutcome | null;
  inQueue: boolean;
  finalPr: PrQueueContext | undefined;
  producedBranch: string | null;
  effectiveNoBranch: boolean;
  elapsedSeconds: number;
}): Promise<IssueRunResult> {
  const {
    issueNumber,
    tasksPath,
    resolvedIssue,
    review,
    inQueue,
    finalPr,
    producedBranch,
    effectiveNoBranch,
    elapsedSeconds,
  } = input;

  await applyReviewOutcomeAndClose({ issueNumber, resolvedIssue, review, inQueue });

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
      elapsedSeconds: elapsedSeconds,
      review,
    };
  }

  const prUrl = await resolveSummaryPrUrl({
    effectiveNoBranch,
    source: resolvedIssue.source,
    planPrUrl,
    branchName,
  });

  printRunSummary({
    issueNumber,
    branchName,
    noBranch: effectiveNoBranch,
    storyCount,
    elapsedSeconds: elapsedSeconds,
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
    elapsedSeconds: elapsedSeconds,
  };
}
