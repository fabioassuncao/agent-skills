import { join } from 'node:path';
import { runHeadless } from '../core/headless.js';
import {
  PrDiscoveryError,
  type ResolvedPullRequest,
  resolvePullRequest,
} from '../core/pr-review/discovery.js';
import { createPrReviewPublisher, type PrReviewPublisher } from '../core/pr-review/publisher.js';
import {
  buildReportMarkdown,
  type PrReviewPullRequest,
  parseFindings,
  parsePrReviewResult,
  prReviewDir,
  reportFileName,
  resolveRound,
} from '../core/pr-review/report.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import type { PrReviewRecommendation } from '../types.js';
import { printError, printInfo, printSuccess } from '../ui/logger.js';
import { getIssueDir } from '../utils/git.js';
import { run } from '../utils/shell.js';

/**
 * The `pr-review` phase: review a Pull Request as a whole.
 *
 * It follows the five steps of `review.ts` — resolve the target, build the
 * prompt, run headless, parse deterministically, persist state — with two
 * differences that come from reviewing a Pull Request instead of an Issue: the
 * target has to be discovered (`core/pr-review/discovery.ts`) and the outcome
 * is an artifact on disk, written through a `PrReviewPublisher`.
 *
 * The phase is read-only by construction: the agent may only run `Bash`,
 * `Read`, `Glob` and `Grep`, so it can never "fix" what it is reviewing.
 */

/** Which verdicts make the command fail. */
export type PrReviewFailOn = 'request-changes' | 'suggestions' | 'none';

const FAIL_ON_LEVELS: PrReviewFailOn[] = ['request-changes', 'suggestions', 'none'];
const DEFAULT_FAIL_ON: PrReviewFailOn = 'request-changes';

/** Placeholder value for context the run does not have. */
const NO_ISSUE = 'none';
const NO_PATH = '(none)';

export interface PrReviewOptions {
  /** Issue the Pull Request belongs to; enables plan lookup and state writes. */
  issue?: string;
  /** `--round <n>`: rewrite one specific round instead of appending a new one. */
  round?: string | number;
  /** Skip the discovery confirmation (`--yes`, and every call from `run`). */
  yes?: boolean;
  failOn?: string;
  /** Injection point for tests and for future publishers (GitHub). */
  publisher?: PrReviewPublisher;
}

/**
 * Exit code for a parsed verdict. `1` is reserved for execution failures, so a
 * review that ran to completion answers only `0` or `2`.
 */
export function exitCodeFor(
  recommendation: PrReviewRecommendation,
  failOn: PrReviewFailOn,
): number {
  if (failOn === 'none') {
    return 0;
  }
  if (recommendation === 'REQUEST_CHANGES') {
    return 2;
  }
  return failOn === 'suggestions' && recommendation === 'APPROVE_WITH_SUGGESTIONS' ? 2 : 0;
}

function parseFailOn(value: string | undefined): PrReviewFailOn | null {
  if (value === undefined || value === '') {
    return DEFAULT_FAIL_ON;
  }
  const normalized = value.trim().toLowerCase();
  return FAIL_ON_LEVELS.find((level) => level === normalized) ?? null;
}

/** Metadata `gh` knows and the discovery may not — title, URL, head revision. */
interface GhPullRequest {
  title?: string;
  url?: string;
  headRefName?: string;
  headRefOid?: string;
}

/**
 * Best-effort `gh pr view`. A failure here costs the report a title and the
 * index a head SHA; it never costs the review, so nothing is thrown.
 */
async function fetchPullRequestMetadata(number: number): Promise<GhPullRequest | null> {
  try {
    const result = await run('gh', [
      'pr',
      'view',
      String(number),
      '--json',
      'title,url,headRefName,headRefOid',
    ]);
    if (result.exitCode !== 0) {
      return null;
    }
    const parsed: unknown = JSON.parse(result.stdout);
    return typeof parsed === 'object' && parsed !== null ? (parsed as GhPullRequest) : null;
  } catch {
    return null;
  }
}

function mergePullRequest(
  target: ResolvedPullRequest,
  meta: GhPullRequest | null,
): PrReviewPullRequest {
  return {
    number: target.number,
    url: target.url ?? meta?.url ?? null,
    title: target.title ?? meta?.title ?? null,
    headBranch: target.headBranch ?? meta?.headRefName ?? null,
  };
}

interface PersistInput {
  tasksPath: string;
  pullRequestNumber: number;
  round: number;
  /** null when the verdict could not be parsed. */
  recommendation: PrReviewRecommendation | null;
  at: string;
}

/**
 * Record the round on the plan. Only `prReviewCompleted` and `prReview` are
 * touched: the other phases own the rest of `pipeline`.
 *
 * Best-effort like `review.ts`: reviewing a Pull Request with no associated
 * Issue (or whose plan is gone) is a supported use of the command, not a
 * failure — the report on disk is the deliverable either way.
 */
