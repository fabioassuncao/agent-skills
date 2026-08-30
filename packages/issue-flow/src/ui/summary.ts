import chalk from 'chalk';
import { type ClaudeUsage, formatTokens } from '../core/metrics.js';
import { groupBy, summarize } from '../telemetry/aggregate.js';
import type { EngineConfig, PrReviewRecommendation, TaskPlan } from '../types.js';
import {
  formatDuration,
  getIcons,
  getTermWidth,
  printSuccess,
  printWarning,
  useColor,
  useUnicode,
} from './logger.js';

/**
 * Truncate or pad a string to fit within a given width.
 */
function fitLine(text: string, width: number): string {
  if (text.length > width) {
    return text.substring(0, width);
  }
  return text.padEnd(width);
}

/**
 * Print a box with border characters around content lines.
 * Lines equal to "---" render as separator rows.
 */
export function printBox(lines: string[]): void {
  const colored = useColor();
  const unicode = useUnicode();
  const termWidth = getTermWidth();

  // Find max content width
  let maxContentWidth = 0;
  for (const line of lines) {
    if (line !== '---' && line.length > maxContentWidth) {
      maxContentWidth = line.length;
    }
  }

  // Cap to terminal width (border + padding = 4 chars)
  const available = termWidth - 4;
  if (maxContentWidth > available) {
    maxContentWidth = available;
  }
  if (maxContentWidth < 20) {
    maxContentWidth = 20;
  }

  // Box drawing characters
  const tl = unicode ? '\u256D' : '+';
  const tr = unicode ? '\u256E' : '+';
  const bl = unicode ? '\u2570' : '+';
  const br = unicode ? '\u256F' : '+';
  const h = unicode ? '\u2500' : '-';
  const v = unicode ? '\u2502' : '|';
  const sepL = unicode ? '\u251C' : '+';
  const sepR = unicode ? '\u2524' : '+';

  const hrule = h.repeat(maxContentWidth + 2);

  const blue = colored ? chalk.blue : (s: string) => s;
  const _reset = (s: string) => s;

  // Top border
  console.log(blue(`${tl}${hrule}${tr}`));

  // Content lines
  for (const line of lines) {
    if (line === '---') {
      console.log(blue(`${sepL}${hrule}${sepR}`));
    } else {
      const fitted = fitLine(line, maxContentWidth);
      console.log(`${blue(v)} ${fitted} ${blue(v)}`);
    }
  }

  // Bottom border
  console.log(blue(`${bl}${hrule}${br}`));
}

/**
 * Print the startup header box showing engine configuration.
 */
export interface StartupAgentInfo {
  provider: string;
  model?: string | null;
  detail?: string;
}

export function printStartupHeader(
  config: EngineConfig,
  plan: TaskPlan,
  agent?: StartupAgentInfo,
): void {
  const icons = getIcons();

  const storiesTotal = plan.userStories.length;
  const storiesPassing = plan.userStories.filter((s) => s.passes).length;
  const branchName = plan.branchName ?? 'N/A';

  const issueLabel = config.issueNumber ? `Issue #${config.issueNumber}` : 'Standalone mode';

  const maxIterLabel =
    config.maxIterations !== undefined ? String(config.maxIterations) : 'unlimited';

  const retryLabel = config.retryForever
    ? 'unlimited retries'
    : `${config.retryLimit} consecutive retries`;

  const lines = [
    `${icons.start} Issue Flow`,
    '---',
    `Issue:       ${issueLabel}`,
    `Branch:      ${branchName}`,
    `Stories:     ${storiesPassing}/${storiesTotal} passing`,
    `Iterations:  ${maxIterLabel}`,
    `Retries:     ${retryLabel}`,
  ];
  const remaining = storiesTotal - storiesPassing;
  if (remaining > 0) {
    // p50 of execute on the #79 baseline (US-009/US-010 mean, single observation).
    const p50ExecuteSeconds = 518;
    lines.push(
      `Estimate:    ~${formatDuration(remaining * p50ExecuteSeconds)} (${remaining} × p50 execute)`,
    );
  }
  if (agent) {
    const model = agent.model ? ` · ${agent.model}` : '';
    const detail = agent.detail ? ` (${agent.detail})` : '';
    lines.push(`Agent:       ${agent.provider}${model}${detail}`);
  }
  printBox(lines);
}

