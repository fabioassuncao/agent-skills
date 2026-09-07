import { describe, expect, it } from 'vitest';
import {
  type CodexAppServerThread,
  type CodexAppServerThreadItem,
  parseCodexAppServerThreadItem,
  parseCodexAppServerThreadReadResponse,
} from './codex.js';
import {
  buildCodexItemConversationMessages,
  findActiveTurn,
  isActiveTurnStatus,
  toCodexConversationState,
} from './codex-conversation.js';

/**
 * The Codex half of the structured channel, as messages.
 *
 * The upstream had no test file for these builders — they live inside
 * `services/worktree-conversation-service.ts`, whose suite exercises the
 * stateful service around them. These cases are new and cover the translation
 * itself, which is what the panel actually renders.
 *
 * Items are built through the schema rather than typed by hand, so a case that
 * would not survive `parseCodexAppServerThreadItem` cannot pass here either.
 */

function item(raw: Record<string, unknown>): CodexAppServerThreadItem {
  const parsed = parseCodexAppServerThreadItem(raw);
  if (!parsed) throw new Error(`fixture is not a valid thread item: ${JSON.stringify(raw)}`);
  return parsed;
}

function thread(turns: Array<Record<string, unknown>>): CodexAppServerThread {
  const parsed = parseCodexAppServerThreadReadResponse({
    thread: {
      id: 'thread-1',
      forkedFromId: null,
      preview: '',
      ephemeral: false,
      modelProvider: 'openai',
      createdAt: 1,
      updatedAt: 2,
      status: { type: 'active' },
      path: '/tmp/wt',
      cwd: '/tmp/wt',
      cliVersion: '1.0.0',
      source: 'cli',
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns,
    },
  });
  if (!parsed) throw new Error('fixture is not a valid thread');
  return parsed.thread;
}

function turn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'turn-1',
    status: 'completed',
    error: null,
    startedAt: 1_700_000_000,
    completedAt: 1_700_000_060,
    durationMs: 60_000,
    items: [],
    ...overrides,
  };
}

const build = {
  turnId: 'turn-1',
  turnStatus: 'completed',
  createdAt: '2026-01-01T00:00:00.000Z',
  order: 0,
};

