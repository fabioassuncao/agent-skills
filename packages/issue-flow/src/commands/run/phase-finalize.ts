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
import { finishIssueClosure } from './closure.js';
import { verificationForSummary } from './publish.js';
import type { IssueRunResult, PrReviewOutcome } from './types.js';

function reportReviewOutcome(review: PrReviewOutcome | null): void {
  // A PR review asking for changes is not a pipeline failure, but the work is
  // not done either: the warning is highlighted and the issue stays open.
  if (review?.requestedChanges) {
    console.log('');
    printWarning('PR review requested changes — the Pull Request is not ready to merge.');
    if (review.reportPath !== null) {
      console.log(`  Report: ${review.reportPath}`);
    }
  }

  if (review?.requestedChanges) {
    printInfo('Issue left open until the review blockers are addressed.');
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

  reportReviewOutcome(review);
  const closurePlan = !inQueue ? await loadTaskPlan(tasksPath).catch(() => null) : null;
  if (
    !inQueue &&
    !review?.requestedChanges &&
    (closurePlan?.closeIssue || closurePlan?.lastError?.category === 'issue_closure')
  ) {
    const code = await finishIssueClosure(tasksPath, issueNumber, resolvedIssue.source);
    if (code !== 0)
      return {
        code,
        failedPhase: 'close',
        branchName: producedBranch,
        storyCount: 0,
        elapsedSeconds,
        review,
      };
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
  let planPrUrl: string | null = null;
  try {
    const plan = await loadTaskPlan(tasksPath);
    storyCount = plan.userStories.length;
    // The `pr` phase records the Pull Request it opened; trusting it spares a
    // round-trip to the GitHub CLI below.
    planPrUrl = plan.pullRequest?.url ?? null;

    plan.lastAttemptAt = isoNow();
    if (!review?.requestedChanges && !inQueue) {
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
