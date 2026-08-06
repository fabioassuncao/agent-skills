import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { getRemoteUrl, normalizeRemoteUrl } from '../utils/git.js';

/** Directory created under the user's home when no override is provided. */
export const GLOBAL_DIR_NAME = '.issue-flow';

/** Environment variable that relocates the whole global storage tree. */
export const GLOBAL_ROOT_ENV = 'ISSUE_FLOW_HOME';

/** Directory under the global root holding one folder per project. */
export const PROJECTS_DIR_NAME = 'projects';

/** Directory under a project holding one folder per issue. */
export const ISSUES_DIR_NAME = 'issues';

/** Directory under a project holding one folder per multi-issue execution queue. */
export const QUEUES_DIR_NAME = 'queues';

export interface GetGlobalRootOptions {
  /** Environment source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the root directory of the global storage tree (`~/.issue-flow`).
 *
 * Every path under the global storage MUST be derived from this function: it is
 * the single seam where `ISSUE_FLOW_HOME` takes effect, which is what lets
 * tests, CI and sandboxes point the whole tree at a temporary directory instead
 * of touching the real `$HOME`. A call site that joins `homedir()` by hand
 * silently opts out of that isolation.
 *
 * Pure and synchronous: it never creates directories nor touches the
 * filesystem — callers decide when (and whether) the directory should exist.
 */
export function getGlobalRoot(options: GetGlobalRootOptions = {}): string {
  const env = options.env ?? process.env;

  const override = env[GLOBAL_ROOT_ENV]?.trim();
  if (override) {
    // A relative override is resolved against the CWD so that every consumer
    // gets an absolute path, exactly as in the homedir() branch below.
    return resolve(override);
  }

  // The only failure mode: an environment where the home directory cannot be
  // determined (some containers and CI images). The override is the escape
  // hatch, so the error names it.
  let home: string;
  try {
    home = homedir();
  } catch {
    home = '';
  }
  if (home.trim() === '') {
    throw new Error(
      `Unable to resolve the home directory for the global storage. Set ${GLOBAL_ROOT_ENV} to an explicit path.`,
    );
  }

  return join(home, GLOBAL_DIR_NAME);
}

/** Maximum length of the human-readable half of a project id. */
const SLUG_MAX_LENGTH = 32;

/** Number of hex characters kept from the sha256 of the seed. */
const HASH_LENGTH = 12;

/** Used when the repository name has no character that survives sanitization. */
const FALLBACK_SLUG = 'project';

/**
 * Reduce an arbitrary repository name to a path-safe slug: lowercase, only
 * `[a-z0-9-]`, runs of separators collapsed, truncated to {@link SLUG_MAX_LENGTH}.
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');

  return slug === '' ? FALLBACK_SLUG : slug;
}

/**
 * Derive a stable identifier for a project, in the form `<slug>-<hash12>`.
 *
 * The seed is canonical rather than local, so the same repository yields the
 * same id on any machine: `remote:<normalizedRemote>` whenever an `origin`
 * remote exists, falling back to `path:<absoluteProjectRoot>` when it does not.
 * That is what makes moving or renaming the local folder harmless for a cloned
 * repository — the history stays attached to the remote identity.
 *
 * The `remote:` / `path:` prefix is part of the hashed seed, so a project
 * identified by path can never collide with one identified by remote even if
 * the two strings were to coincide. The slug is only cosmetic (it makes the
 * directory recognizable); the hash carries the identity.
 *
 * Known limitation of the path fallback: for a repository with no `origin`
 * remote, the absolute path *is* the identity. Moving or renaming that folder
 * produces a different id, and the previous history is left behind under the
 * old one. Configuring a remote before adopting the global storage avoids it.
 */
export async function getProjectId(projectRoot: string): Promise<string> {
  const remote = normalizeRemoteUrl(await getRemoteUrl(projectRoot));
  return projectIdFromRemote(remote, projectRoot);
}

/**
 * Pure half of {@link getProjectId}: derive the id once the normalized remote
 * (or `null`) is already known.
 *
 * Exported so a caller that already resolved the remote for another reason
 * (e.g. {@link resolveStorageMode} in `compat.ts`, which also persists it into
 * `metadata.json`) can compute the id without shelling out to git a second
 * time.
 */
export function projectIdFromRemote(remote: string | null, projectRoot: string): string {
  let seed: string;
  let name: string;
  if (remote) {
    // `host/org/repo` -> the repository name is the last path segment.
    seed = `remote:${remote}`;
    name = remote.split('/').pop() ?? '';
  } else {
    const absolute = resolve(projectRoot);
    seed = `path:${absolute}`;
    name = basename(absolute);
  }

  const hash = createHash('sha256').update(seed).digest('hex').slice(0, HASH_LENGTH);

  return `${slugify(name)}-${hash}`;
}

/**
 * Absolute directory of a project inside the global storage tree.
 *
 * `projectId` is expected to come from {@link getProjectId}, which already
 * guarantees a single safe path segment.
 */
export function getProjectDir(projectId: string, options: GetGlobalRootOptions = {}): string {
  return join(getGlobalRoot(options), PROJECTS_DIR_NAME, projectId);
}

/**
 * Every artifact of one issue, resolved from a single place.
 *
 * Note that `prdFile` is the requirements document (`prd.md`) and `tasksFile`
 * is the task plan (`tasks.json`) — unlike `ResolvedPaths.prdFile` in
 * `types.ts`, which historically points at `tasks.json`.
 */
export interface IssuePaths {
  issueDir: string;
  issueFile: string;
  metadataFile: string;
  prdFile: string;
  tasksFile: string;
  progressFile: string;
  analysisFile: string;
  sessionFile: string;
  lastBranchFile: string;
  archiveDir: string;
  prReviewDir: string;
}

/**
 * Artifacts of one multi-issue execution queue.
 *
 * A queue coordinates several issues that share a branch; each issue keeps its
 * own directory under {@link ISSUES_DIR_NAME} exactly as before, and only the
 * coordination state (order, per-issue status, shared branch, consolidated Pull
 * Request) lives here. That is what keeps a single-issue run byte-identical: it
 * never creates a queue at all.
 */
export interface QueuePaths {
  queueDir: string;
  planFile: string;
}

/**
 * Resolve the paths of one execution queue under the global storage.
 *
 * The queue id is the identifier of the primary issue — the first one the user
 * asked for — so re-running the same command finds the same queue and resumes
 * it instead of starting a parallel one.
 *
 * Pure and synchronous like every other helper here: nothing is created.
 */
export function getQueuePaths(
  projectId: string,
  queueId: string | number,
  options: GetGlobalRootOptions = {},
): QueuePaths {
  const queueDir = join(
    getProjectDir(projectId, options),
    QUEUES_DIR_NAME,
    normalizeIssueNumber(queueId),
  );

  return { queueDir, planFile: join(queueDir, 'execution-plan.json') };
}

/**
 * Issue identifiers become path segments, so anything that could escape the
 * issues directory is rejected before it reaches `join` — the same discipline
 * as `normalizeId()` in `issues/providers/local.ts`.
 *
 * Non-numeric identifiers (`auth-refactor`, `pr-184`) are first-class here:
 * the local provider already supports them, so the global storage must too.
 */
function normalizeIssueNumber(issueNumber: string | number): string {
  const normalized = String(issueNumber).trim().replace(/^#/, '');

  if (normalized.length === 0) {
    throw new Error('Issue identifier cannot be empty');
  }
  if (/[/\\]/.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error(`Invalid issue identifier: '${issueNumber}'`);
  }

  return normalized;
}

/**
 * Resolve every path of a single issue under the global storage.
 *
 * This is the only place allowed to know the layout of an issue directory:
 * call sites ask for the artifact they need instead of joining names by hand,
 * so renaming or adding an artifact stays a one-file change.
 *
 * Pure and synchronous: nothing here creates directories or touches the
 * filesystem.
 */
export function getIssuePaths(
  projectId: string,
  issueNumber: string | number,
  options: GetGlobalRootOptions = {},
): IssuePaths {
  const issueDir = join(
    getProjectDir(projectId, options),
    ISSUES_DIR_NAME,
    normalizeIssueNumber(issueNumber),
  );

  return {
    issueDir,
    issueFile: join(issueDir, 'issue.md'),
    metadataFile: join(issueDir, 'metadata.json'),
    prdFile: join(issueDir, 'prd.md'),
    tasksFile: join(issueDir, 'tasks.json'),
    progressFile: join(issueDir, 'progress.txt'),
    analysisFile: join(issueDir, 'analysis.md'),
    sessionFile: join(issueDir, 'session.json'),
    lastBranchFile: join(issueDir, '.last-branch'),
    archiveDir: join(issueDir, 'archive'),
    prReviewDir: join(issueDir, 'pr-review'),
  };
}
