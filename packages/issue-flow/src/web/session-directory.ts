import type { JournalEntry } from '../core/journal.js';
import { sessionSnapshotSchema, type ValidatedSessionSnapshot } from '../schemas.js';
import {
  listStoredSessionEvents,
  listStoredSessions,
  type StoredSession,
} from '../storage/db/repository.js';
import type { GetGlobalRootOptions } from '../storage/paths.js';

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
  let sessions = new Map<string, ActiveSession>();
  let warned = false;

  async function scan(): Promise<void> {
    try {
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
