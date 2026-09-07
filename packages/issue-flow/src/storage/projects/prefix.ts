/**
 * URL-path prefix for one project, derived from its root — never persisted.
 *
 * PORT of `deriveProjectPrefix()` / `sanitizeProjectPrefix()` /
 * `RESERVED_PROJECT_PREFIXES` from `backend/src/domain/policies.ts` @ d8c9d5f.
 * Pure functions, so the port is literal apart from the fallback label and the
 * reserved list, which name this project's own routes.
 *
 * Deriving rather than storing is deliberate: a prefix is a routing
 * convenience, and persisting one would create a second identity competing
 * with `projectId` — exactly the duplication §47.2 forbids. Two checkouts that
 * share a basename get `web` and `web-2` in the order the process learned
 * about them, and the collision suffix is the entire mechanism.
 */

/**
 * Path segments the hub's own route map already owns. A derived prefix must
 * never collide with one, or `/<prefix>/…` would shadow the hub route.
 *
 * Wider than the upstream set (`api`, `ws`, `assets`) because this server also
 * answers `/api/health` at the root and serves the dashboard bundle from
 * `/assets/`.
 *
 * `legacy` stays reserved after §50.8 removed the panel that lived there. The
 * route is gone, so `/legacy/` is a 404 — and a 404 is the honest answer for a
 * bookmark of a panel that no longer exists. Freeing the word would let a
 * project called `legacy` claim that address and quietly answer *something*
 * else at it, which is worse than nothing.
 */
export const RESERVED_PROJECT_PREFIXES: ReadonlySet<string> = new Set([
  'api',
  'ws',
  'assets',
  'health',
  'legacy',
]);

/** Fallback label when a basename sanitizes to nothing usable. */
const FALLBACK_PREFIX = 'project';

/**
 * Sanitize a string into a URL-path-friendly prefix: lowercase, hyphenated,
 * alphanumeric only. Returns an empty string when nothing usable remains.
 */
export function sanitizeProjectPrefix(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * Derive a project URL prefix from a project directory basename.
 *
 * Adds `-2`, `-3`, … suffixes to avoid collisions with already-taken prefixes
 * and with the reserved segments the server's route map owns. The bounded loop
 * and its timestamp escape hatch come from the original: a thousand colliding
 * basenames is not a reason to hang or to return a duplicate.
 */
export function deriveProjectPrefix(projectRoot: string, takenPrefixes: Iterable<string>): string {
  const basename =
    projectRoot
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? FALLBACK_PREFIX;
  const base = sanitizeProjectPrefix(basename) || FALLBACK_PREFIX;

  const taken = new Set<string>([...takenPrefixes, ...RESERVED_PROJECT_PREFIXES]);
  if (!taken.has(base)) return base;

  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
