import { type FSWatcher, watch } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type JournalEntry, parseJournal } from '../core/journal.js';
import { sessionSnapshotSchema, type ValidatedSessionSnapshot } from '../schemas.js';
import { DATABASE_FILENAME } from '../storage/db/index.js';
import {
  listAgentEvents,
  listStoredSessionEvents,
  listStoredSessions,
  type StoredAgentEvent,
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
import { createProjectRegistry, type ProjectRegistry } from '../storage/projects/registry.js';
import { readSessionFile } from '../storage/session-file.js';

/**
 * How often the monitor re-reads indexed session state **when nothing pushed**.
 *
 * Since the push transport landed this is a safety net, not the delivery path:
 * a write to the SQLite tree wakes the watcher below in milliseconds, and this
 * interval only covers the cases a filesystem watch cannot see (the `json`
 * compatibility driver, a platform where `fs.watch` silently stops firing, a
 * database that did not exist yet when the monitor started).
 */
export const DEFAULT_POLL_INTERVAL_MS = 3000;

/**
 * Coalescing window for filesystem notifications.
 *
 * A single SQLite commit touches the WAL and, on checkpoint, the database file
 * too, so one logical write can produce several events. Waiting this long
 * before scanning collapses them into one query while staying two orders of
 * magnitude below the 250 ms output-to-screen budget.
 */
export const WATCH_DEBOUNCE_MS = 20;

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

/**
 * What changed between two scans. Session ids only: the subscriber already has
 * a handle and reads whatever depth it needs, and shipping snapshots through
 * the notification would duplicate the source of truth.
 */
export interface SessionDirectoryChange {
  /** Sessions that were not active in the previous scan. */
  added: string[];
  /** Sessions whose snapshot content changed. */
  updated: string[];
  /** Sessions that are no longer active. */
  removed: string[];
  /** Monotonic counter, bumped once per emitted change. */
  revision: number;
}

export interface SessionDirectoryOptions extends GetGlobalRootOptions {
  pollIntervalMs?: number;
  /** Coalescing window for filesystem notifications. Default {@link WATCH_DEBOUNCE_MS}. */
  watchDebounceMs?: number;
  /**
   * Whether to watch the storage tree for writes. Default `true`. Tests that
   * drive `refresh()` by hand turn it off so no stray notification races them.
   */
  watch?: boolean;
  staleAfterMs?: number;
  onWarn?: (message: string) => void;
  storageDriver?: 'sqlite' | 'json';
  /**
   * The registry that says which projects exist (§47.5).
   *
   * Discovering projects by walking the storage tree could only ever find the
   * ones that had already executed; the registry knows the curated ones too.
   * The walk survives as the reconciliation fallback — a project whose row is
   * missing, or a database that cannot be opened, must not make its sessions
   * invisible. Injected so tests can drive it without a database.
   */
  registry?: ProjectRegistry;
}

export interface SessionDirectoryHandle {
  sessions(): ActiveSession[];
  getSession(sessionId: string): ActiveSession | undefined;
  events(sessionId: string): Promise<JournalEntry[] | undefined>;
  /**
   * Lifecycle history reported by the agent's own hooks, oldest first. Empty
   * for the `json` compatibility driver, which has no such table.
   */
  agentEvents(sessionId: string): Promise<StoredAgentEvent[] | undefined>;
  refresh(): Promise<void>;
  /**
   * Observe changes. Returns an unsubscribe function. Listeners are called
   * synchronously after the scan that produced the change and must not throw —
   * one that does is isolated, because a subscriber may never take the monitor
   * down.
   */
  subscribe(listener: (change: SessionDirectoryChange) => void): () => void;
  /** Current revision, bumped once per emitted change. */
  revision(): number;
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
  const watchDebounceMs = options.watchDebounceMs ?? WATCH_DEBOUNCE_MS;
  const registry =
    options.registry ??
    createProjectRegistry({
      databaseOptions: options.env === undefined ? {} : { env: options.env },
    });
  let sessions = new Map<string, ActiveSession>();
  let warned = false;
  let closed = false;
  let revision = 0;
  /** Serialized snapshot per session id, so a scan can tell a heartbeat from a real change. */
  let fingerprints = new Map<string, string>();
  const listeners = new Set<(change: SessionDirectoryChange) => void>();

  function emit(next: Map<string, ActiveSession>): void {
    const nextFingerprints = new Map<string, string>();
    const added: string[] = [];
    const updated: string[] = [];
    for (const [sessionId, session] of next) {
      const fingerprint = JSON.stringify(session.snapshot);
      nextFingerprints.set(sessionId, fingerprint);
      const previous = fingerprints.get(sessionId);
      if (previous === undefined) added.push(sessionId);
      else if (previous !== fingerprint) updated.push(sessionId);
    }
    const removed = [...fingerprints.keys()].filter(
      (sessionId) => !nextFingerprints.has(sessionId),
    );
    sessions = next;
    fingerprints = nextFingerprints;
    if (added.length === 0 && updated.length === 0 && removed.length === 0) return;
    revision += 1;
    const change: SessionDirectoryChange = { added, updated, removed, revision };
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        // A subscriber must never be able to take the monitor down.
      }
    }
  }

  /**
   * Which projects the registry knows, or `null` when it knows none.
   *
   * `null` rather than `[]` on purpose: an empty registry is indistinguishable
   * from an unreadable one, and treating either as "no projects" would hide
   * every running session. The caller falls back to walking the tree.
   */
  async function knownProjectIds(): Promise<string[] | null> {
    const known = await registry.list();
    return known.length === 0 ? null : known.map((project) => project.id);
  }

  async function scan(): Promise<void> {
    try {
      if (storageDriver === 'json') {
        emit(await scanJsonSessions(root, staleAfterMs, await knownProjectIds()));
        return;
      }
      const since = new Date(Date.now() - staleAfterMs).toISOString();
      const stored = await listStoredSessions({
        activeSince: since,
        ...(options.env === undefined ? {} : { databaseOptions: { env: options.env } }),
      });
      emit(toSessionMap(stored));
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

  // ---------------------------------------------------------------------
  // Push path. The pipeline process writes the snapshot and its ordered event
  // in one SQLite transaction; the monitor is usually a *different*, detached
  // process, so the cheapest cross-process notification available is the write
  // itself. Watching the storage root (not the database file) is deliberate:
  // a WAL checkpoint deletes and recreates `issue-flow.db-wal`, and a watch
  // bound to that inode would stop firing exactly once, silently. Directory
  // watches survive it, and `fs.watch` on a single non-recursive directory is
  // the one mode every supported platform implements.
  // ---------------------------------------------------------------------
  let watcher: FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;

  function onStorageWrite(filename: string | null): void {
    // Everything SQLite touches shares the database basename: `issue-flow.db`,
    // `-wal` and `-shm`. Anything else in the root (config.json, web.lock,
    // diagnostics) cannot change session state and must not wake a query.
    if (filename !== null && !filename.startsWith(DATABASE_FILENAME)) return;
    if (debounce !== null) return;
    debounce = setTimeout(() => {
      debounce = null;
      void scan();
    }, watchDebounceMs);
    debounce.unref();
  }

  function ensureWatcher(): void {
    if (closed || watcher !== null || options.watch === false) return;
    if (storageDriver !== 'sqlite') return;
    try {
      watcher = watch(root, { persistent: false }, (_event, filename) => {
        onStorageWrite(typeof filename === 'string' ? filename : null);
      });
      // A watcher that dies (the root was removed and recreated, the platform
      // gave up) must not silently downgrade the monitor to poll-only for the
      // rest of its life: drop it and let the next tick re-establish one.
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      // The storage root does not exist yet. The interval below retries.
      watcher = null;
    }
  }

  ensureWatcher();
  void scan();
  const timer = setInterval(() => {
    ensureWatcher();
    void scan();
  }, pollIntervalMs);
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
    agentEvents: async (sessionId) => {
      const session = sessions.get(sessionId);
      if (session === undefined) return undefined;
      if (storageDriver === 'json') return [];
      return listAgentEvents({
        projectId: session.projectId,
        runId: sessionId,
        ...(options.env === undefined ? {} : { databaseOptions: { env: options.env } }),
      });
    },
    refresh: scan,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => revision,
    close: () => {
      closed = true;
      clearInterval(timer);
      if (debounce !== null) clearTimeout(debounce);
      debounce = null;
      watcher?.close();
      watcher = null;
      listeners.clear();
    },
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

/**
 * Read `session.json` for the `json` compatibility driver.
 *
 * `projectIds` comes from the registry — that is the §47.5 change: the project
 * list is curated, not derived from whichever directories happen to exist.
 * When the registry has nothing to say (empty, or unreadable) the directory
 * walk takes over, so a session can never become invisible because a row is
 * missing. Directories the registry names but that do not exist read as empty
 * and are skipped, which is the same tolerance `directories()` already had.
 */
async function scanJsonSessions(
  root: string,
  staleAfterMs: number,
  projectIds: string[] | null,
): Promise<Map<string, ActiveSession>> {
  const found = new Map<string, ActiveSession>();
  const projects = projectIds ?? (await directories(join(root, PROJECTS_DIR_NAME)));
  for (const projectId of projects) {
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
