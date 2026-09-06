import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import chalk from 'chalk';
import { type AgentAvailability, probeAgent } from '../agents/availability.js';
import { isAgentPhase, isAgentProviderId } from '../agents/types.js';
import { writeAgentPreference } from '../commands/agent.js';
import { writeRoutingPreference } from '../commands/routing.js';
import { loadRoutingConfig } from '../config.js';
import type { JournalEntry } from '../core/journal.js';
import { resolvePackageDir } from '../core/prompt-resolver.js';
import {
  NullPublisher,
  type SessionPublisher,
  type SessionSnapshot,
} from '../core/session-state.js';
import { MODEL_CATALOG } from '../routing/models.js';
import { routingConfigInputSchema } from '../schemas.js';
import { readDiagnostics } from '../storage/diagnostics.js';
import { printInfo, printWarning } from '../ui/logger.js';
import { getPackageVersion } from '../version.js';
import {
  type ApiResponse,
  addProject,
  listProjectInits,
  listProjects,
  type ProjectsApiDeps,
  removeProject,
} from './projects-api.js';
import { matchProjectResource, resolveProjectRoute } from './router.js';
import type { SessionDirectoryChange, SessionDirectoryHandle } from './session-directory.js';
import {
  createSessionRoute,
  interruptSessionRoute,
  linkSessionRoute,
  listSessionsRoute,
  matchSessionResource,
  type SessionsApiDeps,
  sendSessionInputRoute,
  stopSessionRoute,
} from './sessions-api.js';
import {
  startTerminalWebSocket,
  type TerminalWebSocketHandle,
  type TerminalWebSocketOptions,
} from './terminal-ws.js';

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

/** Max length of `issueDescription` on GET /api/sessions (dashboard preview). */
export const SESSION_LIST_DESCRIPTION_MAX = 280;

/**
 * Comment frames on an idle `/api/stream` connection, so an intermediary that
 * reaps quiet sockets cannot silently turn the push transport back into the
 * client's polling fallback.
 */
export const STREAM_HEARTBEAT_MS = 15_000;

/**
 * How often the legacy single-publisher backend is checked for a new version.
 *
 * This is the one source that cannot push: `SessionPublisher` exposes a
 * monotonic `version()` and no notification. The read is an in-memory counter
 * comparison, so a tick this short costs nothing and keeps the US-006 fallback
 * inside the same output-to-screen budget as the directory-backed path.
 */
export const PUBLISHER_TICK_MS = 100;

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
  /** Stable identity for this server process. Default: a fresh UUID at startup. */
  instanceId?: string;
  /** Directory holding index.html/app.css/app.js. Default: auto-resolved. */
  publicDir?: string;
  /** Info logger. Default: printInfo. */
  info?: (message: string) => void;
  /** Warning logger. Default: printWarning. */
  warn?: (message: string) => void;
  /** Test seam for the installed-harness catalog returned by /api/config. */
  probeAvailability?: (provider: Parameters<typeof probeAgent>[0]) => Promise<AgentAvailability>;
  /**
   * Whether to `unref()` the underlying socket so it never keeps the process
   * alive on its own. Default `true`, matching the historical contract for a
   * server bound inline in the pipeline process. The standalone `web serve`
   * process (the detached server itself) passes `false`: it has nothing else
   * to do, so staying alive for as long as the server is bound *is* the job.
   */
  unref?: boolean;
  /**
   * The multi-project surface (§47). Absent for a monitor bound inline by the
   * pipeline, which serves exactly the project it is running in: without it
   * `/api/projects` answers an empty list and no URL prefix is ever resolved,
   * so a single-project user sees precisely the behaviour they had before.
   */
  projects?: ProjectsApiDeps;
  /**
   * Serve the terminal transport (`/ws/terminal`).
   *
   * Absent leaves it off entirely. Present is still not enough on its own: the
   * surface is a remote shell, so it only exists when the server is bound to
   * loopback (ADR-10) — the same gate the configuration write routes use.
   */
  terminal?: Pick<TerminalWebSocketOptions, 'resolveTarget' | 'token' | 'onHumanInput' | 'tmux'>;
  /**
   * The agent-session surface (§49): opening an agent with no issue behind it.
   *
   * Absent leaves it off — `GET /api/agent-sessions` then answers an empty list
   * rather than 404, so one dashboard build serves a monitor that has it and
   * one that does not, and every mutating route answers 501.
   */
  agentSessions?: SessionsApiDeps;
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
  /** Identity exposed by health checks and written into web.lock. */
  instanceId: string;
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
  /**
   * Which project a session belongs to, `null` when the backend cannot say.
   *
   * This is what lets one server answer for several projects without a second
   * session store: the sessions were always keyed by project in SQLite, the
   * HTTP surface simply had no way to ask.
   */
  projectOf(sessionId: string): string | null;
  events(sessionId: string): Promise<JournalEntry[] | undefined>;
  /** Persisted agent lifecycle history; `[]` for a backend that keeps none. */
  agentEvents(sessionId: string): Promise<unknown[] | undefined>;
  /**
   * Observe changes, returning an unsubscribe function. This is what makes
   * `/api/stream` a push transport instead of a polling loop wearing a
   * different content type.
   */
  subscribe(listener: (change: SessionSourceChange) => void): () => void;
}

