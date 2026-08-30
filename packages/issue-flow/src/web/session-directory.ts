import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type JournalEntry, parseJournal } from '../core/journal.js';
import { sessionSnapshotSchema, type ValidatedSessionSnapshot } from '../schemas.js';
import {
  listStoredSessionEvents,
  listStoredSessions,
  type StoredSession,
} from '../storage/db/repository.js';
import {
  EVENTS_FILENAME,
  type GetGlobalRootOptions,
  getGlobalRoot,
  ISSUES_DIR_NAME,
  PROJECTS_DIR_NAME,
  ROTATED_EVENTS_FILENAME,
  SESSION_FILENAME,
} from '../storage/paths.js';
import { readSessionFile } from '../storage/session-file.js';

/** How often the monitor refreshes indexed session state. */
export const DEFAULT_POLL_INTERVAL_MS = 3000;

/** A run remains visible through three missed ten-second heartbeats. */
export const DEFAULT_STALE_AFTER_MS = 90_000;

export interface ActiveSession {
  /** SQLite project identity, used to retrieve this session's event stream. */
  projectId: string;
  issueId: string;
  snapshot: ValidatedSessionSnapshot;
  /** Latest database heartbeat in epoch milliseconds. */
  updatedAtMs: number;
}

export interface SessionDirectoryOptions extends GetGlobalRootOptions {
  pollIntervalMs?: number;
  staleAfterMs?: number;
  onWarn?: (message: string) => void;
  storageDriver?: 'sqlite' | 'json';
}

export interface SessionDirectoryHandle {
  sessions(): ActiveSession[];
  getSession(sessionId: string): ActiveSession | undefined;
  events(sessionId: string): Promise<JournalEntry[] | undefined>;
  refresh(): Promise<void>;
  close(): void;
}

/**
 * Poll the canonical SQLite session history for every project on this machine.
 *
 * `session.json` and JSONL journals remain compatibility projections for
 * agents and older tooling, but the detached monitor must not traverse them:
 * it is often a different process and SQLite gives it one indexed, atomic view
 * of sessions, heartbeats and event ordering.
 */
export function watchSessionDirectory(
  options: SessionDirectoryOptions = {},
): SessionDirectoryHandle {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const warn = options.onWarn;
  const storageDriver = options.storageDriver ?? 'sqlite';
  const root = getGlobalRoot(options);
  let sessions = new Map<string, ActiveSession>();
  let warned = false;

  async function scan(): Promise<void> {
    try {
      if (storageDriver === 'json') {
        sessions = await scanJsonSessions(root, staleAfterMs);
        return;
      }
      const since = new Date(Date.now() - staleAfterMs).toISOString();
      const stored = await listStoredSessions({
        activeSince: since,
        ...(options.env === undefined ? {} : { databaseOptions: { env: options.env } }),
      });
      sessions = toSessionMap(stored);
    } catch (error) {
      if (!warned) {
        warned = true;
        warn?.(
          `issue-flow: web monitor could not query SQLite session state (will keep retrying silently): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  void scan();
  const timer = setInterval(() => void scan(), pollIntervalMs);
  timer.unref();

  return {
    sessions: () => [...sessions.values()],
    getSession: (sessionId) => sessions.get(sessionId),
    events: async (sessionId) => {
      const session = sessions.get(sessionId);
      if (session === undefined) return undefined;
      if (storageDriver === 'json') {
        const issueDir = join(
          root,
          PROJECTS_DIR_NAME,
          session.projectId,
          ISSUES_DIR_NAME,
          session.issueId,
        );
        const [rotated, current] = await Promise.all([
          readFile(join(issueDir, ROTATED_EVENTS_FILENAME), 'utf-8').catch(() => ''),
          readFile(join(issueDir, EVENTS_FILENAME), 'utf-8').catch(() => ''),
        ]);
        return parseJournal(`${rotated}${current}`);
      }
      return listStoredSessionEvents({
        projectId: session.projectId,
        sessionId,
        ...(options.env === undefined ? {} : { databaseOptions: { env: options.env } }),
      });
    },
    refresh: scan,
    close: () => clearInterval(timer),
  };
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function scanJsonSessions(
  root: string,
  staleAfterMs: number,
): Promise<Map<string, ActiveSession>> {
  const found = new Map<string, ActiveSession>();
  for (const projectId of await directories(join(root, PROJECTS_DIR_NAME))) {
    const issuesDir = join(root, PROJECTS_DIR_NAME, projectId, ISSUES_DIR_NAME);
    for (const issueId of await directories(issuesDir)) {
      const result = await readSessionFile(join(issuesDir, issueId, SESSION_FILENAME));
      if (result === null || Date.now() - result.updatedAtMs > staleAfterMs) continue;
      const sessionId = result.snapshot.sessionId;
      if (sessionId === null) continue;
      found.set(sessionId, {
        projectId,
        issueId,
        snapshot: result.snapshot,
        updatedAtMs: result.updatedAtMs,
      });
    }
  }
  return found;
}

function toSessionMap(stored: StoredSession[]): Map<string, ActiveSession> {
  const sessions = new Map<string, ActiveSession>();
  for (const entry of stored) {
    const snapshot = sessionSnapshotSchema.safeParse(entry.snapshot);
    if (!snapshot.success) continue;
    sessions.set(entry.sessionId, {
      projectId: entry.projectId,
      issueId: entry.issueId,
      snapshot: snapshot.data,
      updatedAtMs: Date.parse(entry.updatedAt),
    });
  }
  return sessions;
}