/**
 * Print the final summary box.
 */
export function printSummaryBox(
  status: 'success' | 'incomplete' | 'failed',
  iterations: number,
  totalRetries: number,
  elapsedSeconds: number,
  plan: TaskPlan,
  extraInfo?: string,
  /**
   * Tokens and cost spent by this run, already resolved by the caller (the
   * process-owned counters in `core/session-metrics.ts`, never the session
   * snapshot — that one is empty whenever web monitoring is off). Omitted or
   * empty means "the CLI reported nothing", and the line is skipped entirely.
   */
  usage?: ClaudeUsage | null,
  usageByAgent?: Record<string, ClaudeUsage>,
): void {
  const icons = getIcons();

  const storiesTotal = plan.userStories.length;
  const storiesPassing = plan.userStories.filter((s) => s.passes).length;
  const duration = formatDuration(elapsedSeconds);

  let statusIcon: string;
  let statusLabel: string;

  switch (status) {
    case 'success':
      statusIcon = icons.success;
      statusLabel = 'Completed';
      break;
    case 'incomplete':
      statusIcon = icons.warn;
      statusLabel = 'Incomplete';
      break;
    case 'failed':
      statusIcon = icons.fail;
      statusLabel = 'Failed';
      break;
  }

  const boxLines = [
    `${icons.end} Issue Flow Summary`,
    '---',
    `Status:      ${statusIcon} ${statusLabel}`,
    `Stories:     ${storiesPassing}/${storiesTotal} passing`,
    `Iterations:  ${iterations}`,
    `Duration:    ${duration}`,
  ];

  boxLines.push(...tokenBoxLines(usage, usageByAgent));
  boxLines.push(...executionCostLines(plan));

  boxLines.push(`Retries:     ${totalRetries}`);

  if (extraInfo) {
    boxLines.push('---');
    boxLines.push(extraInfo);
  }

  console.log('');
  printBox(boxLines);
}

/**
 * What the optional `pr-review` phase produced, as far as the summary cares.
 * `null` in `recommendation` means the verdict could not be recovered from
 * disk — the exit code still told us whether changes were requested.
 */
export interface RunSummaryPrReview {
  requestedChanges: boolean;
  recommendation: PrReviewRecommendation | null;
  reportPath: string | null;
}

/**
 * Everything the final `run` summary prints, already resolved by the caller.
 */
export interface RunSummaryInfo {
  issueNumber: string;
  /** 'unknown' when the branch could not be detected. */
  branchName: string;
  /** Pipelines run with --no-branch open no Pull Request. */
  noBranch: boolean;
  storyCount: number;
  elapsedSeconds: number;
  /** 'unknown' when no Pull Request could be resolved. */
  prUrl: string;
  /** Only set when the pr-review phase actually ran. */
  prReview?: RunSummaryPrReview | null;
  /**
   * Tokens and cost of the whole pipeline, from the process-owned counters in
   * `core/session-metrics.ts`. Absent or empty omits the line.
   */
  usage?: ClaudeUsage | null;
  /** When more than one agent ran, the summary prints one Tokens line each. */
  usageByAgent?: Record<string, ClaudeUsage>;
  /** Acceptance-contract verdict. Absent when the contract never ran. */
  verification?: { verdict: 'passed' | 'failed' | 'unverified'; level?: string | null } | null;
}

