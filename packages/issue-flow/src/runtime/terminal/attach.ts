import { randomUUID } from 'node:crypto';
import { quoteShellArgument } from '../../agents/tty.js';
import { run } from '../../utils/shell.js';
import { stripProjectEnv } from '../tmux/env.js';
import { TMUX_SOCKET_NAME } from '../tmux/gateway.js';
import { VIEWER_SESSION_PREFIX } from '../tmux/names.js';
import { type PtyBackend, type PtySession, spawnPty } from './pty.js';
import { Scrollback } from './scrollback.js';

/**
 * Attaching a viewer to a worktree's tmux window.
 *
 * Ported from the attach half of WebMux `backend/src/adapters/terminal.ts`
 * @ d8c9d5f. The central trick is the **grouped session**, and it is what makes
 * several viewers possible at once: each viewer gets a tmux session of its own
 * that *shares the windows* of the project's session. Client, active window and
 * size then belong to the viewer, so one person resizing their browser does not
 * reflow everybody else's terminal.
 *
 * Every line of `buildAttachCommand` is here for a reason the upstream learned:
 * see the comments on it.
 */

/** Kept as part of the terminal API for compatibility with existing callers. */
export { VIEWER_SESSION_PREFIX } from '../tmux/names.js';

/** tmux commands are given a ceiling: a hung one must not hold an attach open. */
export const TMUX_COMMAND_TIMEOUT_MS = 5_000;

export interface TerminalAttachTarget {
  /** Session that owns the windows — the project's. */
  ownerSessionName: string;
  /** Window of the worktree being viewed. */
  windowName: string;
}

export interface AttachOptions {
  target: TerminalAttachTarget;
  cols: number;
  rows: number;
  /** Pane to focus, and on a narrow screen to zoom. */
  initialPane?: number;
  /** Stable tmux pane id (`%N`) preferred over a positional index. */
  paneTarget?: string;
  cwd?: string;
  socketName?: string;
  backend?: PtyBackend;
}

export interface TerminalAttachment {
  readonly id: string;
  readonly viewerSessionName: string;
  readonly backend: PtyBackend;
  readonly scrollback: Scrollback;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): Promise<void>;
  detach(): Promise<void>;
}

