import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { attachTerminal, type TerminalAttachment } from '../runtime/terminal/attach.js';
import type { TmuxGateway } from '../runtime/tmux/gateway.js';
import { buildPaneTarget } from '../runtime/tmux/names.js';

/**
 * The terminal transport: a worktree's tmux window, pushed to a browser.
 *
 * Ported from the WebSocket half of WebMux `backend/src/server.ts` @ d8c9d5f
 * (the `sendWs` path and the terminal socket handlers), over `ws` because
 * `node:http` has no WebSocket server of its own.
 *
 * The upstream's protocol is kept exactly — four client messages, four server
 * messages, a one-character prefix on the hot path so no chunk of terminal
 * output costs a `JSON.stringify`. §15 adds two things it does not have, and
 * both are here:
 *
 * 1. **Backpressure.** The upstream never reads `bufferedAmount`. An agent that
 *    prints megabytes then fills the send buffer until the event loop stalls,
 *    and the viewer that caused it is the one that stops responding. Above the
 *    limit, intermediate output is dropped and the client is told how much.
 * 2. **Incremental replay.** The upstream replays its whole 1 MB scrollback on
 *    every reconnect, and a browser reconnects on `visibilitychange`, `focus`
 *    and `online` — switching tabs twice costs two megabytes and two full
 *    repaints. Numbering the bytes lets a returning client ask for the
 *    difference.
 *
 * And one thing the upstream has that is **rejected outright** (ADR-10): no
 * authentication. This is a remote shell. It is served on loopback only, it
 * requires a token in the handshake, and it validates `Origin`.
 */

/** Path the terminal socket lives on. */
export const TERMINAL_WS_PATH = '/ws/terminal';

/**
 * Match the hub socket and its multi-project form.
 *
 * HTTP requests have their project prefix stripped by `router.ts`; an upgrade
 * bypasses that request handler entirely, so the WebSocket transport has to
 * perform the equivalent split itself. `undefined` means another upgrade
 * handler may own the path, `null` is the unprefixed compatibility route, and
 * a string is the project prefix the resolver must authorize.
 */
export function matchTerminalWebSocketPath(pathname: string): string | null | undefined {
  if (pathname === TERMINAL_WS_PATH) return null;
  const match = /^\/([^/]+)\/ws\/terminal$/.exec(pathname);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

/**
 * Send buffer above which output is dropped rather than queued.
 *
 * One megabyte is roughly a second of a very loud agent on a local socket. Past
 * it the client is not keeping up, and queueing more only delays the moment it
 * finds out.
 */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

/** What the client may send. */
export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'sendKeys'; hexBytes: string[] }
  | { type: 'selectPane'; pane: number }
  | { type: 'resize'; cols: number; rows: number; initialPane?: number; lastOffset?: number };

export interface TerminalWebSocketOptions {
  /** The HTTP server to share. Upgrades on other paths are left alone. */
  server: Server;
  /** Host the server is bound to. Anything but loopback disables the surface. */
  host: string;
  /**
   * Resolve which tmux window a connection may view.
   *
   * Returning `null` refuses the connection. It is the only place that decides
   * what a viewer is allowed to see, so it is a dependency rather than a lookup
   * done here.
   */
  resolveTarget: (input: {
    projectPrefix: string | null;
    sessionId: string | null;
    branch: string | null;
  }) => Promise<{
    ownerSessionName: string;
    windowName: string;
    cwd?: string;
    paneTarget?: string;
  } | null>;
  /**
   * The two tmux operations that act on the **owner's** window rather than on
   * this viewer's pty: a key sequence xterm cannot express as bytes, and moving
   * the active pane.
   *
   * A dependency rather than a gateway built here, for the same reason
   * `resolveTarget` is one: this module owns a transport, not a multiplexer.
   * Absent leaves both refused, which is what a monitor with no runtime beside
   * it should do — it has no window to act on.
   */
  tmux?: Pick<TmuxGateway, 'sendHexKeys' | 'selectPane'>;
  /**
   * tmux socket the viewer attaches on. Defaults to the product's own.
   *
   * A seam, not a setting: the integration suite runs its owner session on a
   * throwaway socket, and without this the viewer attached to the *default*
   * one — where the window does not exist — so the suite was measuring the
   * shell's echo of its own input instead of the pane's output.
   */
  socketName?: string;
  /** Credential required in the handshake. Default: a fresh one per server. */
  token?: string;
  /**
   * Called the first time a person types into a run's terminal.
   *
   * This is the whole of the human-takeover mechanism (§32): there is no
   * confirmation, no mode switch and no state machine — somebody touching the
   * keyboard *is* the signal. Absent leaves the behaviour of a monitor that
   * does not know about runs.
   */
  onHumanInput?: (input: {
    projectPrefix: string | null;
    sessionId: string | null;
    branch: string | null;
  }) => void;
  onWarn?: (message: string) => void;
}

