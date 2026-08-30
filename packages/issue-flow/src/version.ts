import { createRequire } from 'node:module';

/**
 * The version of the running `issue-flow` package, read once from the manifest.
 *
 * There is a single reader because a wrong version is worse than no version:
 * the web monitor keeps its UI assets in memory, so what the user needs to see
 * is which build is actually serving them — see `docs/web-monitor.md`.
 *
 * Two layouts are supported. From the sources, this module sits at `src/`, one
 * level below the manifest. In the bundle it lands in `dist/`, also one level
 * below — but a caller inlined into a deeper chunk resolves from its own file,
 * so the grandparent is tried as well instead of silently reporting `0.0.0`.
 */

const require = createRequire(import.meta.url);

/** Returned when the manifest cannot be read; never thrown at the caller. */
export const UNKNOWN_VERSION = '0.0.0';

let cached: string | null = null;

export function getPackageVersion(): string {
  if (cached !== null) return cached;
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const version = (require(candidate) as { version?: unknown }).version;
      if (typeof version === 'string' && version !== '') {
        cached = version;
        return cached;
      }
    } catch {
      // Try the other supported layout.
    }
  }
  cached = UNKNOWN_VERSION;
  return cached;
}
