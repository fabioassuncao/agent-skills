import { run } from '../../utils/shell.js';
import { leakedProjectEnvKeys, stripProjectEnv } from './env.js';
import { detectUtf8Locale, pickTmuxLocale } from './locale.js';
import { parseWindowSummaries, type TmuxWindowSummary } from './names.js';

/**
 * Every tmux command this project runs.
 *
 * Ported from `BunTmuxGateway` in WebMux `backend/src/adapters/tmux.ts`
 * @ d8c9d5f, with the same surface and three deliberate changes:
 *
 * 1. **`execa` through `run()`** instead of `Bun.spawnSync`, and asynchronous
 *    throughout. `run()` is this project's only shell path, and `extendEnv:
 *    false` is mandatory: `execa` merges `process.env` by default, while the
 *    upstream depends on the environment being *replaced* — which is the whole
 *    point of `stripProjectEnv`.
 * 2. **A dedicated socket, `-L issue-flow`** (ADR-09). The tmux server this
 *    project talks to is never the user's own, so a session created here cannot
 *    inherit — or pollute — the environment of the user's personal tmux. It
 *    removes structurally the class of bug the upstream cures reactively.
 * 3. **`scrubLeakedGlobalEnv` stays** as the safety net. A dedicated socket does
 *    not help a server this project itself started with a polluted environment,
 *    which is exactly what an older release could have left behind.
 */

/** Socket the project's tmux server listens on. Never the user's default one. */
export const TMUX_SOCKET_NAME = 'issue-flow';

export type PaneSplit = 'right' | 'bottom';

export interface TmuxGateway {
  /** Whether tmux is installed at all. */
  isAvailable(): Promise<boolean>;
  ensureServer(): Promise<void>;
  ensureSession(sessionName: string, cwd: string): Promise<void>;
  hasWindow(sessionName: string, windowName: string): Promise<boolean>;
  killWindow(sessionName: string, windowName: string): Promise<void>;
  createWindow(options: {
    sessionName: string;
    windowName: string;
    cwd: string;
    command?: string;
  }): Promise<void>;
  splitWindow(options: {
    target: string;
    split: PaneSplit;
    sizePct?: number;
    cwd: string;
    command?: string;
  }): Promise<void>;
  setWindowOption(
    sessionName: string,
    windowName: string,
    option: string,
    value: string,
  ): Promise<void>;
  /** Type a command into a pane and submit it. */
  runCommand(target: string, command: string): Promise<void>;
  /** Type text into a pane literally, without submitting it. */
  sendLiteral(target: string, text: string): Promise<void>;
  /** Send tmux key names (`Enter`, `C-c`) rather than literal text. */
  sendKeys(target: string, keys: string[]): Promise<void>;
  /** Send raw bytes as hex, for keys with no tmux name (CSI u sequences). */
  sendHexKeys(target: string, hexBytes: string[]): Promise<void>;
  /** Load text into a named tmux buffer, through stdin. */
  loadBuffer(bufferName: string, content: string): Promise<void>;
  /** Paste a named buffer into a pane. */
  pasteBuffer(options: {
    bufferName: string;
    target: string;
    /** `-r` — paste raw, without translating newlines into Enter. */
    raw?: boolean;
    /** `-p` — bracketed paste, so the TUI knows this is a paste and not typing. */
    bracketed?: boolean;
    /** `-d` — delete the buffer after pasting. */
    deleteAfter?: boolean;
  }): Promise<void>;
  /** Whether a named buffer still exists. Diagnostics and tests. */
  hasBuffer(bufferName: string): Promise<boolean>;
  selectPane(target: string): Promise<void>;
  /** Every window of every session, in **one** call (ADR-13). */
  listWindows(): Promise<TmuxWindowSummary[]>;
  /** Resolve the tmux pane id (`%N`) currently occupying a target. */
  getPaneId(target: string): Promise<string>;
  countPanes(sessionName: string, windowName: string): Promise<number>;
  killPane(target: string): Promise<void>;
}

export interface TmuxGatewayOptions {
  /** Socket name. Overridable so a test never touches the real project socket. */
  socketName?: string;
  /** Base environment. Defaults to `process.env`, stripped of project keys. */
  env?: Record<string, string | undefined>;
}

export interface TmuxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Errors from `kill-window` that mean "it is already gone".
 *
 * Ported verbatim, including the fourth: a socket path that no longer exists
 * reports a connection error rather than a tmux-level one, and treating that as
 * a failure would make every teardown after a server exit throw.
 */