export interface TerminalWebSocketHandle {
  /** Credential the dashboard must present. Never persisted. */
  token: string;
  /** Connections currently attached. Diagnostics and tests. */
  connectionCount(): number;
  close(): Promise<void>;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Whether a browser's `Origin` may open this socket.
 *
 * Absent means a non-browser client, which the same-origin policy does not
 * apply to and which had to know the token anyway. Present means a page, and
 * the page must be one this server served — otherwise any site the user visits
 * could open a shell on their machine the moment it guessed the port.
 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined || origin === '') return true;
  const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
  return allowed.includes(origin);
}

/** Parse a client message, returning `null` for anything unrecognised. */
export function parseTerminalClientMessage(raw: string): TerminalClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const message = parsed as Record<string, unknown>;

  switch (message.type) {
    case 'input':
      return typeof message.data === 'string' ? { type: 'input', data: message.data } : null;
    case 'sendKeys':
      return Array.isArray(message.hexBytes) &&
        message.hexBytes.every((entry) => typeof entry === 'string')
        ? { type: 'sendKeys', hexBytes: message.hexBytes as string[] }
        : null;
    case 'selectPane':
      return typeof message.pane === 'number' && Number.isInteger(message.pane)
        ? { type: 'selectPane', pane: message.pane }
        : null;
    case 'resize':
      return typeof message.cols === 'number' &&
        typeof message.rows === 'number' &&
        message.cols > 0 &&
        message.rows > 0
        ? {
            type: 'resize',
            cols: Math.floor(message.cols),
            rows: Math.floor(message.rows),
            ...(typeof message.initialPane === 'number'
              ? { initialPane: Math.floor(message.initialPane) }
              : {}),
            ...(typeof message.lastOffset === 'number'
              ? { lastOffset: Math.floor(message.lastOffset) }
              : {}),
          }
        : null;
    default:
      return null;
  }
}

/**
 * Frame terminal output.
 *
 * `o<offset>\n<data>`: one character and one integer before the payload, so a
 * chunk costs an `indexOf` on the client and no JSON on either side. The offset
 * is the position **after** this chunk, which is exactly what a reconnecting
 * client sends back.
 */
export function frameOutput(offset: number, data: string): string {
  return `o${offset}\n${data}`;
}

/** Frame a replay. Same shape as output, so the client parses one thing. */
export function frameScrollback(offset: number, data: string): string {
  return `s${offset}\n${data}`;
}

