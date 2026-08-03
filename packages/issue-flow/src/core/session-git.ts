import { getBaseBranch, getCommitsSince, getCurrentBranch } from '../utils/git.js';
import { run } from '../utils/shell.js';
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
  now(): string;
}

/**
 * List PRs whose head is the given branch via the GitHub CLI. Never throws;
 * returns [] when gh is unavailable, unauthenticated or returns bad JSON.
 */
export async function listPullRequests(branch: string): Promise<SessionPullRequest[]> {
  if (!branch) return [];

  const result = await run('gh', [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'all',
    '--json',
    'number,url,title',
    '--limit',
    '10',
  ]);
  if (result.exitCode !== 0) return [];

  try {
    const parsed: unknown = JSON.parse(result.stdout || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (pr): pr is { number: number; url: string; title: string } =>
          typeof pr === 'object' &&
          pr !== null &&
          typeof (pr as { number?: unknown }).number === 'number' &&
          typeof (pr as { url?: unknown }).url === 'string' &&
          typeof (pr as { title?: unknown }).title === 'string',
      )
      .map((pr) => ({ number: pr.number, url: pr.url, title: pr.title }));
  } catch {
    return [];
  }
}

const defaultSources: GitStateSources = {
  currentBranch: getCurrentBranch,
  baseBranch: getBaseBranch,
  commitsSince: getCommitsSince,
  pullRequests: listPullRequests,
  now: isoNow,
};

/**
 * Gather branch, base branch, commits and PRs, then publish a single
 * git:update event. Never throws.
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
    const [commits, pullRequests] = await Promise.all([
      src.commitsSince(baseBranch),
      src.pullRequests(branch),
    ]);

    publisher.publish({
      type: 'git:update',
      at: src.now(),
      branch,
      baseBranch,
      commits,
      pullRequests,
    });
  } catch {
    // Monitoring enrichment must never propagate errors to the pipeline.
  }
}
