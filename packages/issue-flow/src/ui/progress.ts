import chalk from 'chalk';
import { getOutputCallback } from '../core/verbose.js';
import type { UserStory } from '../types.js';
import { getIcons, useColor, useUnicode } from './logger.js';

/**
 * Print a visual progress bar showing passed/total stories.
 */
export function printProgressBar(passed: number, total: number): string {
  const barWidth = 20;
  let pct = 0;
  let filled = 0;

  if (total > 0) {
    pct = Math.floor((passed * 100) / total);
    filled = Math.floor((passed * barWidth) / total);
  }

  const empty = barWidth - filled;
  const fillChar = useUnicode() ? '\u2588' : '#';
  const emptyChar = useUnicode() ? '\u2591' : '-';

  const bar = fillChar.repeat(filled) + emptyChar.repeat(empty);
  const text = `${passed}/${total} (${pct}%)`;

  if (useColor()) {
    return `${chalk.green(bar)} ${text}`;
  }
  return `${bar} ${text}`;
}

/**
 * Print the iteration header showing story statuses and progress bar.
 *
 * When a global output callback is set (e.g., inside a listr2 task),
 * output is routed through it instead of console.log.
 *
 * `activeStoryId`, when provided, identifies the story the engine is
 * actually about to work on this iteration (the same id published on
 * `iteration:start` \u2014 see `core/state-manager.ts`'s `selectActiveStory`),
 * so the header agrees with the session snapshot instead of guessing.
 * Omitted, it falls back to the previous heuristic ("first non-passing story
 * in array order"), which existing callers that cannot supply the real id
 * keep relying on.
 */
export function printIterationHeader(
  iteration: number,
  maxIter: number | undefined,
  stories: UserStory[],
  activeStoryId?: string,
): void {
  const icons = getIcons();
  const colored = useColor();
  const cb = getOutputCallback();

  const iterLabel = maxIter ? `Iteration ${iteration} of ${maxIter}` : `Iteration ${iteration}`;

  const total = stories.length;
  const passed = stories.filter((s) => s.passes).length;

  const lines: string[] = [];

  if (colored) {
    lines.push(chalk.blue(`\u2501\u2501\u2501 ${icons.start} ${iterLabel} \u2501\u2501\u2501`));
  } else {
    lines.push(`--- ${icons.start} ${iterLabel} ---`);
  }

  // Display each story status
  let foundFirstPending = false;
  for (const story of stories) {
    let icon: string;
    let colorFn: (s: string) => string;
    const isActive =
      activeStoryId !== undefined
        ? story.id === activeStoryId
        : !story.passes && !foundFirstPending;

    if (story.passes) {
      icon = icons.success;
      colorFn = colored ? chalk.green : (s: string) => s;
    } else if (isActive) {
      icon = icons.pending;
      colorFn = colored ? chalk.yellow : (s: string) => s;
      foundFirstPending = true;
    } else {
      // Not yet reached
      icon = icons.notReached;
      colorFn = colored ? chalk.gray : (s: string) => s;
    }

    lines.push(colorFn(`  ${icon} ${story.id}: ${story.title}`));
  }

  lines.push(`  ${printProgressBar(passed, total)}`);

  if (cb) {
    // Send as single output to listr2 task context
    cb(lines.join('\n'));
  } else {
    console.log('');
    for (const line of lines) {
      console.log(line);
    }
    console.log('');
  }
}