describe('buildCodexItemConversationMessages', () => {
  it('joins a user message from its content parts', () => {
    const [message] = buildCodexItemConversationMessages({
      ...build,
      item: item({
        type: 'userMessage',
        id: 'u1',
        content: [
          { type: 'inputText', text: 'Fix ' },
          { type: 'inputText', text: 'the parser' },
        ],
      }),
    });
    expect(message).toMatchObject({ role: 'user', kind: 'text', text: 'Fix the parser', order: 0 });
  });

  it('drops an empty message unless the caller asks to keep it', () => {
    const empty = item({ type: 'userMessage', id: 'u1', content: [] });
    expect(buildCodexItemConversationMessages({ ...build, item: empty })).toEqual([]);
    expect(
      buildCodexItemConversationMessages({ ...build, item: empty, includeEmptyText: true }),
    ).toHaveLength(1);
  });

  it('reads agent text from either field name', () => {
    expect(
      buildCodexItemConversationMessages({
        ...build,
        item: item({ type: 'agentMessage', id: 'a1', message: 'from message' }),
      })[0]?.text,
    ).toBe('from message');
  });

  // Codex labels its own reasoning `analysis`; that is thinking, not an answer.
  it('renders the analysis phase as thinking', () => {
    expect(
      buildCodexItemConversationMessages({
        ...build,
        item: item({ type: 'agentMessage', id: 'a1', text: 'hmm', phase: 'analysis' }),
      })[0],
    ).toMatchObject({ kind: 'thinking', phase: 'analysis' });
  });

  it('marks an agent message inProgress while its turn is still running', () => {
    expect(
      buildCodexItemConversationMessages({
        ...build,
        turnStatus: 'running',
        item: item({ type: 'agentMessage', id: 'a1', text: 'working' }),
      })[0]?.status,
    ).toBe('inProgress');
  });

  // A command that ran to completion with a non-zero exit is a failure, even
  // though the app-server calls the execution "completed".
  it('fails a completed command that exited non-zero', () => {
    const messages = buildCodexItemConversationMessages({
      ...build,
      item: item({
        type: 'commandExecution',
        id: 'c1',
        command: 'npm test',
        cwd: '/tmp/wt',
        status: 'completed',
        commandActions: [],
        aggregatedOutput: '1 failing',
        exitCode: 1,
        durationMs: 900,
      }),
    });
    expect(messages.map((message) => message.status)).toEqual(['failed', 'failed']);
  });

  // A tool call is two messages, so its output can collapse independently.
  it('splits a command into a call and its output, ordered consecutively', () => {
    const messages = buildCodexItemConversationMessages({
      ...build,
      order: 4,
      item: item({
        type: 'commandExecution',
        id: 'c1',
        command: 'ls',
        cwd: null,
        status: 'completed',
        commandActions: [{ type: 'exec', command: 'ls -la' }],
        aggregatedOutput: 'total 0\n',
        exitCode: 0,
        durationMs: 5,
      }),
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      id: 'c1',
      order: 4,
      role: 'assistant',
      kind: 'toolUse',
      toolName: 'shell',
      text: 'ls -la',
      command: 'ls',
    });
    expect(messages[1]).toMatchObject({
      id: 'c1:result',
      order: 5,
      role: 'user',
      kind: 'toolResult',
      text: 'total 0',
    });
    // `cwd: null` is absent rather than null, matching the shared shape.
    expect(messages[0] && 'cwd' in messages[0]).toBe(false);
  });

  it('emits only the call when a command produced no output', () => {
    expect(
      buildCodexItemConversationMessages({
        ...build,
        item: item({
          type: 'commandExecution',
          id: 'c1',
          command: 'true',
          cwd: null,
          status: 'completed',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 1,
        }),
      }),
    ).toHaveLength(1);
  });

  it('labels file changes by kind and carries the diff as the result', () => {
    const messages = buildCodexItemConversationMessages({
      ...build,
      item: item({
        type: 'fileChange',
        id: 'p1',
        status: 'completed',
        changes: [
          { path: 'a.ts', kind: { type: 'add' }, diff: '+a\n' },
          { path: 'b.ts', kind: { type: 'delete' }, diff: '-b\n' },
          { path: 'd.ts', kind: { type: 'update', move_path: 'c.ts' }, diff: '~d\n' },
        ],
      }),
    });
    expect(messages[0]?.text).toBe('add a.ts\ndelete b.ts\nmove c.ts -> d.ts');
    expect(messages[1]?.text).toBe('+a\n\n-b\n\n~d');
  });

  it('prefers an mcp error message over its result', () => {
    const messages = buildCodexItemConversationMessages({
      ...build,
      item: item({
        type: 'mcpToolCall',
        id: 'm1',
        server: 'docs',
        tool: 'get_page',
        status: 'completed',
        arguments: { id: 1 },
        pluginId: null,
        result: null,
        error: { message: 'upstream 500' },
        durationMs: 3,
      }),
    });
    expect(messages[0]).toMatchObject({ toolName: 'docs.get_page', status: 'failed' });
    expect(messages[1]?.text).toBe('upstream 500');
  });

  it('reads mcp text content and appends structured content', () => {
    const messages = buildCodexItemConversationMessages({
      ...build,
      item: item({
        type: 'mcpToolCall',
        id: 'm1',
        server: 's',
        tool: 't',
        status: 'completed',
        arguments: {},
        pluginId: null,
        result: {
          content: [{ type: 'text', text: 'body' }],
          structuredContent: { n: 1 },
          _meta: null,
        },
        error: null,
        durationMs: null,
      }),
    });
    expect(messages[1]?.text).toBe('body\n\n{\n  "n": 1\n}');
  });

  // `success: false` on a "completed" call is a failure for the same reason a
  // non-zero exit code is.
  it('fails a dynamic tool call that reported success false', () => {
    const messages = buildCodexItemConversationMessages({
      ...build,
      item: item({
        type: 'dynamicToolCall',
        id: 'd1',
        namespace: 'ns',
        tool: 'do',
        arguments: {},
        status: 'completed',
        contentItems: [{ type: 'inputText', text: 'nope' }],
        success: false,
        durationMs: null,
      }),
    });
    expect(messages[0]).toMatchObject({ toolName: 'ns.do', status: 'failed' });
    expect(messages[1]?.text).toBe('nope');
  });

  it('renders each web search action shape', () => {
    const render = (action: unknown): string | undefined =>
      buildCodexItemConversationMessages({
        ...build,
        item: item({ type: 'webSearch', id: 'w1', query: 'fallback', action }),
      })[0]?.text;

    expect(render({ type: 'search', query: 'one', queries: ['a', 'b'] })).toBe('a\nb');
    expect(render({ type: 'search', query: 'one', queries: null })).toBe('one');
    expect(render({ type: 'openPage', url: 'https://x' })).toBe('https://x');
    expect(render({ type: 'findInPage', url: 'https://x', pattern: 'p' })).toBe('https://x\np');
    expect(render({ type: 'other' })).toBe('fallback');
    expect(render(null)).toBe('fallback');
  });

  // Ignored and unmodelled items render as nothing — that is what keeps a newer
  // Codex from breaking the panel.
  it('renders ignored and unmodelled items as nothing', () => {
    expect(
      buildCodexItemConversationMessages({ ...build, item: item({ type: 'reasoning', id: 'r1' }) }),
    ).toEqual([]);
    expect(
      buildCodexItemConversationMessages({
        ...build,
        item: item({ type: 'newFutureItem', id: 'f1' }),
      }),
    ).toEqual([]);
  });
});