function executionCostLines(plan: TaskPlan, prefix = 'Cost:        '): string[] {
  const records = plan.executions ?? [];
  if (records.length === 0) return [];
  const lines: string[] = [];
  const groups = groupBy(records, 'harness');
  let index = 0;
  const pad = ' '.repeat(prefix.length);
  for (const [harness, summary] of groups) {
    const parts: string[] = [];
    if (summary.totalCost.reported > 0) {
      parts.push(`$${summary.totalCost.reported.toFixed(4)} reported`);
    }
    if (summary.totalCost.estimated > 0) {
      parts.push(`$${summary.totalCost.estimated.toFixed(4)} estimated`);
    }
    if (summary.totalCost.unknownExecutions > 0) {
      parts.push(`${summary.totalCost.unknownExecutions} unknown`);
    }
    if (parts.length === 0) {
      const totals = summarize(records).totalCost;
      if (totals.reported === 0 && totals.estimated === 0) {
        parts.push('not reported');
      }
    }
    if (parts.length === 0) continue;
    lines.push(`${index === 0 ? prefix : pad}${harness} · ${parts.join(' · ')}`);
    index += 1;
  }
  return lines;
}

function tokenBoxLines(
  usage?: ClaudeUsage | null,
  usageByAgent?: Record<string, ClaudeUsage>,
): string[] {
  const agents = usageByAgent ? Object.keys(usageByAgent) : [];
  if (agents.length > 1) {
    const lines: string[] = [];
    for (const [index, id] of agents.entries()) {
      const tokens = formatTokens(usageByAgent?.[id]);
      if (tokens === '') continue;
      lines.push(index === 0 ? `Tokens:      ${id} · ${tokens}` : `             ${id} · ${tokens}`);
    }
    return lines;
  }
  const tokens = formatTokens(usage);
  return tokens === '' ? [] : [`Tokens:      ${tokens}`];
}

function tokenSummaryLines(
  usage?: ClaudeUsage | null,
  usageByAgent?: Record<string, ClaudeUsage>,
  prefix = '  Tokens:   ',
): string[] {
  const agents = usageByAgent ? Object.keys(usageByAgent) : [];
  if (agents.length > 1) {
    const pad = ' '.repeat(prefix.length);
    const lines: string[] = [];
    for (const [index, id] of agents.entries()) {
      const tokens = formatTokens(usageByAgent?.[id]);
      if (tokens === '') continue;
      lines.push(`${index === 0 ? prefix : pad}${id} · ${tokens}`);
    }
    return lines;
  }
  const tokens = formatTokens(usage);
  return tokens === '' ? [] : [`${prefix}${tokens}`];
}

/**
 * Detail lines of the final `run` summary (everything below the headline).
 *
 * Kept separate from the printing so the shape is testable without capturing
 * stdout. Without `prReview` the lines are exactly the ones the pipeline has
 * always printed.
 */
export function buildRunSummaryLines(info: RunSummaryInfo): string[] {
  const lines = [
    `  Branch:   ${info.branchName}${info.noBranch ? ' (current)' : ''}`,
    `  Stories:  ${info.storyCount}`,
    `  Duration: ${formatDuration(info.elapsedSeconds)}`,
  ];

  lines.push(...tokenSummaryLines(info.usage, info.usageByAgent));

  if (!info.noBranch) {
    lines.push(`  PR:       ${info.prUrl}`);
  }

  if (info.verification != null) {
    const label =
      info.verification.verdict === 'passed'
        ? 'passed'
        : info.verification.verdict === 'failed'
          ? 'failed'
          : 'unverified';
    lines.push(`  Contract: ${label}`);
  }

  const review = info.prReview;
  if (review) {
    // The exit code is the source of truth for the verdict, so a report whose
    // recommendation could not be read still reports REQUEST_CHANGES.
    const verdict =
      review.recommendation ?? (review.requestedChanges ? 'REQUEST_CHANGES' : 'unknown');
    lines.push(`  Review:   ${verdict}`);
    if (review.reportPath !== null) {
      lines.push(`  Report:   ${review.reportPath}`);
    }
  }

  return lines;
}

