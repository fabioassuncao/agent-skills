import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { ITheme } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PORT of `frontend/src/lib/Terminal.test.ts` @ d8c9d5f — 5 cases, plus 4 for
 * the two protocol additions of §15 (offset framing and incremental replay,
 * backpressure's `truncated` marker) and the authenticated handshake (ADR-10).
 *
 * `connect()` is asynchronous here because the token is fetched before the
 * socket opens, so every case waits for the socket rather than assuming it
 * exists synchronously.
 */

const { MockFitAddon, MockTerminal } = vi.hoisted(() => {
  class MockFitAddon {
    static instances: MockFitAddon[] = [];

    fit = vi.fn();

    constructor() {
      MockFitAddon.instances.push(this);
    }
  }

  class MockTerminal {
    static instances: MockTerminal[] = [];

    options: { theme?: unknown } = {};
    cols = 80;
    rows = 24;
    modes = { mouseTrackingMode: 'none' };
    parser = { registerOscHandler: vi.fn(() => true) };
    loadAddon = vi.fn();
    onSelectionChange = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    focus = vi.fn();
    writeln = vi.fn();
    write = vi.fn();
    clearSelection = vi.fn();
    dispose = vi.fn();

    constructor(_options: unknown) {
      MockTerminal.instances.push(this);
    }

    open(container: HTMLElement): void {
      const xterm = document.createElement('div');
      xterm.className = 'xterm';
      const viewport = document.createElement('div');
      viewport.className = 'xterm-viewport';
      xterm.appendChild(viewport);
      container.appendChild(xterm);
    }

    onData(_handler: (data: string) => void): void {}

    getSelection(): string {
      return '';
    }

    hasSelection(): boolean {
      return false;
    }
  }

  return { MockFitAddon, MockTerminal };
});

vi.mock('@xterm/xterm', () => ({ Terminal: MockTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {},
}));
vi.mock('./api', () => ({
  terminalSocketUrl: vi.fn(
    async (target: { sessionId?: string | null; branch?: string | null }) =>
      `ws://localhost/ws/terminal?token=t0ken&session=${target.sessionId ?? ''}`,
  ),
  uploadFiles: vi.fn(),
}));

import { terminalSocketUrl } from './api';
import Terminal, { parseOutputFrame } from './Terminal.svelte';

const DARK_THEME: ITheme = { background: '#171c24', foreground: '#e5e9f0' };
const LIGHT_THEME: ITheme = { background: '#ffffff', foreground: '#1a1f27' };

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean: true }));
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  emitMessage(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  emitClose(code = 1006, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean: false }));
  }
}

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function socketCount(): number {
  return MockWebSocket.instances.length;
}

async function nthSocket(index: number): Promise<MockWebSocket> {
  await waitFor(() => {
    expect(MockWebSocket.instances.length).toBeGreaterThan(index);
  });
  return MockWebSocket.instances[index];
}

