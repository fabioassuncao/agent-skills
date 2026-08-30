import { execa } from 'execa';
import { runHeadless } from '../core/headless.js';
import { runPhaseWithRetry } from '../core/phase-runner.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { publishPhaseMetrics } from '../core/session-metrics.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { issuePlaceholders, resolveCommandIssue } from '../issues/context.js';
import type { Issue, IssueSource, ResolvedIssue } from '../issues/types.js';
import { resolvePolicyPlaceholders } from '../policy/placeholders.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import { printError, printSuccess } from '../ui/logger.js';
import { isTransientFailure } from '../utils/retry.js';

/**
 * Extract a PR URL from headless output.
 */
function parsePrUrl(output: string): string | null {
  const match = output.match(/(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/);
  return match?.[1] ?? null;
}

/**
 * The numeric id inside a PR URL, so later phases (`pr-review`) address the
 * Pull Request without querying GitHub again.
 */
function parsePrNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)/);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * The `Closes #N` line for the PR body, empty when the Issue has no remote
 * counterpart: GitHub only understands the reference for Issues it hosts, and
 * an invented `#N` would silently point at an unrelated Issue.
 */
function issueClosesLine(issue: Issue, fallbackId: string): string {
  if (issue.remoteRef === null) {
    return '';
  }
  return `Closes #${issue.number ?? fallbackId}`;
}

/** One Issue of a queue, as the consolidated Pull Request has to describe it. */
export interface PrQueueIssue {
  id: string;
  number: number | null;
  title: string;
  /** `null` when the Issue was never read — see {@link issueClosesLines}. */
  url: string | null;
  /** Origin the Issue came from; `github` is what GitHub can close. */
  source: IssueSource;
}

/**
 * What a multi-issue queue hands to the `pr` phase.
 *
 * Absent for every standalone run, and that absence is what guarantees the
 * single-issue Pull Request is byte-for-byte the one this command has always
 * produced: the extra placeholders resolve to empty strings.
 */
export interface PrQueueContext {
  /** Issues of the queue, in the order they were executed. */
  issues: PrQueueIssue[];
  /** Issues discovered but not executed, with the reason. */
  excluded: { id: string; number: number | null; title: string; reason: string }[];
  /** Anything else worth reporting as pending (unresolved review findings). */
  pending: string[];
}

export interface RunPrOptions {
  /** Set only when the Pull Request consolidates a queue. */
  queue?: PrQueueContext;
}

/** `#51` when the Issue has a number, its raw identifier otherwise. */
function issueRef(entry: { id: string; number: number | null }): string {
  return entry.number === null ? entry.id : `#${entry.number}`;
}

/**
 * Every `Closes #N` line of a consolidated Pull Request, one per line.
 *
 * Issues that GitHub does not host are skipped for the same reason a
 * single-issue Pull Request skips them — it cannot close what it does not
 * host — and a queue that mixes both origins still gets a valid body.
 *
 * The test is the origin and the number, not the URL: an Issue whose read
 * failed during discovery reaches the queue with `url: null`, and it is still
 * executed and still closed by the queue. Filtering on the URL would leave it
 * out of the very body that is supposed to reference it.
 */
export function issueClosesLines(issues: readonly PrQueueIssue[]): string {
  return issues
    .filter((entry) => entry.source === 'github' && entry.number !== null)
    .map((entry) => `Closes #${entry.number}`)
    .join('\n');
}

/**
 * The extra instructions the prompt receives when the Pull Request covers a
 * whole queue.
 *
 * Returns `''` for a standalone run, which is what keeps `pr.md` rendering
 * exactly as before for the single-issue path — no empty "Issues implemented"
 * section, no redundant ordering of a list of one.
 */
