import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createTmuxGateway } from '../runtime/tmux/gateway.js';
import {
  startTerminalWebSocket,
  TERMINAL_WS_PATH,
  type TerminalWebSocketHandle,
} from './terminal-ws.js';

/**
 * The terminal transport end to end.
 *
 * **C6**: the first frame a viewer receives is the scrollback, and everything
 * after it is live output. **C9**: reconnecting produces a new attach without
 * killing anything that was running. Plus the two things §15 adds to the
 * upstream — incremental replay and backpressure — and the one thing ADR-10
 * rejects from it: no authentication.
 */
const socketName = `issue-flow-ws-${randomUUID().slice(0, 8)}`;
const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

describe('terminal WebSocket', () => {
  let server: Server;
  let handle: TerminalWebSocketHandle | null;
  let port: number;
  let cwd: string;
  const dirs: string[] = [];
  const sockets: WebSocket[] = [];

  const ownerSessionName = 'if-ws-owner';
  const windowName = 'if-feature';

  /** What the two owner-window operations asked tmux to do. */
  let tmuxCalls: Array<{ op: 'sendHexKeys' | 'selectPane'; target: string; hexBytes?: string[] }>;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'issue-flow-ws-'));
    dirs.push(cwd);
    tmuxCalls = [];

    server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;

    handle = await startTerminalWebSocket({
      server,
      host: '127.0.0.1',
      resolveTarget: async () => ({ ownerSessionName, windowName, cwd }),
      // The owner session lives on this suite's throwaway socket; without this
      // the viewer attached to the product's default one, found no window, and
      // every "live output" assertion was satisfied by the shell echoing the
      // input back rather than by the pane producing anything.
      socketName,
      tmux: {
        sendHexKeys: async (target, hexBytes) => {
          tmuxCalls.push({ op: 'sendHexKeys', target, hexBytes: [...hexBytes] });
        },
        selectPane: async (target) => {
          tmuxCalls.push({ op: 'selectPane', target });
        },
      },
      onWarn: () => {},
    });

    if (tmuxAvailable) {
      const tmux = createTmuxGateway({ socketName });
      await tmux.ensureServer();
      await tmux.ensureSession(ownerSessionName, cwd);
      // An interactive shell: it stays alive (so there is a process a
      // reconnect must not kill) and it answers input (so live output can be
      // provoked on demand rather than raced against the attach).
      await tmux.createWindow({ sessionName: ownerSessionName, windowName, cwd, command: 'sh' });
    }
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await handle?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tmuxAvailable) await execa('tmux', ['-L', socketName, 'kill-server'], { reject: false });
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function connect(query = '', path = TERMINAL_WS_PATH): WebSocket {
    const token = handle?.token ?? '';
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}${query}`,
    );
    sockets.push(socket);
    return socket;
  }

  function collect(socket: WebSocket): string[] {
    const frames: string[] = [];
    socket.on('message', (raw) => frames.push(raw.toString()));
    return frames;
  }

  async function open(socket: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('condition never became true');
  }

  describe('authentication (ADR-10)', () => {
    it('refuses a connection with no token', async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${TERMINAL_WS_PATH}`);
      sockets.push(socket);
      await expect(open(socket)).rejects.toThrow(/401/);
    });

    it('refuses a connection with the wrong token', async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${TERMINAL_WS_PATH}?token=nope`);
      sockets.push(socket);
      await expect(open(socket)).rejects.toThrow(/401/);
    });

    // Without this, any site the user visits could open a shell on their
    // machine the moment it guessed the port.
    it('refuses a browser page this server did not serve', async () => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}${TERMINAL_WS_PATH}?token=${handle?.token}`,
        { origin: 'https://evil.example' },
      );
      sockets.push(socket);
      await expect(open(socket)).rejects.toThrow(/403/);
    });

    it('accepts a page this server served', async () => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}${TERMINAL_WS_PATH}?token=${handle?.token}`,
        { origin: `http://127.0.0.1:${port}` },
      );
      sockets.push(socket);
      await expect(open(socket)).resolves.toBeUndefined();
    });

    it('accepts the project-prefixed path generated by the dashboard', async () => {
      const socket = connect('', '/project-alpha/ws/terminal');
      await expect(open(socket)).resolves.toBeUndefined();
    });

    // The surface exists on loopback or it does not exist.
    it('is not served at all when the monitor is not on loopback', async () => {
      const other = createServer();
      await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
      try {
        await expect(
          startTerminalWebSocket({
            server: other,
            host: '0.0.0.0',
            resolveTarget: async () => null,
            onWarn: () => {},
          }),
        ).resolves.toBeNull();
      } finally {
        await new Promise<void>((resolve) => other.close(() => resolve()));
      }
    });
  });

  // A viewer's pty is a *reader* of the pane: writing a key sequence into it
  // reaches nothing. Both operations act on the owner's window, through tmux.
  describe('the two owner-window operations', () => {
    it.runIf(tmuxAvailable)('sends a key sequence to the window, not to the viewer', async () => {
      const socket = connect();
      const frames = collect(socket);
      await open(socket);
      socket.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
      await waitFor(() => frames.length > 0);

      socket.send(
        JSON.stringify({ type: 'sendKeys', hexBytes: ['1b', '5b', '31', '33', '3b', '32', '75'] }),
      );
      await waitFor(() => tmuxCalls.length > 0);

      expect(tmuxCalls[0]).toEqual({
        op: 'sendHexKeys',
        target: `${ownerSessionName}:${windowName}`,
        hexBytes: ['1b', '5b', '31', '33', '3b', '32', '75'],
      });
    });

    it.runIf(tmuxAvailable)('addresses the pane by index when selecting one', async () => {
      const socket = connect();
      const frames = collect(socket);
      await open(socket);
      socket.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
      await waitFor(() => frames.length > 0);

      socket.send(JSON.stringify({ type: 'selectPane', pane: 1 }));
      await waitFor(() => tmuxCalls.length > 0);

      expect(tmuxCalls[0]).toEqual({
        op: 'selectPane',
        target: `${ownerSessionName}:${windowName}.1`,
      });
    });

    // The attach is what resolves the window, and it is the general guard that
    // refuses anything sent before it — these two are not an exception to it.
    it('refuses before the attach, like every other message', async () => {
      const socket = connect();
      const frames = collect(socket);
      await open(socket);

      socket.send(JSON.stringify({ type: 'selectPane', pane: 1 }));
      await waitFor(() => frames.length > 0);
      expect(frames[0]).toContain('Send a resize before anything else');
      expect(tmuxCalls).toEqual([]);
    });

    // A monitor an inline pipeline run brought up has no runtime beside it, so
    // there is no window to act on. Saying so beats dropping the keystroke.
    it.runIf(tmuxAvailable)('says what is missing when there is no tmux runtime', async () => {
      const bare = createServer((_req, res) => {
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
      const barePort = (bare.address() as AddressInfo).port;
      const bareHandle = await startTerminalWebSocket({
        server: bare,
        host: '127.0.0.1',
        resolveTarget: async () => ({ ownerSessionName, windowName, cwd }),
        // The owner session lives on this suite's throwaway socket; without this
        // the viewer attached to the product's default one, found no window, and
        // every "live output" assertion was satisfied by the shell echoing the
        // input back rather than by the pane producing anything.
        socketName,
        onWarn: () => {},
      });

      const socket = new WebSocket(
        `ws://127.0.0.1:${barePort}${TERMINAL_WS_PATH}?token=${encodeURIComponent(bareHandle.token)}`,
      );
      sockets.push(socket);
      const frames = collect(socket);
      await open(socket);
      socket.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
      await waitFor(() => frames.length > 0);

      socket.send(JSON.stringify({ type: 'sendKeys', hexBytes: ['0d'] }));
      await waitFor(() => frames.some((frame) => frame.includes('needs a tmux runtime')));

      await bareHandle.close();
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    });
  });

  describe('protocol', () => {
    // The upstream's lazy attach: the client reports its real dimensions before
    // the pty exists, so the first frame is already the right shape.
    it('refuses anything before the first resize, which is the attach signal', async () => {
      const socket = connect();
      const frames = collect(socket);
      await open(socket);

      socket.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
      await waitFor(() => frames.length > 0);
      expect(JSON.parse(frames[0] as string)).toMatchObject({ type: 'error' });
    });

    it('reports an unrecognised message instead of ignoring it', async () => {
      const socket = connect();
      const frames = collect(socket);
      await open(socket);

      socket.send('{"type":"exec","command":"rm -rf /"}');
      await waitFor(() => frames.length > 0);
      expect(JSON.parse(frames[0] as string)).toMatchObject({ type: 'error' });
    });
  });

  /**
   * I7 of §50.7 — an agent's output reaches the screen in ≤ 250 ms p95, with no
   * polling anywhere on the path.
   *
   * Phase 8D is what made this measurable: the transport existed since phase 8,
   * but nothing wired it, so the panel's terminal had no window to attach to.
   * The measurement is deliberately of the *whole* live path a viewer depends
   * on — pane output, through the pty reader, out of the socket — and the only
   * step left out is the client's own render, which waits for nobody.
   *
   * There is no interval in this test and none in the transport: a frame
   * arrives because the pane produced one.
   */
  it.runIf(tmuxAvailable)(
    'I7: delivers live output to a connected viewer within 250 ms p95, with no polling',
    async () => {
      const socket = connect();
      const frames: Array<{ at: number; body: string }> = [];
      socket.on('message', (raw) => frames.push({ at: Date.now(), body: raw.toString() }));
      await open(socket);
      socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
      await waitFor(() => frames.some((frame) => frame.body[0] === 's'));

      // Warm-up, not measured: the first echo is what proves the pane is
      // attached and answering. Timing the attach itself would be timing tmux's
      // startup, which is not what a viewer waits for.
      socket.send(JSON.stringify({ type: 'input', data: 'echo IF_WARMUP\r' }));
      await waitFor(() =>
        frames.some((frame) => frame.body[0] === 'o' && frame.body.includes('IF_WARMUP')),
      );

      const samples: number[] = [];
      for (let index = 0; index < 10; index += 1) {
        const marker = `IF_LATENCY_${index}`;
        const before = frames.length;
        const sentAt = Date.now();
        socket.send(JSON.stringify({ type: 'input', data: `echo ${marker}\r` }));
        const seen = (): { at: number } | undefined =>
          frames
            .slice(before)
            .find((frame) => frame.body[0] === 'o' && frame.body.includes(marker));
        await waitFor(() => seen() !== undefined);
        samples.push((seen() as { at: number }).at - sentAt);
      }

      const sorted = [...samples].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      console.log(
        `terminal output→screen: median ${median} ms, p95 ${p95} ms over ${samples.length} samples`,
      );
      expect(p95).toBeLessThanOrEqual(250);
    },
    30000,
  );

  // C6 — first frame is the scrollback, everything after it is live output.
  it.runIf(tmuxAvailable)(
    'C6: sends the scrollback first, then live output',
    async () => {
      const socket = connect();
      const frames = collect(socket);
      await open(socket);
      socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));

      await waitFor(() => frames.some((frame) => frame[0] === 's'));
      // The very first terminal frame is the replay, not live output.
      const first = frames.find((frame) => frame[0] === 's' || frame[0] === 'o') as string;
      expect(first[0]).toBe('s');
      // And it carries an offset the client can send back on reconnect.
      expect(Number.isInteger(Number.parseInt(first.slice(1, first.indexOf('\n')), 10))).toBe(true);

      // Everything after it is live output, framed with `o`.
      socket.send(JSON.stringify({ type: 'input', data: 'echo LIVE_MARKER\r' }));
      await waitFor(() =>
        frames.some((frame) => frame[0] === 'o' && frame.includes('LIVE_MARKER')),
      );
    },
    20_000,
  );

  // C9 — reconnecting is a new attach; nothing that was running dies.
  it.runIf(tmuxAvailable)(
    'C9: reconnecting attaches again without killing the pane',
    async () => {
      const panes = async (): Promise<string> =>
        (
          await execa(
            'tmux',
            [
              '-L',
              socketName,
              'list-panes',
              '-t',
              `${ownerSessionName}:${windowName}`,
              '-F',
              '#{pane_id}',
            ],
            { reject: false },
          )
        ).stdout;
      const before = await panes();

      const first = connect();
      const firstFrames = collect(first);
      await open(first);
      first.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
      await waitFor(() => firstFrames.some((frame) => frame[0] === 's'));
      expect(handle?.connectionCount()).toBe(1);

      first.close();
      await waitFor(() => handle?.connectionCount() === 0);

      const second = connect();
      const secondFrames = collect(second);
      await open(second);
      second.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
      await waitFor(() => secondFrames.some((frame) => frame[0] === 's'));

      // Same pane id: the process that was running never noticed anyone left.
      expect(await panes()).toBe(before);
      expect(before).not.toBe('');
    },
    20_000,
  );

  // The addition §15 requires: a returning client reports how far it got and is
  // answered with a replay rather than being refused.
  it.runIf(tmuxAvailable)(
    'accepts a reported offset on reconnect and answers with a replay',
    async () => {
      const first = connect();
      const firstFrames = collect(first);
      await open(first);
      first.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
      await waitFor(() => firstFrames.some((frame) => frame[0] === 's'));

      const last = firstFrames.at(-1) as string;
      const offset = Number.parseInt(last.slice(1, last.indexOf('\n')), 10);
      first.close();
      await waitFor(() => handle?.connectionCount() === 0);

      const second = connect();
      const secondFrames = collect(second);
      await open(second);
      second.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40, lastOffset: offset }));
      await waitFor(() => secondFrames.some((frame) => frame[0] === 's'));
      // A fresh attach has a scrollback of its own, so the delta itself is
      // exercised in scrollback.test.ts; what matters here is that the offset
      // is part of the protocol and does not break the handshake.
      expect(secondFrames.some((frame) => frame[0] === 's')).toBe(true);
    },
    20_000,
  );

  // §35: reconnecting a terminal, measured at 28 ms + replay upstream.
  it.runIf(tmuxAvailable)(
    'reconnects within the 100 ms budget',
    async () => {
      const samples: number[] = [];
      for (let round = 0; round < 5; round += 1) {
        const socket = connect();
        const frames = collect(socket);
        await open(socket);
        const startedAt = Date.now();
        socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
        await waitFor(() => frames.some((frame) => frame[0] === 's'));
        samples.push(Date.now() - startedAt);
        socket.close();
        await waitFor(() => handle?.connectionCount() === 0);
      }

      const median =
        [...samples].sort((left, right) => left - right)[2] ?? Number.POSITIVE_INFINITY;
      console.log(`terminal reconnect: median ${median} ms over ${samples.length} samples`);
      expect(median).toBeLessThanOrEqual(100);
    },
    30_000,
  );

  it.runIf(tmuxAvailable)('detaches the viewer session when the socket closes', async () => {
    const socket = connect();
    const frames = collect(socket);
    await open(socket);
    socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    await waitFor(() => frames.some((frame) => frame.startsWith('s')));

    socket.close();
    await waitFor(() => handle?.connectionCount() === 0);
    await waitFor(async () => {
      const listed = await execa(
        'tmux',
        ['-L', socketName, 'list-sessions', '-F', '#{session_name}'],
        {
          reject: false,
        },
      );
      return !listed.stdout.includes('if-view');
    });
    const listed = await execa(
      'tmux',
      ['-L', socketName, 'list-sessions', '-F', '#{session_name}'],
      {
        reject: false,
      },
    );
    // The viewer's grouped session is gone; the project's is untouched.
    expect(listed.stdout).not.toContain('if-view');
    expect(listed.stdout).toContain(ownerSessionName);
  });
});
