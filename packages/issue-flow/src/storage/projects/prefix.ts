/**
 * Path segments the hub's own route map already owns. A derived prefix must
 * never collide with one, or `/<prefix>/…` would shadow the hub route.
 *
 * The set covers the server API, WebSocket, asset and health routes.
 */
export const RESERVED_PROJECT_PREFIXES: ReadonlySet<string> = new Set([
  'api',
  'ws',
  'assets',
  'health',
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
 * and with the reserved segments the server's route map owns. A thousand colliding
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