describe('isActiveTurnStatus / findActiveTurn', () => {
  it('recognises every spelling of "still going"', () => {
    for (const status of ['inProgress', 'active', 'running', 'pending', 'queued']) {
      expect(isActiveTurnStatus(status)).toBe(true);
    }
  });

  // An unknown status is treated as finished: a message that spins forever is
  // worse than one that stops a moment early.
  it('treats an unknown status as finished', () => {
    expect(isActiveTurnStatus('somethingNew')).toBe(false);
  });

  it('finds the last running turn, searching from the end', () => {
    const found = findActiveTurn(
      thread([
        turn({ id: 't1', status: 'running' }),
        turn({ id: 't2', status: 'completed' }),
        turn({ id: 't3', status: 'queued' }),
      ]),
    );
    expect(found?.id).toBe('t3');
  });

  it('returns null when every turn is finished', () => {
    expect(findActiveTurn(thread([turn({ id: 't1' })]))).toBeNull();
  });
});

describe('toCodexConversationState', () => {
  it('flattens turns into ordered messages', () => {
    const state = toCodexConversationState(
      thread([
        turn({
          id: 't1',
          items: [
            { type: 'userMessage', id: 'u1', content: [{ type: 'inputText', text: 'go' }] },
            {
              type: 'commandExecution',
              id: 'c1',
              command: 'ls',
              cwd: null,
              status: 'completed',
              commandActions: [],
              aggregatedOutput: 'out',
              exitCode: 0,
              durationMs: 1,
            },
            { type: 'agentMessage', id: 'a1', text: 'done' },
          ],
        }),
      ]),
    );

    expect(state.provider).toBe('codexAppServer');
    expect(state.conversationId).toBe('thread-1');
    expect(state.cwd).toBe('/tmp/wt');
    expect(state.running).toBe(false);
    expect(state.messages.map((message) => [message.id, message.order])).toEqual([
      ['u1', 0],
      ['c1', 1],
      ['c1:result', 2],
      ['a1', 3],
    ]);
  });

  // Epoch seconds, not milliseconds: reading them as milliseconds dates every
  // message to 1970.
  it('stamps user messages with the turn start and the rest with its end', () => {
    const state = toCodexConversationState(
      thread([
        turn({
          id: 't1',
          startedAt: 1_700_000_000,
          completedAt: 1_700_000_060,
          items: [
            { type: 'userMessage', id: 'u1', content: [{ type: 'inputText', text: 'go' }] },
            { type: 'agentMessage', id: 'a1', text: 'done' },
          ],
        }),
      ]),
    );
    expect(state.messages[0]?.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(state.messages[1]?.createdAt).toBe(new Date(1_700_000_060_000).toISOString());
  });

  it('falls back to the start time for a turn that has not finished', () => {
    const state = toCodexConversationState(
      thread([
        turn({
          status: 'running',
          completedAt: null,
          items: [{ type: 'agentMessage', id: 'a1', text: 'working' }],
        }),
      ]),
    );
    expect(state.messages[0]?.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(state.running).toBe(true);
    expect(state.activeTurnId).toBe('turn-1');
  });

  it('leaves createdAt null when the turn carries no timing at all', () => {
    const state = toCodexConversationState(
      thread([
        turn({
          startedAt: null,
          completedAt: null,
          items: [{ type: 'userMessage', id: 'u1', content: [{ type: 'inputText', text: 'go' }] }],
        }),
      ]),
    );
    expect(state.messages[0]?.createdAt).toBeNull();
  });

  it('produces an empty conversation for a thread with no turns', () => {
    expect(toCodexConversationState(thread([])).messages).toEqual([]);
  });
});
