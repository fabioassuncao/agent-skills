import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import chalk from 'chalk';
import { resolvePackageDir } from '../core/prompt-resolver.js';
import type { SessionPublisher } from '../core/session-state.js';
import { printInfo, printWarning } from '../ui/logger.js';

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

function readPackageVersion(): string {
  try {
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export interface WebServerOptions {
  publisher: SessionPublisher;
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
}

export interface WebServerHandle {
  server: Server;
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

  // JSON serialization memoized by publisher version; the version doubles as
  // the ETag, so an unchanged poll answers 304 with an empty body.
  let cached: { version: number; body: string; etag: string } | null = null;
  const statusPayload = (): { body: string; etag: string } => {
    const v = options.publisher.version();
    if (cached === null || cached.version !== v) {
      cached = { version: v, body: JSON.stringify(options.publisher.snapshot()), etag: `"${v}"` };
    }
    return cached;
  };

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    baseHeaders(res);

    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    // POST /api/control/* is reserved for future write operations (pause,
    // retry, ...); intentionally NOT registered — the v1 surface is
    // read-only (snapshot.readOnly is true and capabilities is empty).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respondJson(res, 404, { error: 'Not found' });
      return;
    }

    if (path === '/api/status' || path === '/status.json') {
      const { body, etag } = statusPayload();
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
      const snapshot = options.publisher.snapshot();
      respondJson(res, 200, [
        {
          sessionId: snapshot.sessionId,
          issueNumber: snapshot.issue.number,
          status: snapshot.status,
          startedAt: snapshot.startedAt,
          updatedAt: snapshot.updatedAt,
          statusUrl: '/api/status',
        },
      ]);
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
    try {
      handleRequest(req, res);
    } catch (err) {
      try {
        respondJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } catch {
        // Response already destroyed — nothing to do, never crash the process.
      }
    }
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

  // Never keep the process alive: the pipeline ending must end the process.
  server.unref();
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

  // Explicit close on SIGINT/SIGTERM, then re-raise so the default
  // termination behavior still applies.
  const onSignal = (signal: NodeJS.Signals): void => {
    void close().finally(() => {
      process.kill(process.pid, signal);
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return { server, host: options.host, port, url, close };
}
