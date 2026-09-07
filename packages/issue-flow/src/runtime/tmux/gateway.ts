import { run } from '../../utils/shell.js';
import { leakedProjectEnvKeys, stripProjectEnv } from './env.js';
import { detectUtf8Locale, pickTmuxLocale } from './locale.js';
import { parseWindowSummaries, type TmuxWindowSummary, VIEWER_SESSION_PREFIX } from './names.js';

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
export const PANE_OWNER_OPTION = '@issue-flow-owner';

export interface TmuxPaneIdentity {
  paneId: string;
  sessionName: string;
  windowName: string;
  ownerToken: string | null;
}

interface PaneOwnerTag {
  ownerSessionName: string;
  ownerToken: string;
}

function encodePaneOwnerTag(ownerSessionName: string, ownerToken: string): string {
  return Buffer.from(JSON.stringify({ v: 1, ownerSessionName, ownerToken }), 'utf8').toString(
    'base64url',
  );
}

function decodePaneOwnerTag(value: string): PaneOwnerTag | null {
  if (value === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return parsed.v === 1 &&
      typeof parsed.ownerSessionName === 'string' &&
      parsed.ownerSessionName !== '' &&
      typeof parsed.ownerToken === 'string' &&
      parsed.ownerToken !== ''
      ? { ownerSessionName: parsed.ownerSessionName, ownerToken: parsed.ownerToken }
      : null;
  } catch {
    return null;
  }
}

export interface TmuxGateway {
  /** Whether tmux is installed at all. */
  isAvailable(): Promise<boolean>;
  ensureServer(): Promise<void>;
  ensureSession(sessionName: string, cwd: string): Promise<void>;
  hasWindow(sessionName: string, windowName: string): Promise<boolean>;
  /** Query window presence, throwing when tmux cannot answer authoritatively. */
  hasWindowStrict?(sessionName: string, windowName: string): Promise<boolean>;
  killWindow(sessionName: string, windowName: string): Promise<void>;
  /**
   * Kill a window and prove it is absent. Unlike `killWindow`, an inability to
   * query tmux is an error rather than an "already gone" best effort.
   */
  killWindowStrict?(sessionName: string, windowName: string): Promise<void>;
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
  /** Resolve which window currently contains a pane id. */
  getPaneWindow?(target: string): Promise<string>;
  /** Resolve the full owner tuple; pane ids alone are reused after server restart. */
  getPaneIdentity?(target: string): Promise<TmuxPaneIdentity>;
  /** Bind the project owner session and durable AgentSession nonce to one pane. */
  tagPaneOwner?(target: string, ownerToken: string, ownerSessionName: string): Promise<void>;
  /** Query pane presence authoritatively. */
  hasPaneStrict?(target: string): Promise<boolean>;
  /** Create an off-screen pane for an inactive agent tab. */
  createParkedPane?(options: {
    sessionName: string;
    parkingWindow: string;
    cwd: string;
    command: string;
  }): Promise<string>;
  /** Exchange two live panes without restarting either process. */
  swapPanes?(source: string, destination: string): Promise<void>;
  /** Move a pane into a window when the prior visible pane no longer exists. */
  movePaneToWindow?(source: string, destinationWindow: string): Promise<void>;
  countPanes(sessionName: string, windowName: string): Promise<number>;
  killPane(target: string): Promise<void>;
  /** Kill only this pane and prove it is gone. */
  killPaneStrict?(target: string): Promise<void>;
  /** Every pane id on the dedicated socket, in one call. */
  listPaneIds?(): Promise<string[]>;
  /** Pane ownership inventory in one call, for active-tab reconciliation. */
  listPaneLocations?(): Promise<TmuxPaneIdentity[]>;
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

  // `run()` intentionally normalizes ENOENT to an exit result. Probe the
  // executable itself so aggregate inventory can distinguish "tmux is not
  // installed" (known empty) from "the installed server failed to answer"
  // (unknown, and therefore an error for reconciliation).
  async function executableIsMissing(): Promise<boolean> {
    return (await tmux(['-V'])).exitCode !== 0;
  }