describe('Terminal reconnect', () => {
  let documentHidden = false;

  beforeEach(() => {
    MockTerminal.instances = [];
    MockFitAddon.instances = [];
    MockWebSocket.instances = [];
    vi.mocked(terminalSocketUrl).mockClear();

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => documentHidden,
    });

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }) as typeof requestAnimationFrame;
  });

  afterEach(() => {
    cleanup();
    documentHidden = false;
  });

  it('reconnects immediately after a visible-tab socket close', async () => {
    render(Terminal, {
      props: { sessionId: 'session-1', terminalTheme: DARK_THEME },
    });

    const firstSocket = await nthSocket(0);
    firstSocket.emitOpen();

    expect(firstSocket.sent).toContain('{"type":"resize","cols":80,"rows":24}');

    firstSocket.emitClose();

    const secondSocket = await nthSocket(1);
    secondSocket.emitOpen();

    const terminal = MockTerminal.instances[0];
    expect(terminal.writeln).toHaveBeenCalledWith('\r\n\x1b[90m[Desconectado]\x1b[0m');
    expect(terminal.writeln).toHaveBeenCalledWith('\r\n\x1b[32m[Reconectado]\x1b[0m');
  });

  it('only retries once automatically for a visible-tab close', async () => {
    render(Terminal, { props: { sessionId: 'session-2', terminalTheme: DARK_THEME } });

    const firstSocket = await nthSocket(0);
    firstSocket.emitOpen();
    firstSocket.emitClose();

    const secondSocket = await nthSocket(1);
    secondSocket.emitClose();

    // Give a would-be third connection the chance to appear.
    await Promise.resolve();
    expect(socketCount()).toBe(2);
  });

  it('waits for the tab to become visible before reconnecting hidden closes', async () => {
    render(Terminal, { props: { sessionId: 'session-3', terminalTheme: DARK_THEME } });

    const firstSocket = await nthSocket(0);
    firstSocket.emitOpen();

    documentHidden = true;
    firstSocket.emitClose();

    await Promise.resolve();
    expect(socketCount()).toBe(1);

    documentHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));

    await nthSocket(1);
    expect(socketCount()).toBe(2);
  });

  it('applies theme updates to the terminal instance', async () => {
    const rendered = render(Terminal, {
      props: {
        sessionId: 'session-4',
        terminalTheme: DARK_THEME,
      },
    });

    const terminal = MockTerminal.instances[0];
    expect(terminal.options.theme).toBe(DARK_THEME);

    await rendered.rerender({
      sessionId: 'session-4',
      terminalTheme: LIGHT_THEME,
    });

    expect(terminal.options.theme).toBe(LIGHT_THEME);
  });

  it('renders stale terminal refresh controls inside the terminal surface', async () => {
    const onrefreshagentterminal = vi.fn();
    render(Terminal, {
      props: {
        sessionId: 'session-5',
        terminalTheme: DARK_THEME,
        agentTerminalStale: true,
        onrefreshagentterminal,
      },
    });

    expect(screen.getByText('Terminal desatualizado')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Recarregar' }));

    expect(onrefreshagentterminal).toHaveBeenCalledTimes(1);
  });
});

describe('terminal protocol', () => {
  beforeEach(() => {
    MockTerminal.instances = [];
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }) as typeof requestAnimationFrame;
  });

  afterEach(() => cleanup());

  it('parses output and scrollback frames, and rejects anything else', () => {
    expect(parseOutputFrame('o42\nhello')).toEqual({
      kind: 'output',
      offset: 42,
      data: 'hello',
    });
    expect(parseOutputFrame('s7\nreplay\nmore')).toEqual({
      kind: 'scrollback',
      offset: 7,
      data: 'replay\nmore',
    });
    expect(parseOutputFrame('{"type":"exit","exitCode":0}')).toBeNull();
    expect(parseOutputFrame('o-nonsense\nx')).toBeNull();
    expect(parseOutputFrame('o42')).toBeNull();
  });

  it('opens an authenticated socket for the selected session', async () => {
    render(Terminal, { props: { sessionId: 'session-auth', terminalTheme: DARK_THEME } });

    const socket = await nthSocket(0);
    expect(socket.url).toContain('token=t0ken');
    expect(socket.url).toContain('session=session-auth');
  });

  it('asks for the delta on reconnect, using the last offset it received', async () => {
    render(Terminal, { props: { sessionId: 'session-offset', terminalTheme: DARK_THEME } });

    const firstSocket = await nthSocket(0);
    firstSocket.emitOpen();
    firstSocket.emitMessage('s0\n');
    firstSocket.emitMessage('o128\nhello');

    firstSocket.emitClose();

    const secondSocket = await nthSocket(1);
    secondSocket.emitOpen();

    // The first attach asks for everything; the reconnect asks from 128.
    expect(firstSocket.sent[0]).toBe('{"type":"resize","cols":80,"rows":24}');
    expect(JSON.parse(secondSocket.sent[0])).toEqual({
      type: 'resize',
      cols: 80,
      rows: 24,
      lastOffset: 128,
    });
    expect(MockTerminal.instances[0].write).toHaveBeenCalledWith('hello');
  });

  it('tells the viewer when output was dropped or the replay could not reach back', async () => {
    render(Terminal, { props: { sessionId: 'session-truncated', terminalTheme: DARK_THEME } });

    const socket = await nthSocket(0);
    socket.emitOpen();
    socket.emitMessage(JSON.stringify({ type: 'truncated', bytes: 4096 }));
    socket.emitMessage(JSON.stringify({ type: 'truncated', bytes: -1 }));

    const terminal = MockTerminal.instances[0];
    expect(terminal.writeln).toHaveBeenCalledWith(
      expect.stringContaining('4096 bytes descartados'),
    );
    expect(terminal.writeln).toHaveBeenCalledWith(
      expect.stringContaining('o histórico não alcança este ponto'),
    );
  });
});
