import type { Readable, Writable } from 'node:stream';
import { resolveIssuePaths } from '../../storage/resolve.js';
import type { PullRequestRef } from '../../types.js';
import { printInfo, printWarning } from '../../ui/logger.js';
import { isInteractive, promptConfirm } from '../../ui/prompts.js';
import { getCurrentBranch } from '../../utils/git.js';
import { listPullRequests } from '../session-git.js';
import { getSessionPublisher } from '../session-publisher.js';
import type { SessionPullRequest } from '../session-state.js';
import { loadTaskPlan } from '../state-manager.js';

/**
 * Which Pull Request the `pr-review` phase should look at.
 *
 * The order is deterministic and the search never falls back to "some PR of
 * this repository": a review pointed at an unrelated Pull Request is worse
 * than no review at all, so an exhausted search is an actionable error.
 */

/** Origin of the resolved Pull Request, in precedence order. */
export type PullRequestSource = 'argument' | 'session' | 'plan' | 'branch';

export interface ResolvedPullRequest {
  number: number;
  /** Only known when the origin carried it; never synthesized. */
  url: string | null;
  title: string | null;
  headBranch: string | null;
  source: PullRequestSource;
}

/**
 * Failure to settle on a Pull Request. Carries the exit code the CLI should
 * return, mirroring IssueResolutionError (`issues/resolver.ts`).
 */
export class PrDiscoveryError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'PrDiscoveryError';
    this.exitCode = exitCode;
  }
}

/** Data sources, injectable for tests — the pattern of `GitStateSources`. */
export interface PrDiscoverySources {
  /** PRs already known to the active session publisher (`--web` runs). */
  sessionPullRequests(): SessionPullRequest[];
  /** `plan.pullRequest` persisted by the `pr` phase, or null. */
  planPullRequest(issue: string): Promise<PullRequestRef | null>;
  currentBranch(): Promise<string>;
  branchPullRequests(branch: string): Promise<SessionPullRequest[]>;
}

export interface ResolvePullRequestOptions {
  /** Issue the pipeline is working on; enables the `plan` source. */
  issue?: string;
  /** `--yes`, or any non-interactive caller (`run`): skip the confirmation. */
  yes?: boolean;
  /**
   * Whether a prompt may be shown. Defaults to a real TTY on both ends outside
   * CI, which is what keeps the confirmation from blocking a headless run.
   */
  interactive?: boolean;
  /** Input stream for the confirmation. Defaults to process.stdin. */
  stdin?: Readable;
  /** Output stream for the confirmation. Defaults to process.stdout. */
  stdout?: Writable;
  /** Abort the confirmation without accepting its suggested value. */
  signal?: AbortSignal;
  /** Informational sink. Defaults to printInfo. */
  info?: (message: string) => void;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
  sources?: Partial<PrDiscoverySources>;
}

const SOURCE_LABELS: Record<PullRequestSource, string> = {
  argument: 'the command argument',
  session: 'the current session',
  plan: 'tasks.json',
  branch: 'the current branch',
};

/**
 * `plan.pullRequest` of the issue's global tasks.json. Best-effort: a missing
 * plan, an invalid one or a plan written before the `pr` phase ran is simply
 * "no candidate", never a failure — the next source still gets its turn.
 */
async function loadPlanPullRequest(issue: string): Promise<PullRequestRef | null> {
  try {
    const plan = await loadTaskPlan((await resolveIssuePaths(issue)).tasksFile);
    return plan.pullRequest ?? null;
  } catch {
    return null;
  }
}

const defaultSources: PrDiscoverySources = {
  sessionPullRequests: () => getSessionPublisher().snapshot().pullRequests,
  planPullRequest: loadPlanPullRequest,
  currentBranch: getCurrentBranch,
  branchPullRequests: listPullRequests,
};

/**
 * The most recent of several Pull Requests: the highest number, which does not
 * depend on the order the source returned them.
 */
export function mostRecent(pullRequests: SessionPullRequest[]): SessionPullRequest | null {
  let latest: SessionPullRequest | null = null;
  for (const pr of pullRequests) {
    if (latest === null || pr.number > latest.number) {
      latest = pr;
    }
  }
  return latest;
}

/**
 * The PR number inside an explicit argument: `184`, `#184` or a GitHub URL.
 * Returns null for anything else, so a typo fails loudly instead of being
 * coerced into a number that addresses an unrelated Pull Request.
 */
