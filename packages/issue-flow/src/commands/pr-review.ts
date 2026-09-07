import { join } from 'node:path';
import { loadPrReviewConfig } from '../config.js';
import { DEFAULT_HEADLESS_TIMEOUT_MS, runHeadless } from '../core/headless.js';
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
  readPrReviewIndex,
  reportFileName,
  resolveRound,
} from '../core/pr-review/report.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { publishPhaseMetrics } from '../core/session-metrics.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { viewPullRequest } from '../issues/github/index.js';
import { resolvePolicyPlaceholders } from '../policy/placeholders.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import type { PrReviewRecommendation } from '../types.js';
import { printError, printInfo, printSuccess } from '../ui/logger.js';

/**
 * The `pr-review` phase: review a Pull Request as a whole.
 *
 * It follows the five steps of `review.ts` — resolve the target, build the
 * prompt, run headless, parse deterministically, persist state — with two
 * differences that come from reviewing a Pull Request instead of an Issue: the
 * target has to be discovered (`core/pr-review/discovery.ts`) and the outcome
 * is an artifact on disk, written through a `PrReviewPublisher`.
 *
 * The phase is intended to be read-only: Write/Edit are not allowed, and the
 * prompt forbids commits and `gh pr review|comment|merge`. Bash remains
 * available for `gh`/`git` inspection, so the restriction is policy plus tool
 * allow-list — not a sandbox that can stop every write.
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
  baseRefOid?: string;
}

/**
 * Collect revision metadata without throwing. Missing revisions leave the
 * report available for inspection but cannot produce a verified recommendation.
 *
 * The `gh pr view` call lives in `issues/github/pr.ts`, which is the single
 * implementation of Pull Request reading; only the field list is this
 * command's business.
 */
async function fetchPullRequestMetadata(number: number): Promise<GhPullRequest | null> {
  return viewPullRequest<GhPullRequest>(
    String(number),
    'title,url,headRefName,headRefOid,baseRefOid',
  );
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

  // With no Issue there is nothing to resolve: the placeholders take NO_PATH
  // and the report lands under the synthetic `pr-<N>` slug resolved below.
  const issuePaths = issue === undefined ? null : await resolveIssuePaths(issue);
  const issueDir = issuePaths?.issueDir ?? null;
  const tasksPath = issuePaths?.tasksFile ?? null;
  const prdPath = issuePaths?.prdFile ?? null;

  const dir = await prReviewDir({ issue, pullRequest: target.number });
  const round = await resolveRound(dir, target.number, explicitRound);
  const reportPath = join(dir, reportFileName(target.number, round));

  const meta = await fetchPullRequestMetadata(target.number);
  const previous = (await readPrReviewIndex(dir))?.rounds
    .filter((entry) => entry.round < round)
    .sort((a, b) => b.round - a.round)[0];
  const template = await loadPrompt('pr-review');
  const prompt = applyPlaceholders(template, {
    // The repository's own conventions. Empty when it declares none, which is
    // what keeps the rendered prompt identical to the pre-policy one.
    ...(await resolvePolicyPlaceholders({ phase: 'pr-review' })),
    __PR_HEAD__: meta?.headRefOid ?? 'unavailable',
    __PR_BASE__: meta?.baseRefOid ?? 'unavailable',
    __PREVIOUS_REVIEW__: previous
      ? JSON.stringify({
          headSha: previous.headSha,
          reportPath: join(dir, reportFileName(target.number, previous.round)),
        })
      : '',
    __ISSUE_CONTEXT__: issue === undefined ? '' : 'enabled',
    __PR_NUMBER__: String(target.number),
    __ISSUE_NUMBER__: issue ?? NO_ISSUE,
    __TASKS_PATH__: tasksPath ?? NO_PATH,
    __PRD_PATH__: prdPath ?? NO_PATH,
    __REPORT_PATH__: reportPath,
    __ROUND__: String(round),
  });

  const startedAtMs = Date.now();
  const result = await runHeadless({
    prompt,
    maxTurns: 40,
    timeout: getGlobalTimeout() ?? DEFAULT_HEADLESS_TIMEOUT_MS,
    // json (not text) so the CLI reports usage: the envelope's `result` field
    // carries the same assistant text the parsers below already consumed.
    outputFormat: 'json',
    allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
    // With an Issue, `dir` sits under `issueDir`, so the parent covers both the
    // report destination and the tasks.json/prd.md the prompt points at.
    addDirs: issueDir === null ? [dir] : [issueDir],
    statusMessage: `Reviewing Pull Request #${target.number} (round ${round})...`,
    phase: 'pr-review',
    permission: 'read-only',
  });
  // Before the success check: the tokens were spent either way.
  publishPhaseMetrics('pr-review', result.cost, startedAtMs, result.agent?.provider);

  if (!result.success) {
    printError(`PR review failed: ${result.error}`);
    return 1;
  }

  const parsed = parsePrReviewResult(result.result);
  const latest = await fetchPullRequestMetadata(target.number);
  const revisionError =
    !meta?.headRefOid || !meta.baseRefOid || !latest?.headRefOid || !latest.baseRefOid
      ? 'PR revision could not be verified before and after review.'
      : meta.headRefOid !== latest.headRefOid || meta.baseRefOid !== latest.baseRefOid
        ? 'PR head or base changed during review; this report describes the earlier revision.'
        : null;
  const recommendation = parsed.ok && revisionError === null ? parsed.result.recommendation : null;
  const blockers = parsed.ok ? parsed.result.blockers : [];

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
      parseError: revisionError ?? (parsed.ok ? null : parsed.error),
    }),
  };

  // Which publisher runs is configuration (`prReview.publisher`), never a code
  // path here: the command only ever holds the interface.
  const publisher =
    opts.publisher ?? createPrReviewPublisher(dir, (await loadPrReviewConfig()).publisher);
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
    printError(
      revisionError ??
        `PR review could not be parsed: ${parsed.ok ? 'no recommendation' : parsed.error}`,
    );
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