export function multiIssueContext(queue: PrQueueContext | undefined): string {
  if (queue === undefined || queue.issues.length <= 1) {
    return '';
  }

  const order = queue.issues
    .map(
      (entry, index) => `${index + 1}. ${issueRef(entry)}${entry.title ? ` — ${entry.title}` : ''}`,
    )
    .join('\n');

  const pending = [
    ...queue.excluded.map(
      (entry) => `- ${issueRef(entry)}${entry.title ? ` — ${entry.title}` : ''}: ${entry.reason}`,
    ),
    ...queue.pending.map((note) => `- ${note}`),
  ].join('\n');

  return [
    '',
    'This Pull Request consolidates several issues implemented on this same branch,',
    'in this execution order:',
    '',
    order,
    '',
    'The PR body MUST additionally contain:',
    '- an "Issues implemented" section listing every issue above, in that order,',
    '  with one line per issue describing what it delivered;',
    '- a "Pending" section with the items below, verbatim, plus anything you find',
    '  unfinished while reviewing the diff. Write "None" when the list below is',
    '  empty and you find nothing else;',
    '',
    pending === '' ? '(no known pending items)' : pending,
    '',
    'The commits of this branch are scoped per issue (`feat(issue-N): …`), which is',
    'how you tell which change belongs to which issue in `git log`.',
  ].join('\n');
}

export async function runPr(
  issue: string,
  resolvedIssue?: ResolvedIssue,
  options: RunPrOptions = {},
): Promise<number> {
  const issueNumber = issue.replace(/^#/, '');
  const paths = await resolveIssuePaths(issueNumber);
  const tasksPath = paths.tasksFile;

  const resolution = await resolveCommandIssue(issueNumber, resolvedIssue);
  if (!resolution.ok) {
    return resolution.code;
  }

  // Get current branch
  let branchName: string;
  try {
    const proc = await execa('git', ['branch', '--show-current'], { reject: false });
    branchName = proc.stdout?.toString().trim() ?? '';
    if (!branchName) {
      printError('Could not determine current branch');
      return 1;
    }
  } catch {
    printError('Failed to get current branch');
    return 1;
  }

  const queue = options.queue;
  const consolidating = queue !== undefined && queue.issues.length > 1;

  const template = await loadPrompt('pr');
  const prompt = applyPlaceholders(template, {
    // The repository's own conventions. Empty when it declares none, which is
    // what keeps the rendered prompt identical to the pre-policy one.
    ...(await resolvePolicyPlaceholders()),
    __ISSUE_NUMBER__: issueNumber,
    __BRANCH_NAME__: branchName,
    __TASKS_PATH__: tasksPath,
    __ISSUE_CLOSES__: consolidating
      ? issueClosesLines(queue.issues)
      : issueClosesLine(resolution.resolved.issue, issueNumber),
    __MULTI_ISSUE_CONTEXT__: multiIssueContext(queue),
    ...issuePlaceholders(resolution.resolved),
  });

  let headlessOutput = '';

  const outcome = await runPhaseWithRetry({
    phase: 'pr',
    attempt: async () => {
      const startedAtMs = Date.now();
      const result = await runHeadless({
        prompt,
        maxTurns: 15,
        timeout: getGlobalTimeout() ?? 300_000,
        // json (not text) so the CLI reports usage: the envelope's `result`
        // field carries the same assistant text parsePrUrl() already consumed.
        outputFormat: 'json',
        allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
        addDirs: [paths.issueDir],
        statusMessage: `Creating PR for issue #${issueNumber}...`,
      });
      // One event per attempt; the reducer sums them into the phase total.
      publishPhaseMetrics('pr', result.cost, startedAtMs);

      if (!result.success) {
        return {
          ok: false,
          transient: isTransientFailure(1, result.error ?? ''),
          error: `PR creation failed: ${result.error}`,
        };
      }

      headlessOutput = result.result;
      return { ok: true };
    },
  });

  if (!outcome.ok) {
    printError(outcome.error ?? `PR creation failed for issue #${issueNumber}`);
    return 1;
  }

  const prUrl = parsePrUrl(headlessOutput);

  // Update pipeline state
  try {
    const plan = await loadTaskPlan(tasksPath);
    plan.pipeline.prCreated = true;
    const prNumber = prUrl === null ? null : parsePrNumber(prUrl);
    // Without a URL the PR is still assumed created (the phase succeeded), but
    // there is nothing trustworthy to record: an invented number would send
    // `pr-review` at an unrelated Pull Request.
    if (prUrl !== null && prNumber !== null) {
      plan.pullRequest = {
        number: prNumber,
        url: prUrl,
        headBranch: branchName,
        createdAt: isoNow(),
      };
    }
    await saveTaskPlan(tasksPath, plan);
  } catch {
    // tasks.json may not exist
  }

  if (prUrl) {
    printSuccess(`PR created: ${prUrl}`);
  } else {
    printSuccess('PR creation completed');
  }
  return 0;
}
