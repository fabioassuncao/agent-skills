import { listPullRequestsForBranch } from '../issues/github/index.js';
import {
  getBaseBranch,
  getCommitsSince,
  getCurrentBranch,
  getHeadCommit,
  getProjectRoot,
  getRemoteUrl,
  normalizeRemoteUrl,
  stripRemoteUrlCredentials,
} from '../utils/git.js';
import {
  NullPublisher,
  type SessionCommit,
  type SessionPublisher,
  type SessionPullRequest,
} from './session-state.js';
import { isoNow } from './state-manager.js';

/**
 * Low-frequency enrichment of the session snapshot with git commits and pull
 * requests. Called only at phase boundaries (run.ts) and at the end of each
 * iteration (engine.ts) — never per HTTP request: the server (US-006) serves
 * the in-memory snapshot as-is.
 *
 * Like every monitoring surface, this must never affect the pipeline: with
 * the NullPublisher installed it returns before spawning any subprocess, and
 * every failure is swallowed.
 */

/** Data sources, injectable for tests. */
export interface GitStateSources {
  currentBranch(): Promise<string>;
  baseBranch(): Promise<string>;
  commitsSince(base: string): Promise<SessionCommit[]>;
  pullRequests(branch: string): Promise<SessionPullRequest[]>;
  /** URL of the origin remote, or null when none is configured. */
  remoteUrl(): Promise<string | null>;
  /** Abbreviated hash of HEAD, or null when there is none. */
  headCommit(): Promise<string | null>;
  /** Working directory of the run; falls back to process.cwd(). */
  projectRoot(): Promise<string | null>;
  now(): string;
}

/**
 * List PRs whose head is the given branch via the GitHub CLI. Never throws;
 * returns [] when gh is unavailable, unauthenticated or returns bad JSON.
 *
 * The `gh` call itself lives in `issues/github/pr.ts`, the single
 * implementation of Pull Request reading; this stays as the session-shaped
 * entry point its callers already import.
 */
export interface ListPullRequestsOptions {
  /**
   * `all` — the default, and what the session snapshot reports — or `open`,
   * which is the question "is there already a Pull Request I would be
   * duplicating".
   */
  state?: 'all' | 'open';
}

export async function listPullRequests(
  branch: string,
  options: ListPullRequestsOptions = {},
): Promise<SessionPullRequest[]> {
  return listPullRequestsForBranch(branch, options);
}

const defaultSources: GitStateSources = {
  currentBranch: getCurrentBranch,
  baseBranch: getBaseBranch,
  commitsSince: getCommitsSince,
  pullRequests: listPullRequests,
  remoteUrl: () => getRemoteUrl(),
  headCommit: () => getHeadCommit(),
  // getProjectRoot() throws outside a git repository; the directory the run
  // happens in is still worth reporting, so fall back to it.
  projectRoot: async () => {
    try {
      return await getProjectRoot();
    } catch {
      return process.cwd();
    }
  },
  now: isoNow,
};

/**
 * Run a source in isolation: its failure yields null instead of aborting the
 * whole publication, so one unavailable field never hides the others.
 */
async function collect<T>(source: () => Promise<T | null>): Promise<T | null> {
  try {
    return await source();
  } catch {
    return null;
  }
}

/**
 * Reduce an origin URL to the `owner/repo` identity, dropping the host that
 * normalizeRemoteUrl() prepends. Returns null without a remote.
 *
 * Known limitation inherited from normalizeRemoteUrl(): the result is
 * lowercased, so a repository whose path has uppercase letters is reported in
 * lowercase.
 */
function deriveRepositoryName(remoteUrl: string | null): string | null {
  const normalized = normalizeRemoteUrl(remoteUrl);
  if (normalized === null) return null;
  const slash = normalized.indexOf('/');
  return slash === -1 ? null : normalized.slice(slash + 1);
}

/**
 * Gather branch, base branch, commits, PRs and repository identity, then
 * publish a single git:update event. Never throws.
 */
export async function publishGitState(
  publisher: SessionPublisher,
  sources: Partial<GitStateSources> = {},
): Promise<void> {
  if (publisher instanceof NullPublisher) return;
  const src: GitStateSources = { ...defaultSources, ...sources };

  try {
    const branch = await src.currentBranch();
    const baseBranch = await src.baseBranch();
    const commitBaseline =
      publisher.snapshot().git.branchCreated === false
        ? (publisher.snapshot().git.startCommit ?? baseBranch)
        : baseBranch;
    const [commits, pullRequests, remoteUrl, headCommit, repositoryRoot] = await Promise.all([
      src.commitsSince(commitBaseline),
      src.pullRequests(branch),
      collect(() => src.remoteUrl()),
      collect(() => src.headCommit()),
      collect(() => src.projectRoot()),
    ]);

    publisher.publish({
      type: 'git:update',
      at: src.now(),
      branch,
      baseBranch,
      commits,
      pullRequests,
      repositoryName: deriveRepositoryName(remoteUrl),
      // Never publish the raw remote: an HTTPS remote configured for
      // automation commonly embeds a token (user:token@host), and this event
      // is served unauthenticated by the web monitor and persisted to
      // session.json.
      remoteUrl: stripRemoteUrlCredentials(remoteUrl),
      headCommit,
      repositoryRoot,
    });
  } catch {
    // Monitoring enrichment must never propagate errors to the pipeline.
  }
}
