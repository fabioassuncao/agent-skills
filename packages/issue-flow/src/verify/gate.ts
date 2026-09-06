import { dirname } from 'node:path';
import { setLastError } from '../core/state-manager.js';
import { failureFingerprint, fatalFailedCount } from '../routing/escalation.js';
import { redactSecrets } from '../telemetry/redact.js';
import type { EngineConfig, ResolvedPaths, TaskPlan } from '../types.js';
import { printError, printSuccess, printWarning } from '../ui/logger.js';
import { formatVerificationLine } from './present.js';
import { formatReviewFindings } from './reviewer.js';
import { type AcceptanceOutcome, runAcceptance } from './run-issue.js';
import { frameCheckOutput } from './runner.js';

const contractHistory: { fingerprint: string; fatalFailed: number }[] = [];

/** `prdFile` is `tasks.json` in the issue directory (global or standalone). */
export function resolveIssueDir(_config: EngineConfig, paths: ResolvedPaths): string {
  return dirname(paths.prdFile);
}

export async function runAcceptanceGate(options: {
  issueDir: string;
  cwd?: string;
  addDirs?: string[];
  skipReviewer?: boolean;
}): Promise<AcceptanceOutcome> {
  return runAcceptance({
    issueDir: options.issueDir,
    cwd: options.cwd,
    addDirs: options.addDirs,
    skipReviewer: options.skipReviewer,
  });
}

export function applyAcceptanceToPlan(
  plan: TaskPlan,
  outcome: AcceptanceOutcome,
): { plan: TaskPlan; failed: boolean } {
  const line = formatVerificationLine(outcome.verdict, outcome.level);
  if (outcome.verdict === 'failed') {
    printError(line);
    const results = outcome.contract.results;
    contractHistory.push({
      fingerprint: failureFingerprint(results),
      fatalFailed: fatalFailedCount(results),
    });
    return {
      plan: {
        ...setLastError(plan, 'task_execution', line),
        issueStatus: 'in_progress',
        completedAt: null,
        pipeline: { ...plan.pipeline, executionCompleted: false, reviewCompleted: false },
        lastReviewFindings:
          outcome.review?.status === 'failed'
            ? redactSecrets(formatReviewFindings(outcome.review.findings))
            : results
                .filter((result) => result.fatal && result.status !== 'passed')
                .map((result) =>
                  redactSecrets(
                    `${result.id}: ${result.command ?? 'expected files'} (${result.status})\n${frameCheckOutput(result.output)}`,
                  ),
                )
                .join('\n') || plan.lastReviewFindings,
      },
      failed: true,
    };
  }
  if (outcome.verdict === 'unverified') {
    printWarning(line);
    return { plan, failed: false };
  }
  printSuccess(line);
  return { plan, failed: false };
}
