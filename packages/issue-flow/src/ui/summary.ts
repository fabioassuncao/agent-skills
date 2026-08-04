import chalk from 'chalk';
import { type ClaudeUsage, formatTokens } from '../core/metrics.js';
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
export function printStartupHeader(config: EngineConfig, plan: TaskPlan): void {
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

  printBox([
    `${icons.start} Issue Flow`,
    '---',
    `Issue:       ${issueLabel}`,
    `Branch:      ${branchName}`,
    `Stories:     ${storiesPassing}/${storiesTotal} passing`,
    `Iterations:  ${maxIterLabel}`,
    `Retries:     ${retryLabel}`,
  ]);
}

// Re-export formatDuration from logger to maintain backwards compatibility
export { formatDuration } from './logger.js';

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

  const tokens = formatTokens(usage);
  if (tokens !== '') {
    boxLines.push(`Tokens:      ${tokens}`);
  }

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

  // Skipped altogether when the CLI reported nothing — better no line than
  // "0 in / 0 out" or "~$NaN".
  const tokens = formatTokens(info.usage);
  if (tokens !== '') {
    lines.push(`  Tokens:   ${tokens}`);
  }

  if (!info.noBranch) {
    lines.push(`  PR:       ${info.prUrl}`);
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
  } else {
    printSuccess(`Pipeline complete for issue #${info.issueNumber}!`);
  }
  for (const line of buildRunSummaryLines(info)) {
    console.log(line);
  }
}