function viewerSessionName(): string {
  // Scoped by pid so two servers sharing the socket cannot kill each other's
  // viewers, and by a random suffix so one server's two viewers never collide.
  return `${VIEWER_SESSION_PREFIX}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

/**
 * The shell command a viewer's pty runs.
 *
 * Pure, so the characterization test compares it literally. Every step:
 *
 * - `new-session -t <owner>` creates a session **grouped** with the project's:
 *   same windows, own client and own size.
 * - `window-size latest` on the *owner* makes the window follow the most
 *   recently active client instead of shrinking to the smallest one, which is
 *   what stops a phone from squeezing everyone else's terminal.
 * - `mouse on` and `set-clipboard on` are per-viewer preferences, set on the
 *   grouped session so they do not leak into the project's.
 * - the **unzoom** is defensive and not optional: zoom state is *shared* across
 *   grouped sessions, so a viewer that left a pane zoomed leaves the next one
 *   looking at one pane with no way to know why.
 * - `stty` sets the initial size before the attach, so the first frame is
 *   already the right shape and the terminal does not reflow on connect.
 */
export function buildAttachCommand(input: {
  viewerSessionName: string;
  ownerSessionName: string;
  windowName: string;
  cols: number;
  rows: number;
  initialPane?: number;
  paneTarget?: string;
  socketName?: string;
}): string {
  const tmux = `tmux -L ${quoteShellArgument(input.socketName ?? TMUX_SOCKET_NAME)}`;
  const viewer = quoteShellArgument(input.viewerSessionName);
  const owner = quoteShellArgument(input.ownerSessionName);
  const window = quoteShellArgument(`${input.viewerSessionName}:${input.windowName}`);
  const paneTarget = quoteShellArgument(
    input.paneTarget ?? `${input.viewerSessionName}:${input.windowName}.${input.initialPane ?? 0}`,
  );

  return [
    `${tmux} new-session -d -s ${viewer} -t ${owner}`,
    `${tmux} set-option -t ${owner} window-size latest`,
    `${tmux} set-option -t ${viewer} mouse on`,
    `${tmux} set-option -t ${viewer} set-clipboard on`,
    `${tmux} select-window -t ${window}`,
    `if [ "$(${tmux} display-message -t ${window} -p '#{window_zoomed_flag}')" = "1" ]; then ${tmux} resize-pane -Z -t ${window}; fi`,
    `${tmux} select-pane -t ${paneTarget}`,
    // Only when a pane was named: zooming it is what makes a narrow screen
    // usable, and doing it unasked would hide the other panes on a wide one.
    ...(input.initialPane === undefined ? [] : [`${tmux} resize-pane -Z -t ${paneTarget}`]),
    `stty rows ${input.rows} cols ${input.cols}`,
    `exec ${tmux} attach-session -t ${viewer}`,
  ].join(' && ');
}

async function tmuxCommand(args: string[], socketName: string): Promise<void> {
  await run('tmux', ['-L', socketName, ...args], {
    diagnostics: false,
    timeout: TMUX_COMMAND_TIMEOUT_MS,
    // Same reason as the gateway: a tmux command that births the server must
    // not birth it with a project's secrets in its global environment.
    extendEnv: false,
    env: stripProjectEnv(process.env),
  });
}

/**
 * Remove viewer sessions left behind by a previous run of this process.
 *
 * A grouped session outlives the server that made it — `destroy-unattached` is
 * off — so without this they accumulate on the socket, one per crash.
 */
export async function cleanupStaleViewerSessions(
  socketName: string = TMUX_SOCKET_NAME,
): Promise<string[]> {
  const listed = await run('tmux', ['-L', socketName, 'list-sessions', '-F', '#{session_name}'], {
    diagnostics: false,
    extendEnv: false,
    env: stripProjectEnv(process.env),
  });
  if (listed.exitCode !== 0) return [];

  const mine = `${VIEWER_SESSION_PREFIX}-${process.pid}-`;
  const stale = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name.startsWith(VIEWER_SESSION_PREFIX) && !name.startsWith(mine));
  for (const name of stale) {
    await tmuxCommand(['kill-session', '-t', name], socketName);
  }
  return stale;
}

/**
 * Attach a viewer, returning a handle over its output and input.
 *
 * The scrollback starts empty and fills from the pty: the first thing tmux
 * sends after `attach-session` is a full repaint of the window, so a viewer
 * that connects to a session already running gets its current screen without
 * anything having to replay it.
 */
export async function attachTerminal(options: AttachOptions): Promise<TerminalAttachment> {
  const socketName = options.socketName ?? TMUX_SOCKET_NAME;
  const viewer = viewerSessionName();
  const command = buildAttachCommand({
    viewerSessionName: viewer,
    ownerSessionName: options.target.ownerSessionName,
    windowName: options.target.windowName,
    cols: options.cols,
    rows: options.rows,
    ...(options.initialPane === undefined ? {} : { initialPane: options.initialPane }),
    ...(options.paneTarget === undefined ? {} : { paneTarget: options.paneTarget }),
    socketName,
  });

  const pty: PtySession = await spawnPty({
    command,
    cwd: options.cwd ?? process.cwd(),
    env: { ...stripProjectEnv(process.env), TERM: 'xterm-256color' },
    cols: options.cols,
    rows: options.rows,
    ...(options.backend === undefined ? {} : { backend: options.backend }),
  });

  const scrollback = new Scrollback();
  const dataListeners: Array<(chunk: string) => void> = [];
  const exitListeners: Array<(exitCode: number) => void> = [];
  let detached = false;

  pty.onData((chunk) => {
    scrollback.append(chunk);
    for (const listener of dataListeners) listener(chunk);
  });
  pty.onExit((exitCode) => {
    for (const listener of exitListeners) listener(exitCode);
  });

  return {
    id: viewer,
    viewerSessionName: viewer,
    backend: pty.backend,
    scrollback,
    onData: (listener) => dataListeners.push(listener),
    onExit: (listener) => exitListeners.push(listener),
    write: (data) => pty.write(data),

    /**
     * Resize through **tmux**, not through the pty.
     *
     * The pty here runs a tmux *client*; what has to change size is the window
     * tmux is drawing, and only tmux can do that. On the `node-pty` backend the
     * pty is resized too, so the client's own idea of its size stays correct.
     */
    resize: async (cols, rows) => {
      pty.resize(cols, rows);
      await tmuxCommand(
        ['resize-window', '-t', viewer, '-x', String(cols), '-y', String(rows)],
        socketName,
      );
    },

    detach: async () => {
      if (detached) return;
      detached = true;
      pty.kill();
      // The grouped session is the viewer's alone; killing it leaves the
      // project's windows — and the agent inside them — untouched.
      await tmuxCommand(['kill-session', '-t', viewer], socketName);
    },
  };
}
