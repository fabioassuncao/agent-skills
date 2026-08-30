import { readdir, readFile, stat as statFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ValidatedSessionSnapshot } from '../schemas.js';
import { sessionSnapshotSchema } from '../schemas.js';
import {
  type GetGlobalRootOptions,
  getGlobalRoot,
  ISSUES_DIR_NAME,
  PROJECTS_DIR_NAME,
} from '../storage/paths.js';

/**
 * Multi-session discovery for the web monitoring server (US-003).
 *
 * The single-instance server (`web/lock.ts`) runs decoupled from any one
 * pipeline invocation, so it cannot hold a `SessionPublisher` in memory for
 * "the" run being monitored — there may be zero, one or several running at
 * once, each in its own process. Instead this module polls every
 * `~/.issue-flow/projects/<project>/issues/<n>/session.json` on disk (the
 * same file `FilePublisher` already writes) and keeps an in-memory map of the
 * ones that are both well-formed and recently updated.
 *
 * Polling rather than `fs.watch` is a deliberate choice, not a placeholder:
 * `fs.watch`'s `recursive` option is only reliable on macOS and Windows (Linux
 * needs a manual per-directory watch tree, and the whole thing still degrades
 * to polling on network filesystems), while a `~/.issue-flow` tree is small
 * and local — a cheap poll of it is simpler and behaves identically on every
 * platform, which is what the US-003 acceptance criteria ask to validate.
 */

/** How often the directory tree is rescanned, unless overridden. */
export const DEFAULT_POLL_INTERVAL_MS = 3000;

/**
 * A session stops being reported once its file has gone this long without an
 * update. `FilePublisher` touches a live session every 10s without rewriting
 * its content. Three missed heartbeats plus ample scheduling/filesystem slack
 * avoid flapping while still removing an abruptly killed run promptly.
 */
export const DEFAULT_STALE_AFTER_MS = 90_000;

export interface ActiveSession {
  /** Directory the session.json was read from, one level up from the file. */
  issueDir: string;
  filePath: string;
  snapshot: ValidatedSessionSnapshot;
  /** mtime of the file at the last successful read, in epoch ms. */
  updatedAtMs: number;
}

export interface SessionDirectoryOptions extends GetGlobalRootOptions {
  /** Poll interval, in ms. Default {@link DEFAULT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Staleness threshold, in ms. Default {@link DEFAULT_STALE_AFTER_MS}. */
  staleAfterMs?: number;
  /** Invoked (at most once) when a poll fails unexpectedly. Best-effort logging only. */
  onWarn?: (message: string) => void;
}

export interface SessionDirectoryHandle {
  /** Snapshot of every session currently considered active. */
  sessions(): ActiveSession[];
  /** A single active session by id, or undefined. */
  getSession(sessionId: string): ActiveSession | undefined;
  /** Force an immediate rescan instead of waiting for the next tick. Never throws. */
  refresh(): Promise<void>;
  /** Stop polling. Idempotent. */
  close(): void;
}

async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // Symlinks are skipped on purpose, same discipline as the storage
    // migration walk: following one could pull session data from outside the
    // global tree into the listing.
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    // Missing/unreadable projects (or issues) directory reads as "none yet" —
    // this is routinely the case before the first --web run ever happens.
    return [];
  }
}

/** Every `session.json` path currently on disk, one per project/issue pair. */
async function discoverSessionFiles(root: string): Promise<string[]> {
  const projectsDir = join(root, PROJECTS_DIR_NAME);
  const projectIds = await listSubdirectories(projectsDir);

  const perProject = await Promise.all(
    projectIds.map(async (projectId) => {
      const issuesDir = join(projectsDir, projectId, ISSUES_DIR_NAME);
      const issueIds = await listSubdirectories(issuesDir);
      return issueIds.map((issueId) => join(issuesDir, issueId, 'session.json'));
    }),
  );

  return perProject.flat();
}

interface ReadResult {
  snapshot: ValidatedSessionSnapshot;
  updatedAtMs: number;
}

/**
 * Read and validate one `session.json`. Anything short of a fully valid file
 * (missing, mid-write, corrupted, written by an incompatible future version)
 * reads as "not currently a session" — the directory scan must never fail
 * because one file is momentarily inconsistent (`FilePublisher` writes via a
 * temp file + rename, but a reader can still race a concurrent write).
 */
async function readSessionFile(filePath: string): Promise<ReadResult | null> {
  let raw: string;
  let mtimeMs: number;
  try {
    const [content, stat] = await Promise.all([readFile(filePath, 'utf-8'), statFile(filePath)]);
    raw = content;
    mtimeMs = stat.mtimeMs;
  } catch {
    return null;
  }

  try {
    const parsed = sessionSnapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.sessionId === null) return null;
    return { snapshot: parsed.data, updatedAtMs: mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Start polling the global storage tree for active sessions.
 *
 * Returns a handle immediately; the first scan happens synchronously in the
 * background and `sessions()` answers `[]` until it completes, same as "no
 * sessions found yet" — there is nothing to await here that would not also
 * delay the server's very first bind.
 */
export function watchSessionDirectory(
  options: SessionDirectoryOptions = {},
): SessionDirectoryHandle {
  const root = getGlobalRoot(options);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const warn = options.onWarn;

  // Keyed by sessionId, not by file path: a session's identity is the id
  // inside its content, and that is what /api/status?session=<id> looks up.
  let sessions = new Map<string, ActiveSession>();
  let warned = false;

  async function scan(): Promise<void> {
    let files: string[];
    try {
      files = await discoverSessionFiles(root);
    } catch (err) {
      if (!warned) {
        warned = true;
        warn?.(
          `issue-flow: web monitor could not scan the session directory (will keep retrying silently): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }

    const now = Date.now();
    const next = new Map<string, ActiveSession>();
    for (const filePath of files) {
      const result = await readSessionFile(filePath);
      if (result === null) continue;
      if (now - result.updatedAtMs > staleAfterMs) continue; // stopped updating: not active
      const sessionId = result.snapshot.sessionId as string;
      next.set(sessionId, {
        issueDir: join(filePath, '..'),
        filePath,
        snapshot: result.snapshot,
        updatedAtMs: result.updatedAtMs,
      });
    }
    sessions = next;
  }

  // The first scan runs immediately (not just after the first interval tick)
  // so a server started right after a session begins does not report "no
  // sessions" for a whole poll interval.
  void scan();
  const timer = setInterval(() => void scan(), pollIntervalMs);
  timer.unref();

  return {
    sessions: () => [...sessions.values()],
    getSession: (sessionId: string) => sessions.get(sessionId),
    refresh: scan,
    close: () => clearInterval(timer),
  };
}