  async function hasWindowStrict(sessionName: string, windowName: string): Promise<boolean> {
    const checked = await tmux(['list-windows', '-t', sessionName, '-F', '#{window_name}']);
    if (checked.exitCode !== 0) {
      if (isIgnorableKillError(checked.stderr)) return false;
      throw new Error(
        `query tmux window ${sessionName}:${windowName} failed: ${checked.stderr || `exit ${checked.exitCode}`}`,
      );
    }
    return checked.stdout.split('\n').some((line) => line.trim() === windowName);
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

    hasWindowStrict,

    killWindow: async (sessionName, windowName) => {
      const result = await tmux(['kill-window', '-t', `${sessionName}:${windowName}`]);
      if (result.exitCode !== 0 && !isIgnorableKillError(result.stderr)) {
        throw new Error(`kill tmux window ${sessionName}:${windowName} failed: ${result.stderr}`);
      }
    },

    killWindowStrict: async (sessionName, windowName) => {
      const target = `${sessionName}:${windowName}`;
      const killed = await tmux(['kill-window', '-t', target]);
      if (killed.exitCode !== 0 && !isIgnorableKillError(killed.stderr)) {
        throw new Error(`kill tmux window ${target} failed: ${killed.stderr}`);
      }
      let present: boolean;
      try {
        present = await hasWindowStrict(sessionName, windowName);
      } catch (error) {
        throw new Error(
          `confirm tmux window ${target} stopped failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (present) {
        throw new Error(`tmux window ${target} is still running`);
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
      if (result.exitCode !== 0) {
        if (isIgnorableKillError(result.stderr)) return [];
        if (await executableIsMissing()) return [];
        throw new Error(`list tmux windows failed: ${result.stderr || `exit ${result.exitCode}`}`);
      }
      return parseWindowSummaries(result.stdout);
    },

    getPaneId: (target) =>
      assertOk(['display-message', '-p', '-t', target, '#{pane_id}'], `resolve pane id ${target}`),

    getPaneWindow: (target) =>
      assertOk(
        ['display-message', '-p', '-t', target, '#{window_name}'],
        `resolve pane window ${target}`,
      ),

    getPaneIdentity: async (target) => {
      const value = await assertOk(
        [
          'display-message',
          '-p',
          '-t',
          target,
          `#{pane_id}\t#{session_name}\t#{window_name}\t#{${PANE_OWNER_OPTION}}`,
        ],
        `resolve pane identity ${target}`,
      );
      const [paneId, reportedSessionName, windowName, encodedOwner = ''] = value.split('\t');
      if (!paneId || !reportedSessionName || !windowName) {
        throw new Error(`resolve pane identity ${target} returned an invalid tuple`);
      }
      const owner = decodePaneOwnerTag(encodedOwner);
      return {
        paneId,
        sessionName: owner?.ownerSessionName ?? reportedSessionName,
        windowName,
        ownerToken: owner?.ownerToken ?? (encodedOwner || null),
      };
    },

    tagPaneOwner: async (target, ownerToken, ownerSessionName) => {
      await assertOk(
        [
          'set-option',
          '-p',
          '-t',
          target,
          PANE_OWNER_OPTION,
          encodePaneOwnerTag(ownerSessionName, ownerToken),
        ],
        `tag tmux pane ${target}`,
      );
    },

    hasPaneStrict: async (target) => {
      const result = await tmux(['display-message', '-p', '-t', target, '#{pane_id}']);
      if (result.exitCode === 0) return result.stdout.trim() !== '';
      if (
        result.stderr.includes("can't find pane") ||
        result.stderr.includes("can't find window") ||
        result.stderr.includes("can't find session") ||
        isIgnorableKillError(result.stderr)
      ) {
        return false;
      }
      throw new Error(
        `query tmux pane ${target} failed: ${result.stderr || `exit ${result.exitCode}`}`,
      );
    },

    createParkedPane: async ({ sessionName, parkingWindow, cwd, command }) => {
      const exists = await hasWindowStrict(sessionName, parkingWindow);
      const args = exists
        ? [
            'split-window',
            '-d',
            '-P',
            '-F',
            '#{pane_id}',
            '-t',
            `${sessionName}:${parkingWindow}`,
            '-c',
            cwd,
            command,
          ]
        : [
            'new-window',
            '-d',
            '-P',
            '-F',
            '#{pane_id}',
            '-t',
            sessionName,
            '-n',
            parkingWindow,
            '-c',
            cwd,
            command,
          ];
      return await assertOk(args, `create parked pane in ${sessionName}:${parkingWindow}`);
    },

    swapPanes: async (source, destination) => {
      await assertOk(
        ['swap-pane', '-d', '-s', source, '-t', destination],
        `swap tmux panes ${source} and ${destination}`,
      );
    },

    movePaneToWindow: async (source, destinationWindow) => {
      await assertOk(
        ['join-pane', '-d', '-s', source, '-t', destinationWindow],
        `move tmux pane ${source} to ${destinationWindow}`,
      );
    },

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

    killPaneStrict: async (target) => {
      const killed = await tmux(['kill-pane', '-t', target]);
      if (
        killed.exitCode !== 0 &&
        !killed.stderr.includes("can't find pane") &&
        !isIgnorableKillError(killed.stderr)
      ) {
        throw new Error(`kill tmux pane ${target} failed: ${killed.stderr}`);
      }
      const result = await tmux(['display-message', '-p', '-t', target, '#{pane_id}']);
      if (result.exitCode === 0 && result.stdout.trim() !== '') {
        throw new Error(`tmux pane ${target} is still running`);
      }
      if (
        result.exitCode !== 0 &&
        !result.stderr.includes("can't find pane") &&
        !result.stderr.includes("can't find window") &&
        !result.stderr.includes("can't find session") &&
        !isIgnorableKillError(result.stderr)
      ) {
        throw new Error(
          `confirm tmux pane ${target} stopped failed: ${result.stderr || `exit ${result.exitCode}`}`,
        );
      }
    },

    listPaneIds: async () => {
      const result = await tmux(['list-panes', '-a', '-F', '#{pane_id}']);
      if (result.exitCode !== 0) {
        if (isIgnorableKillError(result.stderr)) return [];
        if (await executableIsMissing()) return [];
        throw new Error(`list tmux panes failed: ${result.stderr || `exit ${result.exitCode}`}`);
      }
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    },

    listPaneLocations: async () => {
      const result = await tmux([
        'list-panes',
        '-a',
        '-F',
        `#{pane_id}\t#{session_name}\t#{window_name}\t#{${PANE_OWNER_OPTION}}`,
      ]);
      if (result.exitCode !== 0) {
        if (isIgnorableKillError(result.stderr)) return [];
        if (await executableIsMissing()) return [];
        throw new Error(
          `list tmux pane locations failed: ${result.stderr || `exit ${result.exitCode}`}`,
        );
      }
      const identities = new Map<string, TmuxPaneIdentity>();
      for (const line of result.stdout.split('\n')) {
        const [paneId, reportedSessionName, windowName, encodedOwner = ''] = line
          .trim()
          .split('\t');
        if (!paneId || !reportedSessionName || !windowName) continue;
        const owner = decodePaneOwnerTag(encodedOwner);
        if (owner === null && reportedSessionName.startsWith(`${VIEWER_SESSION_PREFIX}-`)) continue;
        const identity = {
          paneId,
          sessionName: owner?.ownerSessionName ?? reportedSessionName,
          windowName,
          ownerToken: owner?.ownerToken ?? (encodedOwner || null),
        };
        const existing = identities.get(paneId);
        if (existing === undefined || owner !== null) identities.set(paneId, identity);
      }
      return [...identities.values()];
    },
  };
}