/** One issue of a multi-issue queue, as the consolidated summary reports it. */
export interface QueueIssueSummary {
  id: string;
  title: string;
  storyCount: number;
  elapsedSeconds: number;
  /** Tokens and cost of this issue alone — never of the whole queue. */
  usage?: ClaudeUsage | null;
}

/** Everything the consolidated summary of a queue prints. */
export interface QueueSummaryInfo {
  /** Identifier of the queue, i.e. of its primary issue. */
  queueId: string;
  /** Branch every issue shared, `null` when the queue ran with --no-branch. */
  branchName: string | null;
  issues: QueueIssueSummary[];
  /** Issues discovered but left out of the run. */
  excluded: { id: string; title: string }[];
  elapsedSeconds: number;
  /** The single consolidated Pull Request, `null` when none was opened. */
  prUrl: string | null;
  /** Tokens and cost of the whole queue. */
  usage?: ClaudeUsage | null;
  /** Verdict of the pr-review phase, when the queue ran it. */
  prReview?: RunSummaryPrReview | null;
}

/**
 * Detail lines of a queue's final summary.
 *
 * Per-issue lines carry their own duration and cost, which is the visible half
 * of the per-issue metric scoping: what one issue spent is never folded into
 * another's line.
 */
export function buildQueueSummaryLines(info: QueueSummaryInfo): string[] {
  const lines: string[] = [];

  lines.push(`  Branch:   ${info.branchName ?? 'current'}`);
  lines.push(`  Issues:   ${info.issues.length}`);

  for (const issue of info.issues) {
    const tokens = formatTokens(issue.usage);
    const title = issue.title === '' ? '' : ` ${issue.title}`;
    lines.push(
      `    #${issue.id}${title} — ${issue.storyCount} stories, ${formatDuration(issue.elapsedSeconds)}` +
        (tokens === '' ? '' : `, ${tokens}`),
    );
  }

  lines.push(`  Duration: ${formatDuration(info.elapsedSeconds)}`);

  const tokens = formatTokens(info.usage);
  if (tokens !== '') {
    lines.push(`  Tokens:   ${tokens}`);
  }
  if (info.prUrl !== null) {
    lines.push(`  PR:       ${info.prUrl}`);
  }
  if (info.excluded.length > 0) {
    lines.push(`  Skipped:  ${info.excluded.map((entry) => `#${entry.id}`).join(', ')}`);
  }

  const review = info.prReview;
  if (review) {
    lines.push(
      `  Review:   ${review.recommendation ?? (review.requestedChanges ? 'REQUEST_CHANGES' : 'unknown')}`,
    );
    if (review.reportPath !== null) {
      lines.push(`  Report:   ${review.reportPath}`);
    }
  }

  return lines;
}

/** Print the consolidated summary of a multi-issue queue. */
export function printQueueSummary(info: QueueSummaryInfo): void {
  console.log('');
  if (info.prReview?.requestedChanges === true) {
    printWarning(`Queue finished for issue #${info.queueId}, but the PR review requested changes.`);
  } else {
    printSuccess(`Queue complete for issue #${info.queueId} (${info.issues.length} issues)!`);
  }
  for (const line of buildQueueSummaryLines(info)) {
    console.log(line);
  }
}

/**
 * Print the final summary of a `run` (the flat listing, not the box used by
 * the execute engine).
 */
export function printRunSummary(info: RunSummaryInfo): void {
  console.log('');
  if (info.prReview?.requestedChanges) {
    printWarning(
      `Pipeline finished for issue #${info.issueNumber}, but the PR review requested changes.`,
    );
  } else if (info.verification?.verdict === 'unverified') {
    printWarning(
      `Pipeline finished for issue #${info.issueNumber}, but the acceptance contract is unverified.`,
    );
  } else if (info.verification?.verdict === 'failed') {
    printWarning(
      `Pipeline finished for issue #${info.issueNumber}, but the acceptance contract failed.`,
    );
  } else {
    printSuccess(`Pipeline complete for issue #${info.issueNumber}!`);
  }
  for (const line of buildRunSummaryLines(info)) {
    console.log(line);
  }
}
