<script module lang="ts">
  export interface TerminalOutputFrame {
    kind: 'output' | 'scrollback';
    offset: number;
    data: string;
  }

  /**
   * Split `o<offset>\n<data>` (or `s<offset>\n<data>`) into its parts.
   *
   * Returns `null` for anything that is not an output frame, so the caller falls
   * through to the JSON control messages without a second parse. A one-character
   * prefix and an integer are all a chunk of terminal output costs on the hot
   * path — no `JSON.parse` on either side.
   *
   * Lives in the module block so it is testable without mounting a terminal,
   * which needs a canvas the test environment does not have.
   */
  export function parseOutputFrame(raw: string): TerminalOutputFrame | null {
    const prefix = raw[0];
    if (prefix !== 'o' && prefix !== 's') return null;
    const newline = raw.indexOf('\n');
    if (newline === -1) return null;
    const digits = raw.slice(1, newline);
    if (!/^\d+$/.test(digits)) return null;
    return {
      kind: prefix === 'o' ? 'output' : 'scrollback',
      offset: Number.parseInt(digits, 10),
      data: raw.slice(newline + 1),
    };
  }
</script>

<script lang="ts">
  import '@xterm/xterm/css/xterm.css';
  import { FitAddon } from '@xterm/addon-fit';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import { Terminal } from '@xterm/xterm';
  import type { ITheme } from '@xterm/xterm';
  import { onDestroy, onMount } from 'svelte';
  import { terminalSocketUrl, uploadFiles } from './api';

  /**
   * The agent's terminal, in the browser.
   *
   * ADAPT of `frontend/src/lib/Terminal.svelte` @ d8c9d5f (489 lines). Every
   * behaviour of the original is here — xterm + fit + web links, reconnect on
   * `visibilitychange`/`focus`/`online`, OSC 52 clipboard, auto-copy on
   * selection, Shift+Enter as CSI u, the app shortcuts that must bubble past
   * xterm, image paste and drop, and the manual touch scroll for mobile. What
   * changed is the transport, and it changed in four ways, all of them required
   * by `src/web/terminal-ws.ts`:
   *
   * 1. **The socket is authenticated** (ADR-10). The URL carries a token from
   *    `GET /api/terminal/token`, which only exists on a loopback binding. The
   *    upstream has no authentication at all and binds `0.0.0.0`; that is the
   *    one part of WebMux this absorption rejects outright.
   * 2. **The key is the session, not the branch.** A worktree can hold more
   *    than one live agent (§48.3), so `sessionId` addresses the window.
   * 3. **Frames carry an offset.** `o<offset>\n<data>` and `s<offset>\n<data>`
   *    — the upstream strips one character; here the payload starts after the
   *    first newline and the number before it is remembered.
   * 4. **Reconnects ask for the delta.** `lastOffset` rides on the attach
   *    `resize`, so returning to a tab replays what was missed instead of the
   *    whole 1 MB ring. A browser reconnects on `visibilitychange`, `focus` and
   *    `online`; switching tabs twice used to cost two megabytes and two full
   *    repaints.
   *
   * The first message on the socket **must** be a `resize`: the server treats it
   * as the attach signal, and sending the client's real dimensions before the
   * pty exists is what makes the first frame already the right shape.
   */

  let {
    sessionId = null,
    branch = null,
    isMobile = false,
    initialPane,
    terminalTheme,
    agentTerminalStale = false,
    refreshingAgentTerminal = false,
    onrefreshagentterminal,
  }: {
    sessionId?: string | null;
    branch?: string | null;
    isMobile?: boolean;
    initialPane?: number;
    terminalTheme: ITheme;
    agentTerminalStale?: boolean;
    refreshingAgentTerminal?: boolean;
    onrefreshagentterminal?: () => void;
  } = $props();

  const DISCONNECTED_NOTICE = '\r\n\x1b[90m[Desconectado]\x1b[0m';
  const RECONNECTED_NOTICE = '\r\n\x1b[32m[Reconectado]\x1b[0m';
  let containerEl: HTMLDivElement;
  let term!: Terminal;
  let termReady = false;
  let fitAddon: FitAddon;
  let ws: WebSocket | null = null;
  let resizeObs: ResizeObserver;
  let resizeTimer: ReturnType<typeof setTimeout>;
  let xtermEl: HTMLElement | null = null;
  let viewportEl: HTMLElement | null = null;
  let manualTouchCleanup: (() => void) | null = null;
  let lastTouchX = 0;
  let lastTouchY = 0;
  let touchScrollLocked = false;
  let destroyed = false;
  let canRetryVisibleClose = true;
  let isDraggingOver = $state(false);
  let dragCounter = 0;

  /**
   * Bytes already delivered on this attachment.
   *
   * `null` means "nothing yet, send me the scrollback"; a number means "I am at
   * this position, send me the difference". It survives a reconnect on purpose
   * — that is the whole point of it — and is only reset when the component is
   * rebuilt for a different session.
   */
  let lastOffset: number | null = null;

  function copyToClipboard(text: string): void {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return;
    }
    // Fallback for non-secure contexts (HTTP on a host that is not localhost).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }

  export function sendSelectPane(pane: number): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'selectPane', pane }));
    }
  }

  export function sendInput(data: string): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  }

  function handleTouchGestureEnd(): void {
    touchScrollLocked = false;
  }

  function shouldUseManualTouchScroll(): boolean {
    return isMobile && !!viewportEl && term.modes.mouseTrackingMode !== 'none';
  }

  function handleManualTouchStart(event: TouchEvent): void {
    if (!shouldUseManualTouchScroll()) return;
    const touch = event.touches[0];
    if (!touch) return;
    lastTouchX = touch.pageX;
    lastTouchY = touch.pageY;
    touchScrollLocked = false;
  }

  function handleManualTouchMove(event: TouchEvent): void {
    const touch = event.touches[0];
    if (!shouldUseManualTouchScroll() || !viewportEl || !touch) return;

    const deltaX = lastTouchX - touch.pageX;
    const deltaY = lastTouchY - touch.pageY;
    lastTouchX = touch.pageX;
    lastTouchY = touch.pageY;

    if (!touchScrollLocked) {
      if (Math.abs(deltaY) <= Math.abs(deltaX)) return;
      touchScrollLocked = true;
    }
    if (deltaY === 0) return;

    const canScrollViewport = viewportEl.scrollHeight > viewportEl.clientHeight;
    if (!canScrollViewport) {
      dispatchSyntheticWheel(deltaY, touch);
      event.preventDefault();
      return;
    }

    viewportEl.scrollTop += deltaY;
    // Keep the swipe owned by the terminal so the app shell never steals it at
    // the top/bottom edge.
    event.preventDefault();
  }

  function dispatchSyntheticWheel(deltaY: number, touch: Touch): void {
    if (!xtermEl) return;

    const wheelEvent = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: touch.clientX,
      clientY: touch.clientY,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY,
    });
    xtermEl.dispatchEvent(wheelEvent);
  }

  function attachManualTouchScroll(): void {
    const nextXtermEl = containerEl.querySelector('.xterm');
    const nextViewportEl = containerEl.querySelector('.xterm-viewport');
    if (!(nextXtermEl instanceof HTMLElement) || !(nextViewportEl instanceof HTMLElement)) return;

    xtermEl = nextXtermEl;
    viewportEl = nextViewportEl;
    nextXtermEl.addEventListener('touchstart', handleManualTouchStart, { passive: true });
    nextXtermEl.addEventListener('touchmove', handleManualTouchMove, { passive: false });
    nextXtermEl.addEventListener('touchend', handleTouchGestureEnd);
    nextXtermEl.addEventListener('touchcancel', handleTouchGestureEnd);
    manualTouchCleanup = () => {
      nextXtermEl.removeEventListener('touchstart', handleManualTouchStart);
      nextXtermEl.removeEventListener('touchmove', handleManualTouchMove);
      nextXtermEl.removeEventListener('touchend', handleTouchGestureEnd);
      nextXtermEl.removeEventListener('touchcancel', handleTouchGestureEnd);
      xtermEl = null;
      viewportEl = null;
    };
  }

  function hasDragFiles(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    // During dragenter/dragover browsers hide file details for security; the
    // only thing observable is whether "Files" is among the drag types. Images
    // dragged from another page come through as a uri-list.
    return dt.types.includes('Files') || dt.types.includes('text/uri-list');
  }

  function handleDragEnter(e: DragEvent): void {
    if (!hasDragFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounter++;
    isDraggingOver = true;
  }

  function handleDragOver(e: DragEvent): void {
    if (!isDraggingOver) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function handleDragLeave(_e: DragEvent): void {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      isDraggingOver = false;
    }
  }

  function extractImageUrlFromHtml(html: string): string | null {
    const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    return match ? match[1] : null;
  }

  async function handleDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    isDraggingOver = false;

    const dt = e.dataTransfer;
    if (!dt) return;

    let files: File[] = Array.from(dt.files).filter((f) => f.type.startsWith('image/'));

    // No direct files: try to recover an image from dropped HTML, which is how
    // an image dragged out of another browser tab arrives.
    if (files.length === 0) {
      const html = dt.getData('text/html');
      const uri = dt.getData('text/uri-list');
      const imageUrl = (html ? extractImageUrlFromHtml(html) : null) ?? uri;

      if (imageUrl) {
        try {
          const dataMatch = imageUrl.match(/^data:(image\/[^;]+);base64,(.+)/);
          if (dataMatch) {
            const byteString = atob(dataMatch[2]);
            const bytes = new Uint8Array(byteString.length);
            for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
            const ext = dataMatch[1].split('/')[1]?.replace('+xml', '') || 'png';
            files = [new File([bytes], `image.${ext}`, { type: dataMatch[1] })];
          } else if (/^https?:\/\//i.test(imageUrl)) {
            const resp = await fetch(imageUrl);
            const contentType = resp.headers.get('content-type') ?? '';
            const contentLength = Number.parseInt(resp.headers.get('content-length') ?? '0', 10);
            if (resp.ok && contentType.startsWith('image/') && contentLength <= 10 * 1024 * 1024) {
              const blob = await resp.blob();
              const name =
                imageUrl.split('/').pop()?.split('?')[0]?.split('#')[0] || 'image.png';
              files = [new File([blob], name, { type: blob.type })];
            }
          }
        } catch {
          // Fetch/decode failures on a cross-origin drag are not worth reporting.
        }
      }
    }

    if (files.length === 0) return;
    await uploadAndTypeFiles(files);
  }

  async function uploadAndTypeFiles(files: File[]): Promise<void> {
    try {
      const result = await uploadFiles(branch ?? sessionId ?? '', files);
      const paths = result.files.map((f) => f.path).join(' ');
      sendInput(paths);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      term.writeln(`\r\n\x1b[31m[Erro no envio: ${msg}]\x1b[0m`);
    }
  }

  function handlePaste(e: Event): void {
    const clipboard = (e as ClipboardEvent).clipboardData;
    if (!clipboard) return;

    const imageFiles: File[] = [];
    for (const item of clipboard.items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    void uploadAndTypeFiles(imageFiles);
  }

  /**
   * The attach message.
   *
   * `lastOffset` is only sent when there is one: on a first connect its absence
   * is what asks for the whole scrollback.
   */
  function buildResizeMessage(): string {
    return JSON.stringify({
      type: 'resize' as const,
      cols: term.cols,
      rows: term.rows,
      ...(isMobile && initialPane !== undefined ? { initialPane } : {}),
      ...(lastOffset === null ? {} : { lastOffset }),
    });
  }

  async function connect(announceReconnect = false): Promise<void> {
    if (destroyed || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    let url: string;
    try {
      url = await terminalSocketUrl({ sessionId, branch });
    } catch (err) {
      term.writeln(
        `\r\n\x1b[31m[${err instanceof Error ? err.message : String(err)}]\x1b[0m`,
      );
      return;
    }
    if (destroyed) return;

    const nextWs = new WebSocket(url);
    ws = nextWs;

    nextWs.onmessage = (event) => {
      const raw = event.data as string;
      const frame = parseOutputFrame(raw);
      if (frame) {
        lastOffset = frame.offset;
        term.write(frame.data);
        return;
      }
      try {
        const msg = JSON.parse(raw);
        switch (msg.type) {
          case 'exit':
            term.writeln(`\r\n\x1b[33m[Processo encerrado com código ${msg.exitCode}]\x1b[0m`);
            break;
          case 'error':
            term.writeln(`\r\n\x1b[31m[Erro: ${msg.message}]\x1b[0m`);
            break;
          case 'truncated':
            // `bytes: -1` is the server saying the requested offset fell out of
            // the ring, so what follows is a fresh scrollback rather than the
            // delta that was asked for. Saying so is the difference between a
            // gap the user can see and one they cannot.
            term.writeln(
              msg.bytes === -1
                ? '\r\n\x1b[33m[Saída anterior descartada: o histórico não alcança este ponto]\x1b[0m'
                : `\r\n\x1b[33m[${msg.bytes} bytes descartados: saída mais rápida que a tela]\x1b[0m`,
            );
            break;
        }
      } catch {
        // Malformed message — ignored, as upstream.
      }
    };

    nextWs.onerror = () => {};

    nextWs.onopen = () => {
      if (ws !== nextWs) return;
      canRetryVisibleClose = true;
      fitAddon.fit();
      if (announceReconnect) {
        term.writeln(RECONNECTED_NOTICE);
      }
      requestAnimationFrame(() => {
        fitAddon.fit();
        term.focus();
      });
      nextWs.send(buildResizeMessage());
    };

    nextWs.onclose = () => {
      if (ws !== nextWs) return;
      ws = null;
      if (destroyed) return;
      term.writeln(DISCONNECTED_NOTICE);
      if (!document.hidden && canRetryVisibleClose) {
        canRetryVisibleClose = false;
        void connect(true);
      }
    };
  }

  function reconnectIfNeeded(): void {
    if (document.hidden) return;
    void connect(true);
  }

  onMount(() => {
    term = new Terminal({
      cursorBlink: true,
      theme: terminalTheme,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      fontSize: isMobile ? 13 : 11,
      scrollback: 10000,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerEl);
    attachManualTouchScroll();

    // Suppress the browser context menu so tmux right-click works unobstructed.
    containerEl.addEventListener('contextmenu', (e) => e.preventDefault());

    // Capture phase: xterm's own textarea consumes the paste event otherwise.
    containerEl.addEventListener('paste', handlePaste, true);

    // OSC 52 from tmux → the system clipboard.
    term.parser.registerOscHandler(52, (data) => {
      const idx = data.indexOf(';');
      if (idx !== -1) {
        const b64 = data.slice(idx + 1);
        try {
          copyToClipboard(atob(b64));
        } catch {
          // Not valid base64 — nothing to copy.
        }
      }
      return true;
    });

    // Auto-copy on selection, for when the user Shift+drags past tmux's mouse
    // handling.
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) {
        copyToClipboard(sel);
      }
    });

    // Let app-level shortcuts bubble instead of being consumed by xterm.
    // Returning false means xterm ignores the event.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Shift+Enter as a CSI u escape, so an agent TUI can tell it from a plain
      // Enter — xterm.js sends `\r` for both. All three event types are
      // blocked, or xterm still emits `\r` on keypress. `sendKeys` (tmux
      // `send-keys -H`) bypasses tmux's own input parser.
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.type === 'keydown' && ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'sendKeys',
              hexBytes: ['1b', '5b', '31', '33', '3b', '32', '75'],
            }),
          );
        }
        return false;
      }

      if (e.type !== 'keydown') return true;

      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'c' || e.key === 'C')) {
        if (term.hasSelection()) {
          copyToClipboard(term.getSelection());
          term.clearSelection();
          return false;
        }
        return true;
      }
      if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return false;
      if (mod && (e.key === 'k' || e.key === 'K')) return false;
      if (mod && (e.key === 'm' || e.key === 'M')) return false;
      if (mod && (e.key === 'd' || e.key === 'D')) return false;
      return true;
    });

    requestAnimationFrame(() => {
      fitAddon.fit();
      term.focus();
    });

    void connect();

    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    resizeObs = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      }, 150);
    });
    resizeObs.observe(containerEl);

    document.addEventListener('visibilitychange', reconnectIfNeeded);
    window.addEventListener('focus', reconnectIfNeeded);
    window.addEventListener('online', reconnectIfNeeded);
    termReady = true;
  });

  $effect(() => {
    if (termReady && terminalTheme && term.options) {
      term.options.theme = terminalTheme;
    }
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(resizeTimer);
    manualTouchCleanup?.();
    resizeObs?.disconnect();
    containerEl?.removeEventListener('paste', handlePaste, true);
    document.removeEventListener('visibilitychange', reconnectIfNeeded);
    window.removeEventListener('focus', reconnectIfNeeded);
    window.removeEventListener('online', reconnectIfNeeded);
    ws?.close();
    term?.dispose();
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex-1 min-h-0 w-full p-1 overflow-hidden relative"
  bind:this={containerEl}
  ondragenter={handleDragEnter}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  {#if agentTerminalStale}
    <div
      class="absolute left-3 right-3 top-3 z-20 flex items-center justify-between gap-3 rounded-md border border-warning/40 bg-surface px-4 py-3 text-sm text-primary shadow-lg"
      role="status"
    >
      <span class="min-w-0 truncate">Terminal desatualizado</span>
      {#if onrefreshagentterminal}
        <button
          type="button"
          class="shrink-0 rounded-md border border-warning/50 bg-surface px-3 py-1.5 text-xs font-medium text-warning hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-50"
          title="Recarregar o terminal do agente"
          onclick={onrefreshagentterminal}
          disabled={refreshingAgentTerminal}
        >
          {refreshingAgentTerminal ? 'Recarregando' : 'Recarregar'}
        </button>
      {/if}
    </div>
  {/if}

  {#if isDraggingOver}
    <div
      class="absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-accent rounded pointer-events-none drop-overlay"
    >
      <span class="text-primary text-sm font-medium">Solte a imagem para enviar</span>
    </div>
  {/if}
</div>

<style>
  .drop-overlay {
    background: var(--overlay);
  }
</style>