async function persistState(input: PersistInput): Promise<void> {
  try {
    const plan = await loadTaskPlan(input.tasksPath);
    plan.pipeline.prReviewCompleted =
      input.recommendation === 'APPROVE' || input.recommendation === 'APPROVE_WITH_SUGGESTIONS';
    plan.prReview = {
      // Preserved, never turned on here: opting the pipeline in is `run
      // --pr-review`'s decision, not a side effect of a manual review.
      enabled: plan.prReview?.enabled ?? false,
      pullRequestNumber: input.pullRequestNumber,
      // `--round <n>` rewrites an earlier round, which must not shrink the count.
      rounds: Math.max(plan.prReview?.rounds ?? 0, input.round),
      lastRecommendation: input.recommendation ?? plan.prReview?.lastRecommendation,
      lastReviewedAt: input.at,
    };
    await saveTaskPlan(input.tasksPath, plan);
  } catch {
    // tasks.json may not exist.
  }
}

export async function runPrReview(prArg?: string, opts: PrReviewOptions = {}): Promise<number> {
  const failOn = parseFailOn(opts.failOn);
  if (failOn === null) {
    printError(`Invalid --fail-on value '${opts.failOn}'. Expected ${FAIL_ON_LEVELS.join(', ')}.`);
    return 1;
  }

  const explicitRound = opts.round === undefined ? undefined : Number(opts.round);
  if (explicitRound !== undefined && (!Number.isInteger(explicitRound) || explicitRound < 1)) {
    printError(`Invalid --round value '${opts.round}'. Expected a positive integer.`);
    return 1;
  }

  const issueRef = opts.issue?.replace(/^#/, '').trim();
  const issue = issueRef === undefined || issueRef === '' ? undefined : issueRef;

  let target: ResolvedPullRequest;
  try {
    target = await resolvePullRequest(prArg, { issue, yes: opts.yes });
  } catch (err) {
    if (err instanceof PrDiscoveryError) {
      printError(err.message);
      return err.exitCode;
    }
    printError(
      `Could not determine which Pull Request to review: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const issueDir = issue === undefined ? null : await getIssueDir(issue);
  const tasksPath = issueDir === null ? null : join(issueDir, 'tasks.json');
  const prdPath = issueDir === null ? null : join(issueDir, 'prd.md');

  const dir = await prReviewDir({ issue, pullRequest: target.number });
  const round = await resolveRound(dir, target.number, explicitRound);
  const reportPath = join(dir, reportFileName(target.number, round));

  const template = await loadPrompt('pr-review');
  const prompt = applyPlaceholders(template, {
    __PR_NUMBER__: String(target.number),
    __ISSUE_NUMBER__: issue ?? NO_ISSUE,
    __TASKS_PATH__: tasksPath ?? NO_PATH,
    __PRD_PATH__: prdPath ?? NO_PATH,
    __REPORT_PATH__: reportPath,
    __ROUND__: String(round),
  });

  const result = await runHeadless({
    prompt,
    maxTurns: 40,
    timeout: getGlobalTimeout() ?? 900_000,
    outputFormat: 'text',
    allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
    statusMessage: `Reviewing Pull Request #${target.number} (round ${round})...`,
  });

  if (!result.success) {
    printError(`PR review failed: ${result.error}`);
    return 1;
  }

  const parsed = parsePrReviewResult(result.result);
  const recommendation = parsed.ok ? parsed.result.recommendation : null;
  const blockers = parsed.ok ? parsed.result.blockers : [];

  const meta = await fetchPullRequestMetadata(target.number);
  const pullRequest = mergePullRequest(target, meta);
  const at = isoNow();
  const headSha = meta?.headRefOid ?? null;

  const report = {
    pullRequest,
    round,
    at,
    headSha,
    recommendation,
    blockers,
    findings: parseFindings(result.result),
    markdown: buildReportMarkdown({
      pullRequest,
      round,
      at,
      headSha,
      recommendation,
      body: result.result,
      parseError: parsed.ok ? null : parsed.error,
    }),
  };

  const publisher = opts.publisher ?? createPrReviewPublisher(dir);
  try {
    await publisher.publish(report);
  } catch (err) {
    printError(
      `Could not publish the review report: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  if (tasksPath !== null) {
    await persistState({
      tasksPath,
      pullRequestNumber: target.number,
      round,
      recommendation,
      at,
    });
  }

  printInfo(`Report: ${reportPath}`);

  // A verdict that could not be read is an execution failure, never an
  // approval — the raw output is in the report for whoever has to look.
  if (!parsed.ok || recommendation === null) {
    printError(`PR review could not be parsed: ${parsed.ok ? 'no recommendation' : parsed.error}`);
    return 1;
  }

  if (recommendation === 'REQUEST_CHANGES') {
    printError(`PR review #${target.number}: REQUEST_CHANGES`);
    for (const blocker of blockers) {
      console.log(`  - ${blocker}`);
    }
    return exitCodeFor(recommendation, failOn);
  }

  printSuccess(
    recommendation === 'APPROVE'
      ? `PR review #${target.number}: APPROVE`
      : `PR review #${target.number}: APPROVE_WITH_SUGGESTIONS — no blockers, improvements suggested`,
  );
  return exitCodeFor(recommendation, failOn);
}
