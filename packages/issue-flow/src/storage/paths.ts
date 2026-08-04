import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
