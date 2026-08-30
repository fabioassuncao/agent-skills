import { createInterface } from 'node:readline';
import { printInfo, printWarning } from '../ui/logger.js';
import type { ExecutionPlan, ExecutionPlanIssue } from './types.js';

/**
 * The one place a multi-issue run stops and asks.
 *
 * Discovery may well turn `issue-flow run 50` into four Issues; implementing
 * them without saying so would be the worst possible outcome of this feature.
 * So the pipeline halts **before** any phase runs, prints what it found and
 * lets the user pick the scope.
 */

/** What the user decided about the discovered hierarchy. */
export type QueueChoice = 'requested' | 'all' | 'cancel';

/** How many invalid answers are tolerated before the prompt gives up. */
const MAX_PROMPT_ATTEMPTS = 3;

/** A confirmation that cannot be asked for and was not answered by a flag. */
export class QueueConfirmationError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'QueueConfirmationError';
    this.exitCode = exitCode;
  }
}

export interface ConfirmQueueOptions {
  /** `--yes`: accept the suggested plan (the whole hierarchy) without asking. */
  yes?: boolean;
  /** `--only`: run just the requested Issues, without asking. */
  only?: boolean;
  /**
   * Whether a prompt may be shown. Defaults to a real TTY on both ends outside
   * CI, mirroring `pr-review`'s discovery confirmation.
   */
  interactive?: boolean;
  /**
   * Whether the user asked for a single Issue. Only the hierarchy around it is
   * up for confirmation, so a non-interactive run falls back to that Issue
   * alone instead of failing: running exactly what was asked for can never
   * implement something nobody approved.
   */
  singleRequest?: boolean;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

function isInteractiveByDefault(): boolean {
  const ci = process.env.CI;
  const inCi = ci !== undefined && ci !== '' && ci !== '0' && ci.toLowerCase() !== 'false';
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && !inCi;
}

/** `#50` for a numeric identifier, `auth-refactor` for anything else. */
export function issueLabel(entry: { id: string; number: number | null }): string {
  return entry.number === null ? entry.id : `#${entry.number}`;
}

/** Why this Issue is in the queue, in a few words. */
function reasonFor(entry: ExecutionPlanIssue): string {
  const parts: string[] = [];
  if (entry.origin === 'requested') {
    parts.push('requested');
  }
  if (entry.dependsOn.length > 0) {
    parts.push(`after ${entry.dependsOn.map((id) => `#${id}`).join(', ')}`);
  }
  if (entry.parent !== null) {
    parts.push(`sub-issue of #${entry.parent}`);
  }
  if (entry.priority !== null) {
    parts.push(entry.priority);
  }
  return parts.join(', ');
}

/**
 * The summary printed before the prompt.
 *
 * Returned as lines rather than printed so the shape is testable without
 * capturing stdout — the same split `buildRunSummaryLines` uses.
 */
export function buildQueueSummaryLines(plan: ExecutionPlan): string[] {
  const primary = plan.issues.find((entry) => entry.id === plan.id) ?? plan.issues[0];
  const lines: string[] = [];

  if (primary !== undefined) {
    lines.push(`  Main issue:   ${issueLabel(primary)}${primary.title ? ` ${primary.title}` : ''}`);
  }
  lines.push(`  Total issues: ${plan.issues.length}`);
  lines.push('  Suggested order:');

  for (const entry of plan.issues) {
    const reason = reasonFor(entry);
    const flag = entry.heuristic ? ' ~' : '';
    const title = entry.title === '' ? '' : ` ${entry.title}`;
    lines.push(
      `    ${entry.position}. ${issueLabel(entry)}${title}${reason === '' ? '' : ` (${reason})`}${flag}`,
    );
  }

  if (plan.issues.some((entry) => entry.heuristic)) {
    lines.push('  ~ relation found only in the issue text, which may be a false positive');
  }
  if (plan.truncated) {
    lines.push('  Note: discovery hit its limit — the hierarchy may be larger than shown');
  }

  return lines;
}

/** One-line recap after the user (or a flag) picks a scope. */
export function buildScopeSummaryLine(plan: ExecutionPlan, choice: QueueChoice): string | null {
  if (choice === 'cancel') return null;
  const primary = plan.requested[0] ?? plan.id;
  if (choice === 'requested') {
    return `Scope: ${plan.requested.length} requested issue(s).`;
  }
  return `Scope: ${plan.issues.length} issues from the hierarchy of #${primary}.`;
}

/**
 * Ask, in an interactive terminal, which scope to run.
 *
 * Outside a TTY the answer must come from a flag: `--yes` for the whole
 * hierarchy, `--only` for just what was asked for. Neither is a *default* —
 * silently picking one would either implement Issues nobody approved or ignore
 * a dependency the user was never told about. The command fails instead, which
 * is what keeps an unattended CI run honest.
 */
export async function confirmQueue(
  plan: ExecutionPlan,
  requestedOnlyCount: number,
  options: ConfirmQueueOptions = {},
): Promise<QueueChoice> {
  const info = options.info ?? printInfo;
  const warn = options.warn ?? printWarning;

  info(`Issue ${plan.requested.map((id) => `#${id}`).join(', ')} is part of a larger structure:`);
  for (const line of buildQueueSummaryLines(plan)) {
    (options.stdout ?? process.stdout).write(`${line}\n`);
  }

  if (options.only === true) {
    info(`--only: running just the ${requestedOnlyCount} issue(s) you asked for.`);
    info(buildScopeSummaryLine(plan, 'requested') ?? '');
    return 'requested';
  }
  if (options.yes === true) {
    info(`--yes: running the whole hierarchy (${plan.issues.length} issues).`);
    info(buildScopeSummaryLine(plan, 'all') ?? '');
    return 'all';
  }

  const interactive = options.interactive ?? isInteractiveByDefault();
  if (!interactive && options.singleRequest === true) {
    warn(
      'A larger structure was found, but the terminal is not interactive: running just ' +
        `issue ${plan.requested.map((id) => `#${id}`).join(', ')}. ` +
        'Re-run with --yes to execute the whole hierarchy.',
    );
    const summary = buildScopeSummaryLine(plan, 'requested');
    if (summary) info(summary);
    return 'requested';
  }
  if (!interactive) {
    throw new QueueConfirmationError(
      'This run involves more than one issue and the terminal is not interactive. ' +
        'Re-run with --yes to execute the whole hierarchy, or --only to execute just the ' +
        'issues you informed.',
    );
  }

  const query =
    `Which scope should run? [1] Only the issues informed (${requestedOnlyCount})  ` +
    `[2] The whole hierarchy (${plan.issues.length})  [3] Cancel: `;

  const choice = await ask(
    query,
    options.stdin ?? process.stdin,
    options.stdout ?? process.stdout,
    warn,
  );
  const summary = buildScopeSummaryLine(plan, choice);
  if (summary) info(summary);
  return choice;
}

/**
 * Numbered prompt, sharing the queued-lines discipline of `issues/resolver.ts`:
 * `rl.question` drops input that arrives before the prompt is written, which
 * silently loses a piped answer. EOF answers `cancel` — never consent.
 */
async function ask(
  query: string,
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  warn: (message: string) => void,
): Promise<QueueChoice> {
  const rl = createInterface({ input: stdin, output: stdout });
  const queued: string[] = [];
  let pending: ((line: string | null) => void) | null = null;
  let closed = false;

  rl.on('line', (line: string) => {
    if (pending !== null) {
      const resolve = pending;
      pending = null;
      resolve(line);
      return;
    }
    queued.push(line);
  });
  rl.on('close', () => {
    closed = true;
    if (pending !== null) {
      const resolve = pending;
      pending = null;
      resolve(null);
    }
  });

  const read = (): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      const buffered = queued.shift();
      if (buffered !== undefined) {
        resolve(buffered);
        return;
      }
      if (closed) {
        resolve(null);
        return;
      }
      stdout.write(query);
      pending = resolve;
    });

  try {
    for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
      const answer = await read();
      if (answer === null) {
        return 'cancel';
      }
      const choice = answer.trim();
      if (choice === '1') return 'requested';
      // An empty answer accepts the suggestion, which is the whole point of
      // having computed an order: the same convention as `pr-review`'s (Y/n).
      if (choice === '' || choice === '2') return 'all';
      if (choice === '3') return 'cancel';
      warn(`Invalid choice: '${choice}'. Enter 1, 2 or 3.`);
    }
    return 'cancel';
  } finally {
    rl.close();
  }
}
