import { dirname } from 'node:path';
import { setLastError } from '../core/state-manager.js';
import { failureFingerprint, fatalFailedCount } from '../routing/escalation.js';
import type { EngineConfig, ResolvedPaths, TaskPlan } from '../types.js';
import { printError, printSuccess, printWarning } from '../ui/logger.js';
import { formatVerificationLine } from './present.js';
import { type AcceptanceOutcome, runAcceptance } from './run-issue.js';

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
      plan: setLastError(plan, 'task_execution', line),
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