/** Which sessions changed, in the shape both backends can produce. */
interface SessionSourceChange {
  added: string[];
  updated: string[];
  removed: string[];
  revision: number;
}

function publisherSessionSource(publisher: SessionPublisher): SessionSource {
  const listeners = new Set<(change: SessionSourceChange) => void>();
  let timer: NodeJS.Timeout | null = null;
  let lastVersion = publisher.version();
  let lastSessionId = publisher.snapshot().sessionId;
  let revision = 0;

  const tick = (): void => {
    const version = publisher.version();
    const sessionId = publisher.snapshot().sessionId;
    if (version === lastVersion && sessionId === lastSessionId) return;
    revision += 1;
    const change: SessionSourceChange = {
      added: sessionId !== null && sessionId !== lastSessionId ? [sessionId] : [],
      updated: sessionId !== null && sessionId === lastSessionId ? [sessionId] : [],
      removed: lastSessionId !== null && lastSessionId !== sessionId ? [lastSessionId] : [],
      revision,
    };
    lastVersion = version;
    lastSessionId = sessionId;
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        // A subscriber must never be able to take the monitor down.
      }
    }
  };

  return {
    list: () => {
      const snapshot = publisher.snapshot();
      return snapshot.sessionId === null ? [] : [snapshot];
    },
    get: (sessionId) => {
      const snapshot = publisher.snapshot();
      return snapshot.sessionId === sessionId ? snapshot : undefined;
    },
    // The legacy in-process publisher serves exactly the run that owns it, so
    // there is no project to disambiguate.
    projectOf: () => null,
    events: async (sessionId) => (publisher.snapshot().sessionId === sessionId ? [] : undefined),
    agentEvents: async (sessionId) =>
      publisher.snapshot().sessionId === sessionId ? [] : undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      if (timer === null) {
        lastVersion = publisher.version();
        lastSessionId = publisher.snapshot().sessionId;
        timer = setInterval(tick, PUBLISHER_TICK_MS);
        timer.unref();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

function directorySessionSource(handle: SessionDirectoryHandle): SessionSource {
  return {
    list: () => handle.sessions().map((entry) => entry.snapshot),
    get: (sessionId) => handle.getSession(sessionId)?.snapshot,
    projectOf: (sessionId) => handle.getSession(sessionId)?.projectId ?? null,
    events: (sessionId) => handle.events(sessionId),
    agentEvents: (sessionId) => handle.agentEvents(sessionId),
    subscribe: (listener) => handle.subscribe((change: SessionDirectoryChange) => listener(change)),
  };
}

/**
 * Summary fields for the multi-session dashboard (issue #35): the full
 * SessionSnapshot is already in memory, so the client can render cards from
 * this single list without N× /api/status fetches. issueDescription is
 * truncated — cards only need a short preview.
 *
 * `GET /api/sessions` and the `sessions` frame of `/api/stream` share this
 * builder on purpose: two renderings of the same list would drift, and the
 * pushed frame must be interchangeable with the fetched one so the client can
 * fall back to polling without a second code path.
 */
function sessionListPayload(source: SessionSource, projectId?: string | null): unknown[] {
  return source
    .list()
    .filter(
      (snapshot) =>
        projectId === undefined ||
        projectId === null ||
        source.projectOf(snapshot.sessionId ?? '') === projectId,
    )
    .map((snapshot) => ({
      sessionId: snapshot.sessionId,
      // Additive: the dashboard groups the consolidated "Active work" view by
      // project, and a card that cannot name its project cannot be grouped.
      projectId: source.projectOf(snapshot.sessionId ?? ''),
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
      // Resilience fields, for a card that has to answer "is this still moving"
      // during a six-hour run. `updatedAt` is already the last activity; these
      // two say how hard the run has had to work for it.
      retries: snapshot.execution.retries,
      correctionCycle: snapshot.execution.correctionCycle,
      attempt: snapshot.resilience.attempt,
      provider: snapshot.resilience.provider,
      lastFailureKind: snapshot.resilience.lastFailureKind,
      cooldownUntil: snapshot.resilience.cooldownUntil,
      lastActivityAt: snapshot.resilience.lastActivityAt,
      // Reported by the agent's own hooks, never inferred (ADR-05). A card has to
      // be able to distinguish "still thinking" from "blocked on a human",
      // because only one of the two is waiting for the person reading it.
      agentLifecycle: snapshot.agent.lifecycle,
      awaitingInputCount: snapshot.agent.awaitingInputCount,
      // A card has to be able to say "somebody is driving this one": while a
      // run is held the watchdog is paused and no phase advances, so it looks
      // idle and is not (§32).
      humanHold: snapshot.agent.humanHold,
      statusUrl: `/api/status?session=${encodeURIComponent(snapshot.sessionId ?? '')}`,
      eventsUrl: `/api/events?session=${encodeURIComponent(snapshot.sessionId ?? '')}`,
    }));
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
function baseHeaders(res: ServerResponse, instanceId: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Issue-Flow-Instance', instanceId);
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

/** Write what a `projects-api` handler decided, without it knowing about sockets. */
function respondApi(res: ServerResponse, response: ApiResponse): void {
  respondJson(res, response.status, response.body);
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error('Request body too large.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
}

/**
 * Start the monitoring HTTP server. Returns null when the server could not
 * listen (port in use, invalid host, ...) — the pipeline continues without
 * monitoring, it is never brought down by the server.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle | null> {
  const info = options.info ?? printInfo;
  const warn = options.warn ?? printWarning;
  const version = options.version ?? getPackageVersion();
  const instanceId = options.instanceId ?? randomUUID();
  const startedAtMs = Date.now();

  // The UI ships at the package root as web/public/ (sibling of prompts/),
  // resolved the same way from src/ and from the published dist/ layout.
  const assets = await loadStaticAssets(
    options.publicDir ?? resolvePackageDir(join('web', 'public')),
  );

  const source = resolveSessionSource(options);
  let terminal: TerminalWebSocketHandle | null = null;
  const projects = options.projects ?? null;
  const agentSessions = options.agentSessions ?? null;

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

  // -------------------------------------------------------------------
  // Push transport (absorption phase 1). The measured 3–8 s the dashboard used
  // to take to show agent output was two polling hops stacked on top of each
  // other: the server re-read SQLite every 3 s and the browser re-read the
  // server every 5 s. `/api/stream` removes the second hop, and the storage
  // watch in `session-directory.ts` removes the first.
  //
  // Server-Sent Events rather than WebSocket: this channel carries reduced JSON
  // state in one direction only, so it needs no framing, no upgrade handshake
  // and no dependency, and it reconnects on its own. The bidirectional
  // WebSocket the terminal needs is a separate transport with separate
  // requirements (backpressure, replay), and conflating the two would force
  // both to carry the union of their constraints.
  // -------------------------------------------------------------------
  const streams = new Set<ServerResponse>();

  const openStream = (
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string | null,
    projectId: string | null,
  ): void => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    // Defeat proxy-side response buffering, which would batch frames and
    // reintroduce exactly the latency this route exists to remove.
    res.setHeader('X-Accel-Buffering', 'no');
    // Nothing here is compressible enough to be worth a flush boundary per frame.
    res.flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let lastList = '';
    const pushList = (): void => {
      const body = JSON.stringify(sessionListPayload(source, projectId));
      if (body === lastList) return;
      lastList = body;
      if (!res.writableEnded) res.write(`event: sessions\ndata: ${body}\n\n`);
    };

    const pushStatus = (): void => {
      if (sessionId === null) return;
      const snapshot = source.get(sessionId);
      if (snapshot === undefined) {
        send('gone', { sessionId });
        return;
      }
      send('status', snapshot);
    };

    send('hello', {
      instanceId,
      version,
      session: sessionId,
      heartbeatSeconds: Math.round(STREAM_HEARTBEAT_MS / 1000),
    });
    pushList();
    pushStatus();

    const unsubscribe = source.subscribe((change) => {
      pushList();
      if (sessionId === null) return;
      if (
        change.added.includes(sessionId) ||
        change.updated.includes(sessionId) ||
        change.removed.includes(sessionId)
      ) {
        pushStatus();
      }
    });

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, STREAM_HEARTBEAT_MS);
    heartbeat.unref();

    streams.add(res);
    const cleanup = (): void => {
      if (!streams.delete(res)) return;
      clearInterval(heartbeat);
      unsubscribe();
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    req.on('aborted', cleanup);
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    baseHeaders(res, instanceId);

    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    // Prefix resolution happens per request rather than by republishing a
    // route map (`router.ts`): `node:http` has no `Bun.serve().reload()`, and
    // resolving here removes the reload race entirely. An unprefixed path is
    // unchanged, which is what keeps the single-project experience intact.
    const projectRoute = resolveProjectRoute(
      requestUrl.pathname,
      (prefix) => projects?.manager.getByPrefix(prefix) != null,
    );
    const path = projectRoute.path;
    const routedProjectId =
      projectRoute.prefix === null
        ? null
        : (projects?.manager.getByPrefix(projectRoute.prefix)?.entry.id ?? null);

    if (req.method === 'POST' && path === '/api/projects') {
      respondApi(res, await addProject(projects ?? null, await readJsonBody(req)));
      return;
    }

    const projectResource = matchProjectResource(path);
    if (req.method === 'DELETE' && projectResource !== null) {
      respondApi(res, await removeProject(projects ?? null, projectResource));
      return;
    }

    // §49.3's surface. `GET /api/sessions` is deliberately *not* part of it:
    // that path has answered the pipeline-execution list since the
    // multi-session dashboard, and ADR-20 keeps an execution and a session
    // distinct. The listing therefore lives at `/api/agent-sessions`; the
    // verbs, which collide with nothing, answer on both spellings.
    if (req.method === 'GET' && path === '/api/agent-sessions') {
      respondApi(
        res,
        await listSessionsRoute(agentSessions, routedProjectId, {
          freeOnly: requestUrl.searchParams.get('free') === '1',
        }),
      );
      return;
    }

    if (req.method === 'POST' && (path === '/api/sessions' || path === '/api/agent-sessions')) {
      respondApi(
        res,
        await createSessionRoute(agentSessions, routedProjectId, await readJsonBody(req)),
      );
      return;
    }

    const sessionResource = matchSessionResource(path);
    if (sessionResource !== null) {
      const { sessionId, action } = sessionResource;
      if (req.method === 'DELETE' && action === null) {
        respondApi(
          res,
          await stopSessionRoute(agentSessions, routedProjectId, sessionId, {
            removeWorktree: requestUrl.searchParams.get('removeWorktree') === '1',
          }),
        );
        return;
      }
      if (req.method === 'POST' && action === 'input') {
        respondApi(
          res,
          await sendSessionInputRoute(
            agentSessions,
            routedProjectId,
            sessionId,
            await readJsonBody(req),
          ),
        );
        return;
      }
      if (req.method === 'POST' && action === 'interrupt') {
        respondApi(res, await interruptSessionRoute(agentSessions, routedProjectId, sessionId));
        return;
      }
      if (req.method === 'POST' && action === 'link') {
        respondApi(
          res,
          await linkSessionRoute(
            agentSessions,
            routedProjectId,
            sessionId,
            await readJsonBody(req),
          ),
        );
        return;
      }
    }

    if (req.method === 'POST' && path === '/api/config/agent') {
      if (!isLoopbackHost(options.host)) {
        respondJson(res, 403, {
          error: 'Configuration writes are disabled when the monitor is not bound to loopback.',
        });
        return;
      }
      const body = await readJsonBody(req);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        respondJson(res, 400, { error: 'Expected a JSON object.' });
        return;
      }
      const input = body as { provider?: unknown; model?: unknown; phase?: unknown };
      if (typeof input.provider !== 'string' || !isAgentProviderId(input.provider)) {
        respondJson(res, 400, { error: 'Invalid provider.' });
        return;
      }
      if (
        input.phase !== undefined &&
        (typeof input.phase !== 'string' || !isAgentPhase(input.phase))
      ) {
        respondJson(res, 400, { error: 'Invalid phase.' });
        return;
      }
      if (input.model !== undefined && typeof input.model !== 'string') {
        respondJson(res, 400, { error: 'Invalid model.' });
        return;
      }
      const file = await writeAgentPreference({
        target: 'global',
        provider: input.provider,
        ...(input.model ? { model: input.model } : {}),
        ...(input.phase ? { phase: input.phase } : {}),
      });
      respondJson(res, 200, { ok: true, file, appliesTo: 'future executions' });
      return;
    }

    if (req.method === 'POST' && path === '/api/config/routing') {
      if (!isLoopbackHost(options.host)) {
        respondJson(res, 403, {
          error: 'Configuration writes are disabled when the monitor is not bound to loopback.',
        });
        return;
      }
      const body = await readJsonBody(req);
      const parsed = routingConfigInputSchema.safeParse(body);
      if (!parsed.success || Object.keys(parsed.data).length === 0) {
        respondJson(res, 400, {
          error: parsed.success
            ? 'At least one routing setting is required.'
            : (parsed.error.issues[0]?.message ?? 'Invalid routing configuration.'),
        });
        return;
      }
      const file = await writeRoutingPreference({ target: 'global', values: parsed.data });
      respondJson(res, 200, { ok: true, file, appliesTo: 'future executions' });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respondJson(res, 404, { error: 'Not found' });
      return;
    }

    if (path === '/api/projects') {
      respondApi(res, await listProjects(projects ?? null));
      return;
    }

    if (path === '/api/project-inits') {
      respondApi(res, listProjectInits(projects ?? null));
      return;
    }

    if (path === '/api/stream') {
      openStream(req, res, requestUrl.searchParams.get('session'), routedProjectId);
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
      respondJson(res, 200, sessionListPayload(source, routedProjectId));
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

    if (path === '/api/terminal/token') {
      // The credential the dashboard presents on the WebSocket handshake. It is
      // served only where the surface itself exists: on loopback, from a server
      // that actually started the transport. Anywhere else this route does not
      // hand out a secret at all.
      if (terminal === null) {
        respondJson(res, 404, { error: 'The terminal surface is not enabled on this monitor.' });
        return;
      }
      if (!isLoopbackHost(options.host)) {
        respondJson(res, 403, {
          error: 'The terminal surface is disabled when the monitor is not bound to loopback.',
        });
        return;
      }
      respondJson(res, 200, { token: terminal.token, path: '/ws/terminal' });
      return;
    }

    if (path === '/api/agent-events') {
      // The lifecycle history the agent's own hooks reported (ADR-05). It is
      // persisted precisely so a block that happened with nothing watching can
      // still be looked up, which needs a way to read it back.
      const sessionId = requestUrl.searchParams.get('session');
      if (sessionId === null) {
        respondJson(res, 400, { error: 'Pass ?session=<id>.' });
        return;
      }
      const entries = await source.agentEvents(sessionId);
      if (entries === undefined) {
        respondJson(res, 404, { error: `No active session with id '${sessionId}'.` });
        return;
      }
      respondJson(res, 200, entries);
      return;
    }

    if (path === '/api/diagnostics') {
      const sessionId = requestUrl.searchParams.get('session') ?? undefined;
      respondJson(res, 200, await readDiagnostics({ sessionId, limit: 500 }));
      return;
    }

    if (path === '/api/config') {
      const sessionId = requestUrl.searchParams.get('session');
      const snapshot = sessionId === null ? undefined : source.get(sessionId);
      const providers = ['claude', 'codex', 'cursor', 'antigravity', 'opencode'] as const;
      const harnesses = [
        'claude-code',
        'codex-cli',
        'cursor-cli',
        'antigravity-cli',
        'opencode-cli',
      ] as const;
      const probe = options.probeAvailability ?? probeAgent;
      const availability = await Promise.all(providers.map((provider) => probe(provider)));
      respondJson(res, 200, {
        effective: snapshot?.configuration ?? null,
        capturedForSession: snapshot?.sessionId ?? null,
        routing: await loadRoutingConfig(),
        catalog: harnesses.map((harness, index) => {
          const entry = availability[index];
          return {
            harness,
            provider: providers[index],
            installed: entry?.installed ?? false,
            authenticated: entry?.authenticated ?? false,
            authentication: entry?.authentication ?? 'failed',
            state: entry?.state ?? 'unavailable',
            source: entry?.source ?? 'probe',
            observedAt: entry?.observedAt ?? null,
            expiresAt: entry?.expiresAt ?? null,
            detail: entry?.detail ?? null,
            models: MODEL_CATALOG[harness] ?? [],
          };
        }),
        writable: isLoopbackHost(options.host),
        writeScope: 'global preferences for future executions',
      });
      return;
    }

    if (path === '/api/health') {
      respondJson(res, 200, {
        ok: true,
        pid: process.pid,
        instanceId,
        startedAt: new Date(startedAtMs).toISOString(),
        uptime: Math.round((Date.now() - startedAtMs) / 1000),
        version,
        refreshSeconds: options.refreshSeconds ?? 5,
        // `stream:sessions` tells the UI it may stop polling. A monitor without
        // it is an older instance this process reused (web/lock.ts), and the
        // client must keep its interval — the capability list is the only
        // truthful signal, since the served assets may be newer than the server.
        capabilities: [
          ...(isLoopbackHost(options.host) ? ['config:agent:write', 'config:routing:write'] : []),
          'stream:sessions',
          // Advertised only when the transport actually started, so a client
          // never offers a terminal that would refuse its handshake.
          ...(terminal === null ? [] : ['terminal:attach']),
          // Advertised only where a session could actually be opened, so the
          // dashboard never offers a "New session" button that would answer
          // 501 (no project surface) or 403 (not loopback, ADR-10).
          ...(agentSessions?.writable ? ['session:open'] : []),
        ],
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

  if (options.terminal !== undefined) {
    terminal = await startTerminalWebSocket({
      server,
      host: options.host,
      resolveTarget: options.terminal.resolveTarget,
      ...(options.terminal.token === undefined ? {} : { token: options.terminal.token }),
      ...(options.terminal.onHumanInput === undefined
        ? {}
        : { onHumanInput: options.terminal.onHumanInput }),
      ...(options.terminal.tmux === undefined ? {} : { tmux: options.terminal.tmux }),
      onWarn: warn,
    });
  }

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
      // End the event streams explicitly. They are long-lived by construction,
      // so leaving them to closeAllConnections() would drop the sockets without
      // ever running their cleanup, leaking a subscription per viewer.
      for (const stream of [...streams]) {
        try {
          stream.end();
        } catch {
          // Already destroyed — the 'close' handler did the cleanup.
        }
      }
      // Detaches every viewer, which kills their grouped tmux sessions and
      // leaves the project's windows — and the agents in them — untouched.
      void terminal?.close();
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
  const handle: WebServerHandle = { server, host: options.host, port, url, instanceId, close };

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
