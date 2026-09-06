import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type AgentRuntimeEvent, parseAgentRuntimeEvent } from './contract.js';

/**
 * The endpoint an agent's hooks report to, owned by the process running the
 * agent.
 *
 * WebMux points its hooks at the long-lived project server. Issue Flow cannot:
 * `headless` is the default and must keep working with no monitor, no daemon
 * and no `--web` (ADR-03). Binding the endpoint in the pipeline process itself
 * makes lifecycle events work in a plain `issue-flow execute`, which is exactly
 * what phase 2's completion criterion asks for — `awaiting_input` visible
 * during a headless execute.
 *
 * ADR-10 applies in full even though this is not a browser surface: loopback
 * bind, bearer token, and a token that exists only for the duration of one
 * invocation.
 */

/** Max accepted body. A lifecycle event is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024;

export interface AgentControlServerHandle {
  /** Absolute URL the helper POSTs to. */
  url: string;
  /** Bearer credential for this run. Never persisted. */
  token: string;
  /** Number of events accepted so far. Diagnostics and tests. */
  accepted(): number;
  close(): Promise<void>;
}

export interface AgentControlServerOptions {
  /**
   * Called for every accepted event. It must not throw and must not block: an
   * event handler that fails may never fail the agent turn that produced it.
   */
  onEvent: (event: AgentRuntimeEvent) => void | Promise<void>;
  /** Diagnostics sink. Never printed to the user by default. */
  onWarn?: (message: string) => void;
  /** Test seam. Always loopback in production. */
  host?: string;
  /** Test seam. `0` picks a free port. */
  port?: number;
}

/** Constant-time comparison that tolerates different lengths. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Bind the control endpoint for one invocation.
 *
 * Returns `null` when it cannot bind. Like the monitor, this surface may never
 * bring the pipeline down: without it the run simply proceeds with no lifecycle
 * events, which is the behaviour every release before this one had.
 */
export async function startAgentControlServer(
  options: AgentControlServerOptions,
): Promise<AgentControlServerHandle | null> {
  const host = options.host ?? '127.0.0.1';
  const token = randomUUID();
  let accepted = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }
    const provided = bearerToken(req);
    if (provided === null || !tokenMatches(provided, token)) {
      res.statusCode = 401;
      res.end();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readBody(req)) || '{}');
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    const event = parseAgentRuntimeEvent(parsed);
    if (event === null) {
      res.statusCode = 400;
      res.end();
      return;
    }
    accepted += 1;
    // Answer before handling: the hook is on the agent's hot path and waits for
    // this response, so nothing the pipeline does with the event may be charged
    // to the agent's turn.
    res.statusCode = 204;
    res.end();
    try {
      await options.onEvent(event);
    } catch (error) {
      options.onWarn?.(
        `issue-flow: agent event handler failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        res.statusCode = 500;
        res.end();
      } catch {
        // Response already destroyed — never crash the pipeline process.
      }
    });
  });

  const listening = await new Promise<boolean>((resolve) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      options.onWarn?.(
        `issue-flow: agent control endpoint could not start (${error.message}); continuing without lifecycle events.`,
      );
      resolve(false);
    };
    server.once('error', onError);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener('error', onError);
      resolve(true);
    });
  });
  if (!listening) return null;

  server.unref();
  server.on('error', (error) => {
    options.onWarn?.(`issue-flow: agent control endpoint error: ${error.message}`);
  });

  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}/`,
    token,
    accepted: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