function isIgnorableKillError(stderr: string): boolean {
  return (
    stderr.includes("can't find window") ||
    stderr.includes("can't find session") ||
    stderr.includes('no server running') ||
    (stderr.includes('error connecting to') && stderr.includes('No such file or directory'))
  );
}

export function createTmuxGateway(options: TmuxGatewayOptions = {}): TmuxGateway {
  const socketName = options.socketName ?? TMUX_SOCKET_NAME;
  let cachedEnv: Record<string, string> | null = null;
  let globalEnvScrubbed = false;

  function baseEnv(): Record<string, string> {
    cachedEnv ??= stripProjectEnv(options.env ?? process.env);
    return cachedEnv;
  }

  async function tmux(args: string[], stdin?: string): Promise<TmuxResult> {
    const base = baseEnv();
    const result = await run('tmux', ['-L', socketName, ...args], {
      ...(stdin === undefined ? {} : { input: stdin }),
      // `extendEnv: false` is load-bearing: the point of `stripProjectEnv` is a
      // *replaced* environment, and execa would otherwise merge process.env
      // back in and undo it.
      extendEnv: false,
      env: { ...base, LC_ALL: pickTmuxLocale(base, await detectUtf8Locale()) },
      diagnostics: false,
    });
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.exitCode,
    };
  }

  async function assertOk(args: string[], action: string): Promise<string> {
    const result = await tmux(args);
    if (result.exitCode !== 0) {
      throw new Error(
        `${action} failed: ${result.stderr || `tmux ${args.join(' ')} exit ${result.exitCode}`}`,
      );
    }
    return result.stdout;
  }

  /**
   * Clean a server that was already running with a project's `.env` in its
   * global environment.
   *
   * Unsetting those keys globally cleans every pane created afterwards, in
   * existing and new sessions alike. Runs at most once per process: after the
   * global environment is clean, stripped-env spawns keep it that way, and
   * re-scrubbing on every session-ensure would cost one tmux spawn per leaked
   * key on a path that runs constantly.
   */
  async function scrubLeakedGlobalEnv(): Promise<void> {
    if (globalEnvScrubbed) return;
    globalEnvScrubbed = true;
    for (const key of leakedProjectEnvKeys(options.env ?? process.env)) {
      await tmux(['set-environment', '-gu', key]);
    }
  }

  return {
    isAvailable: async () => (await tmux(['-V'])).exitCode === 0,

    ensureServer: async () => {
      await assertOk(['start-server'], 'tmux start-server');
    },

    /**
     * Create the project's session, or adopt the one that is already there.
     *
     * Creation and `destroy-unattached off` travel in **one** tmux invocation,
     * separated by `;`. That is the upstream's shape and it is load-bearing
     * here for a different reason: §35 budgets 30 ms for an additional session,
     * and every extra invocation is a process spawn that costs about half of
     * it. `has-session` is not asked first for the same reason — tmux already
     * answers "duplicate session", and paying a spawn to find out beforehand
     * doubles the cost of the common case.
     *
     * `destroy-unattached off` is what lets an agent keep working with the
     * browser closed: without it tmux tears the session down the moment the
     * last client detaches. It is re-applied when adopting an existing session,
     * so one created by something else still gets it.
     */
    ensureSession: async (sessionName, cwd) => {
      const created = await tmux([
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-c',
        cwd,
        ';',
        'set-option',
        '-t',
        sessionName,
        'destroy-unattached',
        'off',
      ]);
      if (created.exitCode !== 0) {
        if (!created.stderr.includes('duplicate session')) {
          throw new Error(`create tmux session ${sessionName} failed: ${created.stderr}`);
        }
        await assertOk(
          ['set-option', '-t', sessionName, 'destroy-unattached', 'off'],
          `set destroy-unattached off for ${sessionName}`,
        );
      }
      await scrubLeakedGlobalEnv();
    },

    hasWindow: async (sessionName, windowName) => {
      const result = await tmux(['list-windows', '-t', sessionName, '-F', '#{window_name}']);
      if (result.exitCode !== 0) return false;
      return result.stdout.split('\n').some((line) => line.trim() === windowName);
    },

    killWindow: async (sessionName, windowName) => {
      const result = await tmux(['kill-window', '-t', `${sessionName}:${windowName}`]);
      if (result.exitCode !== 0 && !isIgnorableKillError(result.stderr)) {
        throw new Error(`kill tmux window ${sessionName}:${windowName} failed: ${result.stderr}`);
      }
    },

    createWindow: async ({ sessionName, windowName, cwd, command }) => {
      const args = ['new-window', '-d', '-t', sessionName, '-n', windowName, '-c', cwd];
      if (command) args.push(command);
      await assertOk(args, `create tmux window ${sessionName}:${windowName}`);
    },

    splitWindow: async ({ target, split, sizePct, cwd, command }) => {
      const args = ['split-window', '-t', target, split === 'right' ? '-h' : '-v', '-c', cwd];
      if (sizePct !== undefined) args.push('-l', `${sizePct}%`);
      if (command) args.push(command);
      await assertOk(args, `split tmux window at ${target}`);
    },

    setWindowOption: async (sessionName, windowName, option, value) => {
      await assertOk(
        ['set-window-option', '-t', `${sessionName}:${windowName}`, option, value],
        `set tmux option ${option} on ${sessionName}:${windowName}`,
      );
    },

    // Two calls, not one: `-l` types the text literally (so a command
    // containing tmux key names is not interpreted), and the newline has to be
    // sent separately as `C-m` for the same reason.
    runCommand: async (target, command) => {
      await assertOk(['send-keys', '-t', target, '-l', '--', command], `send command to ${target}`);
      await assertOk(['send-keys', '-t', target, 'C-m'], `submit command on ${target}`);
    },

    sendLiteral: async (target, text) => {
      await assertOk(['send-keys', '-t', target, '-l', '--', text], `send text to ${target}`);
    },

    sendKeys: async (target, keys) => {
      await assertOk(['send-keys', '-t', target, ...keys], `send keys to ${target}`);
    },

    // `-H` takes hex bytes, which is the only way to deliver a key tmux has no
    // name for — the CSI u encodings a modern TUI expects, for instance.
    sendHexKeys: async (target, hexBytes) => {
      await assertOk(['send-keys', '-t', target, '-H', ...hexBytes], `send bytes to ${target}`);
    },

    // The text travels on stdin rather than in the argv: a prompt can be tens
    // of kilobytes, well past what a command line accepts.
    loadBuffer: async (bufferName, content) => {
      const result = await tmux(['load-buffer', '-b', bufferName, '-'], content);
      if (result.exitCode !== 0) {
        throw new Error(`load tmux buffer ${bufferName} failed: ${result.stderr}`);
      }
    },

    pasteBuffer: async ({ bufferName, target, raw, bracketed, deleteAfter }) => {
      const args = ['paste-buffer'];
      if (raw !== false) args.push('-r');
      if (bracketed !== false) args.push('-p');
      args.push('-b', bufferName, '-t', target);
      if (deleteAfter !== false) args.push('-d');
      await assertOk(args, `paste tmux buffer ${bufferName} into ${target}`);
    },

    hasBuffer: async (bufferName) => {
      const result = await tmux(['show-buffer', '-b', bufferName]);
      return result.exitCode === 0;
    },

    selectPane: async (target) => {
      await assertOk(['select-pane', '-t', target], `select tmux pane ${target}`);
    },

    // One aggregated call for every window of every session (ADR-13). Asking
    // per entity is what makes reconciliation O(N) instead of O(1).
    listWindows: async () => {
      const result = await tmux([
        'list-windows',
        '-a',
        '-F',
        '#{session_name}\t#{window_name}\t#{window_panes}',
      ]);
      // No server running is not an error: it means no windows, which is a
      // perfectly ordinary answer and the one reconciliation needs.
      if (result.exitCode !== 0) return [];
      return parseWindowSummaries(result.stdout);
    },

    getPaneId: (target) =>
      assertOk(['display-message', '-p', '-t', target, '#{pane_id}'], `resolve pane id ${target}`),

    countPanes: async (sessionName, windowName) => {
      const result = await tmux([
        'list-panes',
        '-t',
        `${sessionName}:${windowName}`,
        '-F',
        '#{pane_id}',
      ]);
      if (result.exitCode !== 0) return 0;
      return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
    },

    killPane: async (target) => {
      const result = await tmux(['kill-pane', '-t', target]);
      if (
        result.exitCode !== 0 &&
        !result.stderr.includes("can't find pane") &&
        !isIgnorableKillError(result.stderr)
      ) {
        throw new Error(`kill tmux pane ${target} failed: ${result.stderr}`);
      }
    },
  };
}
