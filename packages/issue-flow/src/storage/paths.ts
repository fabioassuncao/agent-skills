import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { getRemoteUrl, normalizeRemoteUrl } from '../utils/git.js';

/** Directory created under the user's home when no override is provided. */
export const GLOBAL_DIR_NAME = '.issue-flow';

/** Environment variable that relocates the whole global storage tree. */
export const GLOBAL_ROOT_ENV = 'ISSUE_FLOW_HOME';

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
  const remote = normalizeRemoteUrl(await getRemoteUrl());

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
