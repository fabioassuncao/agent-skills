/**
 * Keeping a project's secrets out of the tmux server's global environment.
 *
 * Ported from WebMux `backend/src/adapters/project-env.ts` @ d8c9d5f. §2.3 of
 * the absorption plan calls this the second of the two defences worth more than
 * the rest of the tmux adapter, and the fact behind it is this:
 *
 * **Whichever tmux command first starts the server fixes the global environment
 * for the whole life of that server.** If that command carried a project's
 * `.env`, every pane created afterwards — in any project, for as long as the
 * server lives — inherits those secrets.
 *
 * Issue Flow removes the *class* of bug structurally with a dedicated socket
 * (`-L issue-flow`, ADR-09), so the server is never shared with the user's own
 * tmux. This stays as the safety net the upstream needed it to be: a dedicated
 * socket does not help a server this project itself started with a polluted
 * environment.
 */

/** Marker variable naming the keys a caller loaded from a project `.env`. */
export const PROJECT_ENV_KEYS_VARIABLE = 'ISSUE_FLOW_PROJECT_ENV_KEYS';

/**
 * Keys that must never reach the tmux environment.
 *
 * The marker variable is stripped too. It holds key *names*, not values, but
 * there is no reason to let an internal marker reach a global environment
 * either.
 */
export function leakedProjectEnvKeys(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const raw = env[PROJECT_ENV_KEYS_VARIABLE];
  if (!raw) return new Set();
  const keys = new Set<string>([PROJECT_ENV_KEYS_VARIABLE]);
  for (const key of raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    keys.add(key);
  }
  return keys;
}

/**
 * A copy of `base` with those keys removed.
 *
 * Snapshots `base` at call time. The leaked keys are fixed at launch, so a later
 * mutation of one of them is intentionally not reflected — the question this
 * answers is "what did this process load from a project", and that does not
 * change afterwards.
 */
export function stripProjectEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const keys = leakedProjectEnvKeys(base);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !keys.has(key)) env[key] = value;
  }
  return env;
}
