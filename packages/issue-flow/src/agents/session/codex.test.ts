import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CodexAppServerClient,
  type CodexAppServerNotification,
  type CodexAppServerProcess,
  CodexAppServerRequestError,
  parseCodexAppServerThreadItem,
  parseCodexAppServerThreadReadResponse,
  readCodexAppServerStdoutLines,
} from './codex.js';

/**
 * Parity suite for the `codex app-server` client.
 *
 * Framing and schema cases ported from
 * `.references/webmux-main/backend/src/__tests__/codex-app-server.test.ts`.
 * The upstream had no test for the client itself — it could not drive one
 * without spawning `codex` — so the protocol cases below are new, and they
 * exist mainly to pin `rejectPending` on exit (§45.2-B), which is the detail
 * the ficha names as the one that must not be lost.
 */

/** A stand-in for `codex app-server`, so no test needs the binary. */
class FakeCodexAppServer implements CodexAppServerProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: Array<Record<string, unknown>> = [];
  private exitListener: ((code: number | null) => void) | null = null;
  killed = false;

  constructor(private readonly handshake: 'accept' | 'refuse' = 'accept') {}

  readonly stdin = {
    write: (chunk: string): unknown => {
      for (const line of chunk.split('\n').filter((part) => part.trim().length > 0)) {
        const payload = JSON.parse(line) as Record<string, unknown>;
        this.sent.push(payload);
        if (payload.method !== 'initialize') continue;
        const id = payload.id as number;
        if (this.handshake === 'accept') {
          this.reply(id, {
            userAgent: 'codex/1',
            codexHome: '/home/.codex',
            platformFamily: 'unix',
            platformOs: 'darwin',
          });
        } else {
          this.replyError(id, { code: -32603, message: 'handshake refused' });
        }
      }
      return true;
    },
  };

  kill(): void {
    this.killed = true;
    this.exit(0);
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListener = listener;
  }

  exit(code: number | null): void {
    this.exitListener?.(code);
  }

  reply(id: number, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  replyError(id: number, error: { code: number; message: string; data?: unknown }): void {
    this.stdout.write(`${JSON.stringify({ id, error })}\n`);
  }

  notify(method: string, params?: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  /** Requests other than the handshake, in the order they were sent. */
  requests(): Array<Record<string, unknown>> {
    return this.sent.filter(
      (payload) => typeof payload.id === 'number' && payload.method !== 'initialize',
    );
  }

  /** Reply to the most recent request for `method`, whatever id it was given. */
  replyToLast(method: string, result: unknown): void {
    const request = [...this.sent].reverse().find((payload) => payload.method === method);
    if (!request) throw new Error(`no ${method} request was sent`);
    this.reply(request.id as number, result);
  }
}

function makeThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'thread-1',
    forkedFromId: null,
    preview: 'Run checks',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 2,
    status: { type: 'active' },
    path: '/tmp/worktree',
    cwd: '/tmp/worktree',
    cliVersion: '1.0.0',
    source: 'cli',
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

/** Let the PassThrough deliver everything queued so far. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('readCodexAppServerStdoutLines', () => {
  // upstream: "decodes split UTF-8 stdout chunks before splitting JSON-RPC lines"
  it('decodes a multi-byte character split across two chunks', () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bytes = encoder.encode('{"text":"hello €"}\n{"text":"done"}\n');
    const splitIndex = bytes.indexOf(0x82);

    const first = readCodexAppServerStdoutLines({
      decoder,
      buffer: '',
      chunk: bytes.slice(0, splitIndex),
    });
    const second = readCodexAppServerStdoutLines({
      decoder,
      buffer: first.buffer,
      chunk: bytes.slice(splitIndex),
    });

    expect(first.lines).toEqual([]);
    expect(second.lines).toEqual(['{"text":"hello €"}', '{"text":"done"}']);
  });

  // upstream: "flushes a final line without a trailing newline"
  it('flushes a final line that has no trailing newline', () => {
    const decoder = new TextDecoder();
    const chunk = new TextEncoder().encode('{"ok":true}');

    const first = readCodexAppServerStdoutLines({ decoder, buffer: '', chunk });
    const flushed = readCodexAppServerStdoutLines({ decoder, buffer: first.buffer });

    expect(first.lines).toEqual([]);
    expect(flushed).toEqual({ buffer: '', lines: ['{"ok":true}'] });
  });

  // New: blank lines are framing, not messages.
  it('drops blank lines', () => {
    const decoder = new TextDecoder();
    const chunk = new TextEncoder().encode('{"a":1}\n\n  \n{"b":2}\n');
    expect(readCodexAppServerStdoutLines({ decoder, buffer: '', chunk }).lines).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  // New: a chunk with no newline yet is buffered whole.
  it('buffers a partial line until its newline arrives', () => {
    const decoder = new TextDecoder();
    const first = readCodexAppServerStdoutLines({
      decoder,
      buffer: '',
      chunk: new TextEncoder().encode('{"a":'),
    });
    expect(first.lines).toEqual([]);
    const second = readCodexAppServerStdoutLines({
      decoder,
      buffer: first.buffer,
      chunk: new TextEncoder().encode('1}\n'),
    });
    expect(second.lines).toEqual(['{"a":1}']);
  });
});

describe('parseCodexAppServerThreadItem', () => {
  // upstream: "parses app-server tool thread items"
  it('parses mcp tool calls and file changes', () => {
    expect(
      parseCodexAppServerThreadItem({
        type: 'mcpToolCall',
        id: 'mcp-1',
        server: 'docs',
        tool: 'get_page',
        status: 'completed',
        arguments: { pageId: 'ENG-123' },
        pluginId: null,
        result: {
          content: [{ type: 'text', text: 'Page title' }],
          structuredContent: null,
          _meta: null,
        },
        error: null,
        durationMs: 25,
      })?.type,
    ).toBe('mcpToolCall');

    expect(
      parseCodexAppServerThreadItem({
        type: 'fileChange',
        id: 'patch-1',
        status: 'completed',
        changes: [
          {
            path: 'README.md',
            kind: { type: 'update', move_path: null },
            diff: '--- a/README.md\n+++ b/README.md\n',
          },
        ],
      })?.type,
    ).toBe('fileChange');
  });

  // upstream: "keeps parsing partially modeled app-server items" — the reason
  // the union ends with a generic `{type, id}` member.
  it('keeps an item type it has never seen, down to its type and id', () => {
    expect(
      parseCodexAppServerThreadItem({
        type: 'agentMessage',
        id: 'assistant-null-phase',
        text: 'Hello',
        phase: null,
        memoryCitation: null,
      }),
    ).toEqual({
      type: 'agentMessage',
      id: 'assistant-null-phase',
      text: 'Hello',
      phase: null,
      memoryCitation: null,
    });

    expect(
      parseCodexAppServerThreadItem({
        type: 'newFutureItem',
        id: 'future-1',
        nested: { unsupported: true },
      }),
    ).toEqual({ type: 'newFutureItem', id: 'future-1' });
  });

  // New: an item that is not even shaped like one is rejected rather than
  // guessed at.
  it('rejects an item with no id', () => {
    expect(parseCodexAppServerThreadItem({ type: 'whatever' })).toBeNull();
  });

  // New: `commandActions` is defaulted, so an older app-server that omits it
  // still yields the command instead of dropping the whole item.
  it('defaults a missing commandActions list', () => {
    const item = parseCodexAppServerThreadItem({
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'npm test',
      cwd: null,
      status: 'completed',
      aggregatedOutput: null,
      exitCode: 0,
      durationMs: 10,
    });
    expect(item).toMatchObject({ type: 'commandExecution', commandActions: [] });
  });
});

describe('parseCodexAppServerThreadReadResponse', () => {
  // upstream: "keeps parsing thread reads with future turn statuses"
  it('accepts a turn status this release has never seen', () => {
    const parsed = parseCodexAppServerThreadReadResponse({
      thread: makeThread({
        turns: [
          {
            id: 'turn-1',
            status: 'running',
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
            items: [],
          },
        ],
      }),
    });
    expect(parsed?.thread.turns[0]?.status).toBe('running');
  });

  it('rejects a payload that is not a thread read', () => {
    expect(parseCodexAppServerThreadReadResponse({ thread: { id: 'x' } })).toBeNull();
  });
});

describe('CodexAppServerClient', () => {
  // New: the two-step handshake. Without `initialized` the server answers every
  // later request with a protocol error.
  it('sends initialize then initialized before the first request', async () => {
    const proc = new FakeCodexAppServer();
    const client = new CodexAppServerClient({ spawn: () => proc });

    const pending = client.threadRead('thread-1', true);
    await flush();
    proc.replyToLast('thread/read', { thread: makeThread() });
    await pending;

    expect(proc.sent.map((payload) => payload.method)).toEqual([
      'initialize',
      'initialized',
      'thread/read',
    ]);
    expect(proc.sent[0]?.id).toBe(1);
    expect(proc.sent[1]?.id).toBeUndefined();
  });

  it('spawns one process for many requests and numbers ids monotonically', async () => {
    const proc = new FakeCodexAppServer();
    let spawns = 0;
    const client = new CodexAppServerClient({
      spawn: () => {
        spawns += 1;
        return proc;
      },
    });

    const first = client.threadRead('a', true);
    await flush();
    proc.replyToLast('thread/read', { thread: makeThread({ id: 'a' }) });
    await first;

    const second = client.threadRead('b', true);
    await flush();
    proc.replyToLast('thread/read', { thread: makeThread({ id: 'b' }) });
    expect((await second).thread.id).toBe('b');

    expect(spawns).toBe(1);
    expect(proc.requests().map((payload) => payload.id)).toEqual([2, 3]);
  });

  it('turns a JSON-RPC error reply into a typed error', async () => {
    const proc = new FakeCodexAppServer();
    const client = new CodexAppServerClient({ spawn: () => proc });

    const pending = client.threadRead('missing', true);
    await flush();
    const id = proc.requests()[0]?.id as number;
    proc.replyError(id, { code: -32602, message: 'no such thread', data: { threadId: 'missing' } });

    await expect(pending).rejects.toBeInstanceOf(CodexAppServerRequestError);
    await pending.catch((error: unknown) => {
      expect(error).toMatchObject({ code: -32602, message: 'no such thread' });
    });
  });

  it('rejects a reply that does not match the method schema', async () => {
    const proc = new FakeCodexAppServer();
    const client = new CodexAppServerClient({ spawn: () => proc });

    const pending = client.threadRead('thread-1', true);
    await flush();
    proc.replyToLast('thread/read', { thread: { id: 'thread-1' } });

    await expect(pending).rejects.toThrow(/invalid thread\/read response/);
  });

  // §45.2-B — the detail the ficha names. Without `rejectPending` this promise
  // never settles: the daemon is gone, there is no child of the invocation for
  // the watchdog to notice, and the caller waits forever.
  it('rejects every in-flight request when the daemon dies', async () => {
    const proc = new FakeCodexAppServer();
    const client = new CodexAppServerClient({ spawn: () => proc });

    const first = client.threadRead('a', true);
    const second = client.threadList({});
    await flush();
    proc.exit(1);

    await expect(first).rejects.toThrow(/exited with code 1/);
    await expect(second).rejects.toThrow(/exited with code 1/);
  });

  it('spawns a fresh process after the previous one died', async () => {
    const processes: FakeCodexAppServer[] = [];
    const client = new CodexAppServerClient({
      spawn: () => {
        const proc = new FakeCodexAppServer();
        processes.push(proc);
        return proc;
      },
    });

    const first = client.threadRead('a', true);
    await flush();
    processes[0]?.exit(1);
    await expect(first).rejects.toThrow();

    const second = client.threadRead('b', true);
    await flush();
    processes[1]?.replyToLast('thread/read', { thread: makeThread({ id: 'b' }) });
    expect((await second).thread.id).toBe('b');
    expect(processes).toHaveLength(2);
  });

  it('leaves no client half-open when the handshake fails', async () => {
    const processes: FakeCodexAppServer[] = [];
    let handshake: 'accept' | 'refuse' = 'refuse';
    const client = new CodexAppServerClient({
      spawn: () => {
        const proc = new FakeCodexAppServer(handshake);
        processes.push(proc);
        return proc;
      },
    });

    await expect(client.threadRead('a', true)).rejects.toThrow(/handshake refused/);

    // A second call must be able to start over rather than reuse the failed
    // ready promise.
    handshake = 'accept';
    const second = client.threadRead('b', true);
    await flush();
    processes[1]?.replyToLast('thread/read', { thread: makeThread({ id: 'b' }) });
    expect((await second).thread.id).toBe('b');
    expect(processes).toHaveLength(2);
  });

  it('fans unsolicited notifications out to subscribers', async () => {
    const proc = new FakeCodexAppServer();
    const client = new CodexAppServerClient({ spawn: () => proc });
    const seen: CodexAppServerNotification[] = [];
    const unsubscribe = client.onNotification((notification) => seen.push(notification));

    const pending = client.threadRead('a', true);
    await flush();
    proc.notify('thread/event', { kind: 'itemStarted' });
    await flush();
    proc.replyToLast('thread/read', { thread: makeThread() });
    await pending;

    expect(seen).toEqual([{ method: 'thread/event', params: { kind: 'itemStarted' } }]);

    unsubscribe();
    proc.notify('thread/event', { kind: 'itemCompleted' });
    await flush();
    expect(seen).toHaveLength(1);
  });

  it('ignores stdout that is not JSON and stdout that is not a message', async () => {
    const proc = new FakeCodexAppServer();
    const client = new CodexAppServerClient({ spawn: () => proc });
    const seen: CodexAppServerNotification[] = [];
    client.onNotification((notification) => seen.push(notification));

    const pending = client.threadRead('a', true);
    await flush();
    proc.stdout.write('not json\n');
    proc.stdout.write('[1,2,3]\n');
    proc.stdout.write('{"noMethodNoId":true}\n');
    await flush();
    proc.replyToLast('thread/read', { thread: makeThread() });

    await expect(pending).resolves.toBeDefined();
    expect(seen).toEqual([]);
  });

  // stderr must be drained by its own listener: an unread pipe fills and blocks
  // the child, which would stall stdout and with it every pending request.
  it('drains stderr without letting it reach the protocol', async () => {
    const proc = new FakeCodexAppServer();
    const chunks: string[] = [];
    const client = new CodexAppServerClient({ spawn: () => proc, onStderr: (c) => chunks.push(c) });

    const pending = client.threadRead('a', true);
    await flush();
    proc.stderr.write('warning: model fallback\n');
    await flush();
    proc.replyToLast('thread/read', { thread: makeThread() });
    await pending;

    expect(chunks).toEqual(['warning: model fallback']);
  });

  it('sends turn/interrupt without demanding a typed reply', async () => {
    const proc = new FakeCodexAppServer();
    const client = new CodexAppServerClient({ spawn: () => proc });

    const pending = client.turnInterrupt({ threadId: 'a', turnId: 't1' });
    await flush();
    proc.replyToLast('turn/interrupt', null);
    await expect(pending).resolves.toBeUndefined();
    expect(proc.requests()[0]).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'a', turnId: 't1' },
    });
  });

  it('kills the daemon on close', async () => {
    const proc = new FakeCodexAppServer();
    const client = new CodexAppServerClient({ spawn: () => proc });
    const pending = client.threadRead('a', true);
    await flush();

    client.close();
    await expect(pending).rejects.toThrow(/exited with code 0/);
    expect(proc.killed).toBe(true);
  });
});