export async function startTerminalWebSocket(
  options: TerminalWebSocketOptions,
): Promise<TerminalWebSocketHandle | null> {
  // ADR-10: this is a remote shell. It exists on loopback or it does not exist.
  if (!isLoopbackHost(options.host)) {
    options.onWarn?.(
      'issue-flow: the terminal surface is disabled because the monitor is not bound to loopback.',
    );
    return null;
  }

  const token = options.token ?? randomUUID();
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<WebSocket>();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const projectPrefix = matchTerminalWebSocketPath(url.pathname);
    if (projectPrefix === undefined) return;

    const address = options.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const provided = url.searchParams.get('token');

    if (provided === null || !tokenMatches(provided, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isAllowedOrigin(request.headers.origin, port)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      void handleConnection(ws, url, projectPrefix);
    });
  };

  async function handleConnection(
    ws: WebSocket,
    url: URL,
    projectPrefix: string | null,
  ): Promise<void> {
    connections.add(ws);
    let attachment: TerminalAttachment | null = null;
    let resolved: {
      ownerSessionName: string;
      windowName: string;
      cwd?: string;
      paneTarget?: string;
    } | null = null;

    /**
     * The window and the gateway a tmux operation needs, or `null` after
     * reporting why it cannot run. Refusing with a reason is the point: a
     * silently dropped keystroke reads as a broken terminal.
     */
    const requireTmuxTarget = (
      operation: string,
    ): {
      tmux: NonNullable<TerminalWebSocketOptions['tmux']>;
      ownerSessionName: string;
      windowName: string;
    } | null => {
      if (options.tmux === undefined) {
        sendJson({
          type: 'error',
          message: `'${operation}' needs a tmux runtime beside this monitor.`,
        });
        return null;
      }
      // Narrowing only: reaching this switch means the attach already happened,
      // and the attach is what sets `resolved`. The guard above the switch is
      // what actually refuses anything sent before it.
      if (resolved === null) return null;
      return {
        tmux: options.tmux,
        ownerSessionName: resolved.ownerSessionName,
        windowName: resolved.windowName,
      };
    };
    let droppedBytes = 0;
    // Reported once per connection: the hold is idempotent anyway, and calling
    // out on every keystroke would put a database write on the input path.
    let reportedHumanInput = false;

    const send = (payload: string): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(payload);
    };
    const sendJson = (payload: unknown): void => send(JSON.stringify(payload));

    /**
     * Push one chunk, dropping it when the client is not keeping up.
     *
     * The offset still advances, so a client that reconnects after being
     * dropped asks from where it actually is and gets the difference —
     * dropping output does not desynchronise the numbering.
     */
    const pushOutput = (chunk: string, offset: number): void => {
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        droppedBytes += Buffer.byteLength(chunk, 'utf-8');
        return;
      }
      if (droppedBytes > 0) {
        sendJson({ type: 'truncated', bytes: droppedBytes });
        droppedBytes = 0;
      }
      send(frameOutput(offset, chunk));
    };

    ws.on('message', (raw) => {
      const message = parseTerminalClientMessage(raw.toString());
      if (message === null) {
        sendJson({ type: 'error', message: 'Unrecognised message.' });
        return;
      }

      void (async () => {
        try {
          // Lazy attach: the first `resize` is the attach signal. The client
          // reports its real dimensions before the pty exists, so the first
          // frame is already the right shape and nothing reflows on connect.
          if (attachment === null) {
            if (message.type !== 'resize') {
              sendJson({ type: 'error', message: 'Send a resize before anything else.' });
              return;
            }
            const target = await options.resolveTarget({
              projectPrefix,
              sessionId: url.searchParams.get('session'),
              branch: url.searchParams.get('branch'),
            });
            if (target === null) {
              sendJson({ type: 'error', message: 'No terminal available for that session.' });
              ws.close();
              return;
            }

            resolved = target;
            attachment = await attachTerminal({
              target: { ownerSessionName: target.ownerSessionName, windowName: target.windowName },
              cols: message.cols,
              rows: message.rows,
              ...(options.socketName === undefined ? {} : { socketName: options.socketName }),
              ...(message.initialPane === undefined ? {} : { initialPane: message.initialPane }),
              ...(target.paneTarget === undefined ? {} : { paneTarget: target.paneTarget }),
              ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
            });

            const replay = attachment.scrollback.since(message.lastOffset ?? null);
            if (replay.truncated) sendJson({ type: 'truncated', bytes: -1 });
            send(frameScrollback(replay.offset, replay.data));

            attachment.onData((chunk) => {
              pushOutput(chunk, (attachment as TerminalAttachment).scrollback.offset);
            });
            attachment.onExit((exitCode) => {
              sendJson({ type: 'exit', exitCode });
              ws.close();
            });
            return;
          }

          switch (message.type) {
            case 'input':
              if (!reportedHumanInput) {
                reportedHumanInput = true;
                options.onHumanInput?.({
                  projectPrefix,
                  sessionId: url.searchParams.get('session'),
                  branch: url.searchParams.get('branch'),
                });
              }
              attachment.write(message.data);
              return;
            case 'resize':
              await attachment.resize(message.cols, message.rows);
              return;
            // Both act on the owner's window, not on this viewer's pty: a
            // viewer's `script`/pty is a *reader* of the pane, so writing a key
            // sequence into it would reach nothing. They go through tmux.
            case 'sendKeys': {
              const target = requireTmuxTarget(message.type);
              if (target === null) return;
              await target.tmux.sendHexKeys(
                `${target.ownerSessionName}:${target.windowName}`,
                message.hexBytes,
              );
              return;
            }
            case 'selectPane': {
              const target = requireTmuxTarget(message.type);
              if (target === null) return;
              await target.tmux.selectPane(
                buildPaneTarget(target.ownerSessionName, target.windowName, message.pane),
              );
              return;
            }
          }
        } catch (error) {
          sendJson({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });

    const cleanup = (): void => {
      connections.delete(ws);
      void attachment?.detach();
      attachment = null;
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  options.server.on('upgrade', onUpgrade);

  return {
    token,
    connectionCount: () => connections.size,
    close: async () => {
      options.server.removeListener('upgrade', onUpgrade);
      for (const ws of [...connections]) ws.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
