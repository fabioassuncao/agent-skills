import { RESERVED_PROJECT_PREFIXES } from '../storage/projects/prefix.js';

/**
 * Which project a request belongs to, decided per request.
 *
 * ADAPT of the upstream's prefixed route map (`backend/src/server.ts` @
 * d8c9d5f), which republished every project route through `Bun.serve().reload()`
 * whenever the project set changed. `node:http` has no `reload()`, and the
 * translation is not a workaround but a simplification: resolving
 * `/(?<prefix>[^/]+)/api/…` at request time removes a whole class of bugs
 * (routes published against a stale project map, a reload racing an in-flight
 * request) and is the same dispatch a WebSocket would do from `ws.data.prefix`.
 *
 * Unprefixed paths keep working untouched. That is deliberate: the hub view,
 * every existing `/api/*` route and the dashboard assets are the behaviour a
 * single-project user already has, and it must not start depending on knowing
 * a prefix.
 */

export interface ResolvedRoute {
  /** The project this request addresses, or `null` for a hub route. */
  prefix: string | null;
  /** The path the route table should match, with any prefix stripped. */
  path: string;
}

const PREFIXED_PATH = /^\/(?<prefix>[^/]+)(?<rest>\/.*)$/;

/**
 * Split `pathname` into the project prefix and the remaining route.
 *
 * A first segment is only treated as a prefix when it is **currently served**:
 * an unknown one falls through to the hub route table, so a typo answers the
 * hub's own 404 instead of a confusing "project not found" for a path that was
 * never a project path. Reserved segments are rejected before the lookup, so a
 * project can never shadow `/api/…`, however it was registered.
 */
export function resolveProjectRoute(
  pathname: string,
  isServedPrefix: (prefix: string) => boolean,
): ResolvedRoute {
  const match = PREFIXED_PATH.exec(pathname);
  const prefix = match?.groups?.prefix;
  const rest = match?.groups?.rest;
  if (prefix === undefined || rest === undefined) return { prefix: null, path: pathname };
  if (RESERVED_PROJECT_PREFIXES.has(prefix)) return { prefix: null, path: pathname };
  if (!isServedPrefix(prefix)) return { prefix: null, path: pathname };
  return { prefix, path: rest };
}

/**
 * Match `DELETE /api/projects/:prefix`, returning the prefix.
 *
 * Kept here rather than inline in the server so the one place that parses a
 * path segment into a project prefix is the one place that also knows what a
 * prefix may look like.
 */
export function matchProjectResource(pathname: string): string | null {
  const match = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  return match === null ? null : decodeURIComponent(match[1]);
}
