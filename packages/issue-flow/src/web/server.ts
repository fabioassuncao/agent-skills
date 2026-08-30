import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import chalk from 'chalk';
import type { JournalEntry } from '../core/journal.js';
import { resolvePackageDir } from '../core/prompt-resolver.js';
import {
  NullPublisher,
  type SessionPublisher,
  type SessionSnapshot,
} from '../core/session-state.js';
import { printInfo, printWarning } from '../ui/logger.js';
import type { SessionDirectoryHandle } from './session-directory.js';

/**
 * HTTP server for the web monitoring mode. Plain node:http — no new runtime
 * dependencies. Serves the publisher's in-memory snapshot (it never re-reads
 * issues/N/session.json) and the static UI assets.
 *
 * Resilience contract: nothing here may ever affect the pipeline. Listen
 * failures (EADDRINUSE included) log a warning and the execution continues
 * without a server; the server is unref()'d so it cannot keep the process
 * alive; request handling is wrapped so a handler error answers 500 instead
 * of crashing the process.
 */

const require = createRequire(import.meta.url);

/** Max length of `issueDescription` on GET /api/sessions (dashboard preview). */
export const SESSION_LIST_DESCRIPTION_MAX = 280;

function readPackageVersion(): string {
  try {
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/** Collapse whitespace and truncate for the sessions list payload. */
export function truncateSessionDescription(
  text: string | null | undefined,
  max = SESSION_LIST_DESCRIPTION_MAX,
): string | null {
  if (text === null || text === undefined) return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return normalized;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

export interface WebServerOptions {
  /**
   * Legacy single-session mode (pre-US-003, still used by the US-006
   * fallback): serves this publisher's in-memory snapshot directly, with no
   * directory scan and no lock file involved. Mutually exclusive with
   * `sessions` — when both are given, `sessions` wins.
   */
  publisher?: SessionPublisher;
  /**
   * Multi-session mode: sessions discovered by polling the global storage
   * tree (`web/session-directory.ts`). This is what every current entry
   * point (`web serve`) passes; `publisher` only exists for the legacy path.
   */
  sessions?: SessionDirectoryHandle;
  port: number;
  host: string;
  /** Suggested UI polling interval, exposed via /api/health. */
  refreshSeconds?: number;
  /** Package version reported by /api/health. Default: read from package.json. */
  version?: string;
  /** Directory holding index.html/app.css/app.js. Default: auto-resolved. */
  publicDir?: string;
  /** Info logger. Default: printInfo. */
  info?: (message: string) => void;
  /** Warning logger. Default: printWarning. */
  warn?: (message: string) => void;
  /**
   * Whether to `unref()` the underlying socket so it never keeps the process
   * alive on its own. Default `true`, matching the historical contract for a
   * server bound inline in the pipeline process. The standalone `web serve`
   * process (the detached server itself) passes `false`: it has nothing else
   * to do, so staying alive for as long as the server is bound *is* the job.
   */
  unref?: boolean;
}

export interface WebServerHandle {
  /**
   * Absent when this handle represents an existing instance reused through
   * `ensureSingleWebServer` (`web/lock.ts`) instead of one bound locally.
   */
  server?: Server;
  /** Host the server is bound to. */
  host: string;
  /** Actual bound port (relevant when options.port is 0). */
  port: number;
  /** Human-facing access URL. */
  url: string;
  /** Close the server and release signal handlers. Idempotent, never rejects. */
  close(): Promise<void>;
}

interface StaticAsset {
  body: string;
  contentType: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * Uniform view over "whatever sessions this server knows about", so the route
 * handlers below never care whether they are backed by a single in-memory
 * publisher (legacy mode) or by the global directory scan (US-003/US-004).
 */
interface SessionSource {
  /** Every session currently considered active, in no particular order. */
  list(): SessionSnapshot[];
  /** A specific session by id, or undefined when it is not currently active. */
  get(sessionId: string): SessionSnapshot | undefined;
  events(sessionId: string): Promise<JournalEntry[] | undefined>;
}

function publisherSessionSource(publisher: SessionPublisher): SessionSource {
  return {
    list: () => {
      const snapshot = publisher.snapshot();
      return snapshot.sessionId === null ? [] : [snapshot];
    },
    get: (sessionId) => {
      const snapshot = publisher.snapshot();
      return snapshot.sessionId === sessionId ? snapshot : undefined;
    },
    events: async (sessionId) => (publisher.snapshot().sessionId === sessionId ? [] : undefined),
  };
}

function directorySessionSource(handle: SessionDirectoryHandle): SessionSource {
  return {
    list: () => handle.sessions().map((entry) => entry.snapshot),
    get: (sessionId) => handle.getSession(sessionId)?.snapshot,
    events: (sessionId) => handle.events(sessionId),
  };
}

function resolveSessionSource(options: WebServerOptions): SessionSource {
  if (options.sessions) return directorySessionSource(options.sessions);
  return publisherSessionSource(options.publisher ?? new NullPublisher());
}

const STATIC_ROUTES: Record<string, { file: string; contentType: string }> = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/app.css': { file: 'app.css', contentType: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
};

/** Assets are read once at startup; missing files simply 404. */
async function loadStaticAssets(publicDir: string | null): Promise<Map<string, StaticAsset>> {
  const assets = new Map<string, StaticAsset>();
  if (publicDir === null) return assets;
  for (const [route, { file, contentType }] of Object.entries(STATIC_ROUTES)) {
    try {
      const body = await readFile(join(publicDir, file), 'utf-8');
      assets.set(route, { body, contentType });
    } catch {
      // Asset not present (e.g. UI not built yet) — route answers 404.
    }
  }
  return assets;
}

/** Headers applied to every response, including 304s and errors. */
function baseHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

function respond(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.end(body);
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  respond(res, status, JSON_TYPE, JSON.stringify(payload));
}

/**
 * Start the monitoring HTTP server. Returns null when the server could not
 * listen (port in use, invalid host, ...) — the pipeline continues without
 * monitoring, it is never brought down by the server.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle | null> {
  const info = options.info ?? printInfo;
  const warn = options.warn ?? printWarning;
  const version = options.version ?? readPackageVersion();
  const startedAtMs = Date.now();

  // The UI ships at the package root as web/public/ (sibling of prompts/),
  // resolved the same way from src/ and from the published dist/ layout.
  const assets = await loadStaticAssets(
    options.publicDir ?? resolvePackageDir(join('web', 'public')),
  );

  const source = resolveSessionSource(options);

  // JSON serialization memoized per session id: an unchanged poll answers 304
  // with an empty body. Content-hashed rather than counter-based, unlike the
  // pre-multi-session version — a directory-backed session has no in-process
  // publisher to hand out a monotonic version(), and a hash works uniformly
  // for both sources.
  const statusCache = new Map<string, { body: string; etag: string }>();
  const statusPayload = (snapshot: SessionSnapshot): { body: string; etag: string } => {
    const key = snapshot.sessionId ?? '';
    const body = JSON.stringify(snapshot);
    const cached = statusCache.get(key);
    if (cached !== undefined && cached.body === body) return cached;
    const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
    const entry = { body, etag };
    statusCache.set(key, entry);
    return entry;
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    baseHeaders(res);

    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    const path = requestUrl.pathname;

    // POST /api/control/* is reserved for future write operations (pause,
    // retry, ...); intentionally NOT registered — the v1 surface is
    // read-only (snapshot.readOnly is true and capabilities is empty).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respondJson(res, 404, { error: 'Not found' });
      return;
    }

    if (path === '/api/status' || path === '/status.json') {
      const sessionId = requestUrl.searchParams.get('session');
      let snapshot: SessionSnapshot | undefined;
      if (sessionId !== null) {
        snapshot = source.get(sessionId);
        if (snapshot === undefined) {
          respondJson(res, 404, { error: `No active session with id '${sessionId}'.` });
          return;
        }
      } else {
        // Back-compat shorthand (US-005): with exactly one active session,
        // GET /api/status with no query string still answers it directly, the
        // same behavior a single-session run always had. Zero or several
        // active sessions is genuinely ambiguous without an id and answers an
        // explicit error instead of guessing.
        const active = source.list();
        if (active.length === 0) {
          respondJson(res, 404, {
            error: 'No active session. Pass ?session=<id> — see GET /api/sessions.',
          });
          return;
        }
        if (active.length > 1) {
          respondJson(res, 409, {
            error: 'Multiple active sessions; specify ?session=<id>.',
            sessions: active.map((entry) => entry.sessionId),
          });
          return;
        }
        snapshot = active[0];
      }

      const { body, etag } = statusPayload(snapshot);
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      respond(res, 200, JSON_TYPE, body);
      return;
    }

    if (path === '/api/sessions') {
      // Summary fields for the multi-session dashboard (issue #35): the full
      // SessionSnapshot is already in memory, so the client can render cards
      // from this single list without N× /api/status fetches per poll.
      // issueDescription is truncated — cards only need a short preview.
      respondJson(
        res,
        200,
        source.list().map((snapshot) => ({
          sessionId: snapshot.sessionId,
          issueNumber: snapshot.issue.number,
          issueTitle: snapshot.issue.title,
          issueDescription: truncateSessionDescription(snapshot.issue.description),
          repositoryName: snapshot.repository.name,
          currentPhase: snapshot.currentPhase,
          progressPercent: snapshot.progress.percent,
          elapsedSeconds: snapshot.elapsedSeconds,
          status: snapshot.status,
          startedAt: snapshot.startedAt,
          updatedAt: snapshot.updatedAt,
          // Resilience fields, for a card that has to answer "is this still
          // moving" during a six-hour run. `updatedAt` is already the last
          // activity; these two say how hard the run has had to work for it.
          retries: snapshot.execution.retries,
          correctionCycle: snapshot.execution.correctionCycle,
          attempt: snapshot.resilience.attempt,
          provider: snapshot.resilience.provider,
          lastFailureKind: snapshot.resilience.lastFailureKind,
          cooldownUntil: snapshot.resilience.cooldownUntil,
          lastActivityAt: snapshot.resilience.lastActivityAt,
          statusUrl: `/api/status?session=${encodeURIComponent(snapshot.sessionId ?? '')}`,
          eventsUrl: `/api/events?session=${encodeURIComponent(snapshot.sessionId ?? '')}`,
        })),
      );
      return;
    }

    if (path === '/api/events') {
      const sessionId = requestUrl.searchParams.get('session');
      if (sessionId === null) {
        respondJson(res, 400, { error: 'Pass ?session=<id>.' });
        return;
      }
      const entries = await source.events(sessionId);
      if (entries === undefined) {
        respondJson(res, 404, { error: `No active session with id '${sessionId}'.` });
        return;
      }
      respondJson(res, 200, entries);
      return;
    }

    if (path === '/api/health') {
      respondJson(res, 200, {
        ok: true,
        uptime: Math.round((Date.now() - startedAtMs) / 1000),
        version,
        refreshSeconds: options.refreshSeconds ?? 5,
      });
      return;
    }

    const asset = assets.get(path);
    if (asset) {
      respond(res, 200, asset.contentType, asset.body);
      return;
    }

    respondJson(res, 404, { error: 'Not found' });
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      try {
        respondJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } catch {
        // Response already destroyed — nothing to do, never crash the process.
      }
    });
  });

  const listening = await new Promise<boolean>((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE') {
        warn(
          `Web monitor port ${options.port} is already in use. Continuing without the web server.`,
        );
      } else {
        warn(`Web monitor failed to start (${err.message}). Continuing without the web server.`);
      }
      resolve(false);
    };
    server.once('error', onError);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', onError);
      resolve(true);
    });
  });

  if (!listening) return null;

  // Never keep the process alive on its own, unless explicitly told not to
  // unref: the pipeline ending must end the process. The one exception is the
  // detached `web serve` process (options.unref === false) — it has no other
  // work, so staying alive for as long as the server is bound is the point.
  if (options.unref !== false) {
    server.unref();
  }
  // Post-listen errors must never become uncaught exceptions.
  server.on('error', (err) => {
    warn(`Web monitor server error: ${err.message}`);
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const displayHost = options.host === '0.0.0.0' ? 'localhost' : options.host;
  const url = `http://${displayHost}:${port}`;

  if (options.host === '0.0.0.0') {
    warn('Web monitor bound to 0.0.0.0: anyone on your local network can view the session state.');
  }
  info(`Web monitor running at ${chalk.bold.cyan(url)}`);

  let closed = false;
  let closePromise: Promise<void> | null = null;

  const doClose = (): Promise<void> =>
    new Promise<void>((resolve) => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      server.close(() => resolve());
      // Drop idle keep-alive connections so close() never hangs.
      server.closeAllConnections();
    });

  const close = (): Promise<void> => {
    if (closed) return closePromise ?? Promise.resolve();
    closed = true;
    closePromise = doClose();
    return closePromise;
  };

  // `handle.close` is built here, but ensureSingleWebServer/ensureWebMonitor
  // and the `web serve` command each wrap it afterwards (to also remove the
  // lock file, stop the session-directory poller, ...). onSignal below calls
  // `handle.close()` — the *current* value of the property — rather than the
  // `close` closed over here, so a `kill -TERM <pid>` (including `issue-flow
  // web stop`) always runs the fully wrapped shutdown, not just this raw
  // socket close. Capturing `close` directly here was a real bug: the wrapped
  // behavior only ever ran for an *explicit* `handle.close()` call, leaving
  // the lock file (and the poller) behind on every signal-driven shutdown.
  const handle: WebServerHandle = { server, host: options.host, port, url, close };

  // Explicit close on SIGINT/SIGTERM, then re-raise so the default
  // termination behavior still applies.
  const onSignal = (signal: NodeJS.Signals): void => {
    void handle.close().finally(() => {
      process.kill(process.pid, signal);
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return handle;
}
