import type { Readable, Writable } from 'node:stream';
import { printInfo, printWarning } from '../ui/logger.js';
import { isInteractive, promptSelect } from '../ui/prompts.js';
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
export type QueueChoice = 'requested' | 'all' | 'cascade' | 'cancel';

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
  /** `--cascade`: the hierarchy of a container, without implementing it. */
  cascade?: boolean;
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
  stdin?: Readable;
  stdout?: Writable;
  /** Abort the prompt without selecting a scope. */
  signal?: AbortSignal;
  info?: (message: string) => void;
  warn?: (message: string) => void;
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
    const role = primary.role === 'container' ? '   (container)' : '';
    lines.push(
      `  Main issue:   ${issueLabel(primary)}${primary.title ? ` ${primary.title}` : ''}${role}`,
    );
  }
  const executables = plan.issues.filter((entry) => entry.role !== 'container').length;
  const containers = plan.issues.length - executables;
  lines.push(
    containers > 0
      ? `  Total issues: ${executables} executable + ${containers} container`
      : `  Total issues: ${plan.issues.length}`,
  );
  lines.push('  Suggested order:');

  for (const entry of plan.issues) {
    const reason = reasonFor(entry);
    const flag = entry.heuristic ? ' ~' : '';
    const external =
      entry.externalDependencies.length > 0
        ? `  ⚠ depends on ${entry.externalDependencies.map((id) => `#${id}`).join(', ')} (outside this scope)`
        : '';
    const role = entry.role === 'container' ? ' (container)' : '';
    const title = entry.title === '' ? '' : ` ${entry.title}`;
    lines.push(
      `    ${entry.position}. ${issueLabel(entry)}${title}${role}${reason === '' ? '' : ` (${reason})`}${flag}${external}`,
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
  if (choice === 'cascade') {
    const executables = plan.issues.filter((entry) => entry.role !== 'container').length;
    return `Scope: hierarchy of #${primary} (${executables} executable, container not implemented).`;
  }
  return `Scope: ${plan.issues.length} issues from the hierarchy of #${primary}.`;
}

function requestedIsContainer(plan: ExecutionPlan): boolean {
  return plan.issues.some(
    (entry) => plan.requested.includes(entry.id) && entry.role === 'container',
  );
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
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  info(`Issue ${plan.requested.map((id) => `#${id}`).join(', ')} is part of a larger structure:`);
  for (const line of buildQueueSummaryLines(plan)) {
    stdout.write(`${line}\n`);
  }

  const container = requestedIsContainer(plan);

  if (options.only === true) {
    if (container) {
      warn(
        `${plan.requested.map((id) => `#${id}`).join(', ')} is a container. ` +
          '--only will run it as an executable issue.',
      );
    }
    info(`--only: running just the ${requestedOnlyCount} issue(s) you asked for.`);
    info(buildScopeSummaryLine(plan, 'requested') ?? '');
    return 'requested';
  }
  if (options.cascade === true || (options.yes === true && container)) {
    info(
      `${options.cascade === true ? '--cascade' : '--yes'}: running the hierarchy of the container, without implementing it.`,
    );
    info(buildScopeSummaryLine(plan, 'cascade') ?? '');
    return 'cascade';
  }
  if (options.yes === true) {
    info(`--yes: running the whole hierarchy (${plan.issues.length} issues).`);
    info(buildScopeSummaryLine(plan, 'all') ?? '');
    return 'all';
  }

  const interactive = options.interactive ?? isInteractive({ stdin, stdout, ci: process.env.CI });
  if (!interactive && container) {
    throw new QueueConfirmationError(
      `${plan.requested.map((id) => `#${id}`).join(', ')} is a container (umbrella) and the terminal is not interactive. ` +
        'Re-run with --cascade to execute its children, or --only to execute just that issue.',
    );
  }
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

  const choice = await selectScope(
    plan,
    requestedOnlyCount,
    stdin,
    stdout,
    container,
    options.signal,
  );
  const summary = buildScopeSummaryLine(plan, choice);
  if (summary) info(summary);
  return choice;
}

async function selectScope(
  plan: ExecutionPlan,
  requestedOnlyCount: number,
  stdin: Readable,
  stdout: Writable,
  container: boolean,
  signal?: AbortSignal,
): Promise<QueueChoice> {
  const executableCount = plan.issues.filter((entry) => entry.role !== 'container').length;
  const options: Array<{ value: QueueChoice; label: string }> = container
    ? [
        {
          value: 'cascade',
          label: `The hierarchy of #${plan.id} (${executableCount} executable issues)`,
        },
        { value: 'all', label: 'Include dependencies outside the container' },
        { value: 'requested', label: `Just #${plan.id} itself` },
        { value: 'cancel', label: 'Cancel' },
      ]
    : [
        {
          value: 'requested',
          label: `Only the issues informed (${requestedOnlyCount})`,
        },
        { value: 'all', label: `The whole hierarchy (${plan.issues.length})` },
        { value: 'cancel', label: 'Cancel' },
      ];

  const result = await promptSelect<QueueChoice>({
    message: 'Which scope should run?',
    options,
    initialValue: container ? 'cascade' : 'all',
    stdin,
    stdout,
    signal,
  });
  return result.status === 'cancelled' ? 'cancel' : result.value;
}
