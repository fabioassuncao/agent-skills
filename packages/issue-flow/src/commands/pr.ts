import { execa } from 'execa';
import {
  issueReferenceLines,
  pullRequestTitle,
  resolveChangeType,
  resolveGitConvention,
} from '../conventions/git/index.js';
import { DEFAULT_HEADLESS_TIMEOUT_MS, runHeadless } from '../core/headless.js';
import { runPhaseWithRetry } from '../core/phase-runner.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { listPullRequests } from '../core/session-git.js';
import { publishPhaseMetrics } from '../core/session-metrics.js';
import { isoNow, loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { issuePlaceholders, resolveCommandIssue } from '../issues/context.js';
import type { Issue, IssueSource, ResolvedIssue } from '../issues/types.js';
import { loadRepositoryPolicy } from '../policy/index.js';
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
function issueClosesLine(issue: Issue, fallbackId: string, complete: boolean): string {
  if (issue.remoteRef === null) {
    return '';
  }
  const number = issue.number ?? (/^\d+$/.test(fallbackId) ? Number(fallbackId) : null);
  if (number === null) {
    return '';
  }
  return issueReferenceLines({ references: [{ number, complete }] });
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
  parent?: string | null;
  role?: 'executable' | 'container';
  /** When false, the body uses `Refs` instead of `Closes`. */
  complete?: boolean;
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
  return issueReferenceLines({
    references: issues
      .filter((entry) => entry.source === 'github' && entry.number !== null)
      .map((entry) => ({
        number: entry.number as number,
        complete: entry.complete !== false,
      })),
  });
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

  const byId = new Map(queue.issues.map((entry) => [entry.id, entry]));
  const depthOf = (entry: PrQueueIssue): number => {
    let depth = 0;
    let parent = entry.parent ?? null;
    const seen = new Set<string>();
    while (parent !== null && !seen.has(parent)) {
      seen.add(parent);
      depth += 1;
      parent = byId.get(parent)?.parent ?? null;
    }
    return depth;
  };
  const order = queue.issues
    .map((entry, index) => {
      const indent = '  '.repeat(depthOf(entry));
      const role = entry.role === 'container' ? ' (container)' : '';
      return `${index + 1}. ${indent}${issueRef(entry)}${entry.title ? ` — ${entry.title}` : ''}${role}`;
    })
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

/**
 * Adopt the Pull Request that is already open for this branch, if there is one.
 *
 * "Already open" is the only safe reading: a *closed* Pull Request for the same
 * branch is a decision someone made, and reopening or reusing it would undo it.
 * A merged one means the work is done and a new branch is the answer.
 *
 * Returns `true` when the phase has nothing left to do. Never throws — a `gh`
 * that cannot answer leaves the phase to run exactly as it did before.
 */
async function adoptExistingPullRequest(
  branchName: string,
  tasksPath: string,
  issueNumber: string,
): Promise<boolean> {
  let open: Awaited<ReturnType<typeof listPullRequests>>;
  try {
    open = await listPullRequests(branchName, { state: 'open' });
  } catch {
    return false;
  }

  const existing = open[0];
  if (existing === undefined) return false;

  try {
    const plan = await loadTaskPlan(tasksPath);
    plan.pipeline.prCreated = true;
    plan.pullRequest = {
      number: existing.number,
      url: existing.url,
      headBranch: branchName,
      // The Pull Request predates this attempt; what is recorded is when this
      // run adopted it, which is the only timestamp this process can vouch for.
      createdAt: isoNow(),
    };
    await saveTaskPlan(tasksPath, plan);
  } catch {
    // No plan yet: the adoption still stands, there is just nowhere to note it.
  }

  printSuccess(
    `Pull Request already open for ${branchName}: ${existing.url}. Adopting it instead of opening a second one for issue #${issueNumber}.`,
  );
  return true;
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

  // Idempotence, before anything is invoked.
  //
  // `runPhaseWithRetry` retries this phase up to three times, and the timeout
  // that used to end a run is now correctly classified as transient — so an
  // attempt that created the Pull Request and *then* timed out would have the
  // next attempt create a second one. Asking GitHub what already exists is the
  // cheap half of the fix; the expensive half would be undoing a duplicate.
  const adopted = await adoptExistingPullRequest(branchName, tasksPath, issueNumber);
  if (adopted) return 0;

  const queue = options.queue;
  const consolidating = queue !== undefined && queue.issues.length > 1;

  let planComplete = false;
  try {
    const existing = await loadTaskPlan(tasksPath);
    planComplete =
      existing.userStories.every((story) => story.passes) &&
      (existing.lastReviewFindings === null || existing.lastReviewFindings === '');
  } catch {
    planComplete = false;
  }

  const policy = await loadRepositoryPolicy();
  const change = resolveChangeType({
    labels: resolution.resolved.issue.labels,
    typeMap: policy.git.typeMap,
    allowedTypes: policy.git.allowedTypes,
  });
  // `titleFormat: 'free'` when the repository declared a title convention of
  // its own: the fallback then stops rendering one over it (ADR-11).
  const prTitle = pullRequestTitle({
    format: resolveGitConvention({ ...policy.git }).pullRequest.titleFormat,
    type: change.type,
    subject: resolution.resolved.issue.title.replace(/^\s*\[[^\]]+\]\s*/, ''),
  });

  const template = await loadPrompt('pr');
  const prompt = applyPlaceholders(template, {
    // The repository's own conventions. Empty when it declares none, which is
    // what keeps the rendered prompt identical to the pre-policy one.
    ...(await resolvePolicyPlaceholders({ phase: 'pr' })),
    __ISSUE_NUMBER__: issueNumber,
    __BRANCH_NAME__: branchName,
    __TASKS_PATH__: tasksPath,
    __PR_TITLE_CONVENTION__: prTitle,
    __ISSUE_REFERENCE__: consolidating
      ? issueClosesLines(queue.issues)
      : issueClosesLine(resolution.resolved.issue, issueNumber, planComplete),
    __MULTI_ISSUE_CONTEXT__: multiIssueContext(queue),
    ...issuePlaceholders(resolution.resolved, paths.issueFile),
  });

  let headlessOutput = '';

  const outcome = await runPhaseWithRetry({
    phase: 'pr',
    attempt: async () => {
      const startedAtMs = Date.now();
      const result = await runHeadless({
        prompt,
        maxTurns: 15,
        timeout: getGlobalTimeout() ?? DEFAULT_HEADLESS_TIMEOUT_MS,
        timeoutHistory: {
          phase: 'pr',
          journalFiles: [paths.rotatedEventsFile, paths.eventsFile],
        },
        // json (not text) so the CLI reports usage: the envelope's `result`
        // field carries the same assistant text parsePrUrl() already consumed.
        outputFormat: 'json',
        allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
        addDirs: [paths.issueDir],
        statusMessage: `Creating PR for issue #${issueNumber}...`,
        phase: 'pr',
        permission: 'workspace',
      });
      // One event per attempt; the reducer sums them into the phase total.
      publishPhaseMetrics('pr', result.cost, startedAtMs, result.agent?.provider);

      if (!result.success) {
        return {
          ok: false,
          transient: result.retryExhausted !== true && isTransientFailure(1, result.error ?? ''),
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
  const parsedPrNumber = prUrl === null ? null : parsePrNumber(prUrl);
  let pullRequest =
    prUrl === null || parsedPrNumber === null ? null : { number: parsedPrNumber, url: prUrl };

  // The agent may create the Pull Request successfully but omit (or mangle)
  // its URL in the final answer. Ask GitHub again after the side effect so the
  // durable plan never loses a trustworthy PR that now exists for this branch.
  if (pullRequest === null) {
    try {
      const [discovered] = await listPullRequests(branchName, { state: 'open' });
      if (discovered !== undefined) {
        pullRequest = { number: discovered.number, url: discovered.url };
      }
    } catch {
      // With no trustworthy answer, keep the historical successful-but-unlinked state.
    }
  }

  // Update pipeline state
  try {
    const plan = await loadTaskPlan(tasksPath);
    plan.pipeline.prCreated = true;
    // Without an output URL or a post-create GitHub match the PR is still
    // assumed created (the phase succeeded), but no number is invented.
    if (pullRequest !== null) {
      plan.pullRequest = {
        number: pullRequest.number,
        url: pullRequest.url,
        headBranch: branchName,
        createdAt: isoNow(),
      };
    }
    await saveTaskPlan(tasksPath, plan);
  } catch {
    // tasks.json may not exist
  }

  if (pullRequest !== null) {
    printSuccess(`PR created: ${pullRequest.url}`);
  } else {
    printSuccess('PR creation completed');
  }
  return 0;
}