function parsePrArgument(arg: string): number | null {
  const trimmed = arg.trim();
  const fromUrl = trimmed.match(/\/pull\/(\d+)/);
  if (fromUrl?.[1] !== undefined) {
    return Number(fromUrl[1]);
  }
  const plain = trimmed.match(/^#?(\d+)$/);
  return plain?.[1] === undefined ? null : Number(plain[1]);
}

/** Human-readable one-liner for logs and the confirmation prompt. */
function describe(pr: ResolvedPullRequest): string {
  const parts = [`#${pr.number}`];
  if (pr.title !== null) parts.push(`"${pr.title}"`);
  if (pr.headBranch !== null) parts.push(`(${pr.headBranch})`);
  return parts.join(' ');
}

/**
 * Settle on the Pull Request to review, in this order:
 *
 * 1. the explicit argument;
 * 2. `plan.pullRequest`, written by the `pr` phase (when an issue is known);
 * 3. the PRs the active in-memory session publisher already knows about
 *    (populated during `run --web` via `publishGitState` — not by reading
 *    `session.json` from disk);
 * 4. the PRs of the current branch, via `gh`;
 * 5. an actionable failure.
 *
 * The plan is preferred over the session: after `pr`, `plan.pullRequest` is the
 * authoritative record of what this pipeline opened, while the session may
 * still list older PRs for the same branch (`gh pr list --state all`).
 *
 * Sources 2–4 were discovered rather than requested, so they require either
 * `--yes` or an explicit interactive confirmation before a long (and paid)
 * review starts. CI and non-TTY callers fail closed without rendering a
 * prompt; an explicit Pull Request argument remains prompt-free.
 */
export async function resolvePullRequest(
  prArg?: string,
  opts: ResolvePullRequestOptions = {},
): Promise<ResolvedPullRequest> {
  const info = opts.info ?? printInfo;
  const warn = opts.warn ?? printWarning;
  const sources: PrDiscoverySources = { ...defaultSources, ...opts.sources };

  if (prArg !== undefined && prArg.trim() !== '') {
    const number = parsePrArgument(prArg);
    if (number === null) {
      throw new PrDiscoveryError(
        `Invalid Pull Request reference '${prArg.trim()}'. ` +
          'Use a number (e.g. 184) or a GitHub Pull Request URL.',
      );
    }
    const url = prArg.trim().includes('/pull/') ? prArg.trim() : null;
    return { number, url, title: null, headBranch: null, source: 'argument' };
  }

  const discovered = await discover(sources, opts.issue, warn);
  if (discovered === null) {
    throw new PrDiscoveryError(
      'No Pull Request found for this branch, in tasks.json or in the current session. ' +
        'Run `issue-flow pr-review <number>` with the Pull Request number.',
    );
  }

  if (opts.yes === true) {
    info(
      `Reviewing Pull Request ${describe(discovered)}, found in ${SOURCE_LABELS[discovered.source]}.`,
    );
    return discovered;
  }

  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const interactive = opts.interactive ?? isInteractive({ stdin, stdout, ci: process.env.CI });
  if (!interactive) {
    throw new PrDiscoveryError(
      `Pull Request ${describe(discovered)} was discovered in ${SOURCE_LABELS[discovered.source]}, ` +
        'but the terminal is not interactive. Re-run with --yes or pass a specific Pull Request.',
    );
  }

  info(`Pull Request found in ${SOURCE_LABELS[discovered.source]}:`);
  info(`  number: #${discovered.number}`);
  info(`  title:  ${discovered.title ?? '(unknown)'}`);
  info(`  branch: ${discovered.headBranch ?? '(unknown)'}`);

  const result = await promptConfirm({
    message: `Review Pull Request #${discovered.number}?`,
    initialValue: true,
    stdin,
    stdout,
    signal: opts.signal,
  });
  if (result.status === 'cancelled' || result.value !== true) {
    throw new PrDiscoveryError(
      `Cancelled: Pull Request #${discovered.number} was not confirmed. ` +
        'Run `issue-flow pr-review <number>` to review a specific Pull Request.',
    );
  }
  return discovered;
}

/**
 * Sources 2–4, in order, stopping at the first hit. Every source is allowed to
 * fail on its own: a broken `gh` or an unreadable plan must not mask a
 * candidate another source could still provide.
 */
async function discover(
  sources: PrDiscoverySources,
  issue: string | undefined,
  warn: (message: string) => void,
): Promise<ResolvedPullRequest | null> {
  if (issue !== undefined && issue !== '') {
    try {
      const fromPlan = await sources.planPullRequest(issue);
      if (fromPlan !== null) {
        return {
          number: fromPlan.number,
          url: fromPlan.url,
          title: null,
          headBranch: fromPlan.headBranch,
          source: 'plan',
        };
      }
    } catch {
      // An unreadable plan is "no candidate", never a hard failure.
    }
  }

  let sessionPrs: SessionPullRequest[] = [];
  try {
    sessionPrs = sources.sessionPullRequests();
  } catch {
    // The monitoring snapshot is an optimization, never a requirement.
  }
  const fromSession = mostRecent(sessionPrs);
  if (fromSession !== null) {
    return {
      number: fromSession.number,
      url: fromSession.url,
      title: fromSession.title,
      headBranch: null,
      source: 'session',
    };
  }

  let branch = '';
  try {
    branch = await sources.currentBranch();
  } catch (err) {
    warn(
      `Could not detect the current branch: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (branch === '') {
    return null;
  }

  let branchPrs: SessionPullRequest[] = [];
  try {
    branchPrs = await sources.branchPullRequests(branch);
  } catch (err) {
    warn(
      `Could not list Pull Requests for branch '${branch}': ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const fromBranch = mostRecent(branchPrs);
  if (fromBranch === null) {
    return null;
  }
  return {
    number: fromBranch.number,
    url: fromBranch.url,
    title: fromBranch.title,
    headBranch: branch,
    source: 'branch',
  };
}
