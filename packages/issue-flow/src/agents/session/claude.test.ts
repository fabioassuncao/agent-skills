import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClaudeSessionFromText,
  type ClaudeStreamEvent,
  createClaudeConversationGateway,
  createClaudeStreamReader,
  encodeClaudeProjectDir,
  toClaudeConversationState,
} from './claude.js';

/**
 * Parity suite for the Claude conversation reader.
 *
 * Transcript cases ported from
 * `.references/webmux-main/backend/src/__tests__/claude-cli.test.ts`; the block
 * identity cases from `claude-stream-block-identity.test.ts`, which exists
 * upstream for one reason — to prove that two assistant text blocks sharing a
 * content index across two API messages do not collapse into one bubble.
 *
 * The upstream identity cases drove the whole streaming service stack
 * (`ClaudeConversationStreamService` + `AgentsConversationStreamSession`), none
 * of which §22 assigns to this phase. They are re-expressed against
 * `createClaudeStreamReader` plus the six-line reducer below, which is the same
 * fold the panel performs: a delta appends to its item id, a finalised message
 * replaces its item's text. The property under test is unchanged.
 */

function collectAssistantTextsByItem(events: ClaudeStreamEvent[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'delta') {
      byId.set(event.itemId, `${byId.get(event.itemId) ?? ''}${event.delta}`);
      continue;
    }
    if (
      event.type === 'message' &&
      event.message.role === 'assistant' &&
      event.message.kind === 'text'
    ) {
      byId.set(event.message.id, event.message.text);
    }
  }
  return byId;
}

function replay(lines: string[]): ClaudeStreamEvent[] {
  const reader = createClaudeStreamReader();
  return lines.flatMap((line) => reader.read(line));
}

// A turn with two assistant API messages, each emitting a TEXT block at content
// index 0. `content_block.index` is scoped to the current API message and
// resets, so index alone collides; `message.id` is what tells them apart.
// Abridged from the upstream fixture captured against claude 2.1.170.
const TWO_MESSAGE_TURN: string[] = [
  JSON.stringify({
    type: 'stream_event',
    session_id: 'session-1',
    event: { type: 'message_start', message: { id: 'msg_AAA', role: 'assistant' } },
  }),
  JSON.stringify({
    type: 'stream_event',
    session_id: 'session-1',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  }),
  JSON.stringify({
    type: 'stream_event',
    session_id: 'session-1',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Let me read that file.' },
    },
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-1',
    uuid: 'rec-A-text',
    message: {
      id: 'msg_AAA',
      role: 'assistant',
      content: [{ type: 'text', text: 'Let me read that file.' }],
    },
  }),
  JSON.stringify({
    type: 'stream_event',
    session_id: 'session-1',
    event: { type: 'content_block_stop', index: 0 },
  }),
  JSON.stringify({
    type: 'stream_event',
    session_id: 'session-1',
    event: {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
    },
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-1',
    uuid: 'rec-A-tool',
    message: {
      id: 'msg_AAA',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/alpha.txt' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    session_id: 'session-1',
    uuid: 'rec-toolresult',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello from alpha' }],
    },
  }),
  JSON.stringify({
    type: 'stream_event',
    session_id: 'session-1',
    event: { type: 'message_start', message: { id: 'msg_BBB', role: 'assistant' } },
  }),
  JSON.stringify({
    type: 'stream_event',
    session_id: 'session-1',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  }),
  JSON.stringify({
    type: 'stream_event',
    session_id: 'session-1',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'The file says hello.' },
    },
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'session-1',
    uuid: 'rec-B-text',
    message: {
      id: 'msg_BBB',
      role: 'assistant',
      content: [{ type: 'text', text: 'The file says hello.' }],
    },
  }),
  JSON.stringify({ type: 'result', session_id: 'session-1', is_error: false, result: 'done' }),
];

describe('encodeClaudeProjectDir', () => {
  // upstream: "encodes Claude project directories from cwd"
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(encodeClaudeProjectDir('/tmp/worktrees/feature.one')).toBe('-tmp-worktrees-feature-one');
  });
});

describe('block identity across the stream', () => {
  // upstream: "the parser surfaces message.id so two same-index text blocks can
  // be told apart" — the information loss the whole rule exists to fix.
  it('reports the same block index for two different messages', () => {
    const indexes = replay(TWO_MESSAGE_TURN).flatMap((event) =>
      event.type === 'delta' ? [event.itemId] : [],
    );
    expect(indexes).toEqual(['msg_AAA:0', 'msg_BBB:0']);
  });

  // upstream: "keeps the two assistant text blocks in two separate containers"
  it('keeps two assistant text blocks in separate containers (full stream)', () => {
    const texts = [...collectAssistantTextsByItem(replay(TWO_MESSAGE_TURN)).values()];
    expect(texts).toContain('Let me read that file.');
    expect(texts).toContain('The file says hello.');
    for (const text of texts) {
      expect(text.includes('Let me read that file.') && text.includes('The file says hello.')).toBe(
        false,
      );
    }
  });

  // upstream: "keeps the two text blocks separate from the delta stream alone".
  // The live path must be self-sufficient: identity comes from the delta stream
  // itself, not from full `assistant` records happening to arrive in time to
  // rename the live item before the next same-index block reuses its slot.
  it('keeps them separate from the delta stream alone', () => {
    const deltaOnly = TWO_MESSAGE_TURN.filter(
      (line) => (JSON.parse(line) as { type?: string }).type === 'stream_event',
    );
    const texts = [...collectAssistantTextsByItem(replay(deltaOnly)).values()];
    const merged = texts.filter(
      (text) => text.includes('Let me read that file.') && text.includes('The file says hello.'),
    );
    expect(merged).toEqual([]);
  });

  // New: the identity minted live must equal the identity minted from the
  // transcript, or the same block renders twice when the file is read back.
  it('mints the same ids live and from the persisted transcript', () => {
    const live = replay(TWO_MESSAGE_TURN).flatMap((event) =>
      event.type === 'message' && event.message.kind === 'text' ? [event.message.id] : [],
    );
    const stored = buildClaudeSessionFromText({
      path: '/tmp/s.jsonl',
      sessionId: 's',
      text: [
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          message: { role: 'user', content: 'Read alpha.txt' },
        }),
        ...TWO_MESSAGE_TURN.filter(
          (line) => (JSON.parse(line) as { type?: string }).type === 'assistant',
        ),
      ].join('\n'),
    });
    const storedTextIds = stored.messages
      .filter((message) => message.role === 'assistant' && message.kind === 'text')
      .map((message) => message.id);
    expect(storedTextIds).toEqual(live);
  });
});

describe('createClaudeStreamReader', () => {
  // New: the session id is what `--resume` takes, and it is reported once.
  it('reports the session id once, on the first line that carries it', () => {
    const reader = createClaudeStreamReader();
    const first = reader.read(JSON.stringify({ type: 'system', session_id: 'abc' }));
    const second = reader.read(JSON.stringify({ type: 'system', session_id: 'abc' }));
    expect(first).toEqual([{ type: 'sessionId', sessionId: 'abc' }]);
    expect(second).toEqual([]);
    expect(reader.sessionId).toBe('abc');
  });

  it('emits complete on a successful result and error on a failed one', () => {
    const reader = createClaudeStreamReader();
    reader.read(JSON.stringify({ type: 'system', session_id: 'abc' }));
    expect(
      reader.read(
        JSON.stringify({ type: 'result', session_id: 'abc', is_error: false, result: 'ok' }),
      ),
    ).toEqual([{ type: 'complete', sessionId: 'abc' }]);
    expect(
      reader.read(
        JSON.stringify({ type: 'result', session_id: 'abc', is_error: true, result: 'boom' }),
      ),
    ).toEqual([{ type: 'error', message: 'boom' }]);
  });

  it('yields nothing for a line that is not JSON', () => {
    expect(createClaudeStreamReader().read('warning: something')).toEqual([]);
  });

  // New: a tool result is keyed by the call it answers, so it upserts over the
  // copy that arrived by the other route.
  it('keys a tool result by its tool_use_id', () => {
    const events = replay(TWO_MESSAGE_TURN).flatMap((event) =>
      event.type === 'message' && event.message.kind === 'toolResult' ? [event.message.id] : [],
    );
    expect(events).toEqual(['tool_result:toolu_1']);
  });
});

describe('buildClaudeSessionFromText', () => {
  // upstream: "builds a transcript from Claude session jsonl text"
  it('builds a transcript with cwd, branch and timestamps', () => {
    const session = buildClaudeSessionFromText({
      path: '/tmp/session.jsonl',
      sessionId: 'session-1',
      text: [
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-14T15:00:00.000Z',
          cwd: '/tmp/worktrees/claude-feature',
          gitBranch: 'claude-feature',
          message: { role: 'user', content: 'Inspect the failing tests\n' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-thinking',
          timestamp: '2026-04-14T15:00:01.000Z',
          message: {
            id: 'msg_A',
            role: 'assistant',
            stop_reason: null,
            content: [{ type: 'text', text: 'Let me inspect that.' }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1',
          timestamp: '2026-04-14T15:00:05.000Z',
          message: {
            id: 'msg_B',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'The failure comes from the stale snapshot.' }],
          },
        }),
      ].join('\n'),
    });

    expect(session).toEqual({
      sessionId: 'session-1',
      cwd: '/tmp/worktrees/claude-feature',
      path: '/tmp/session.jsonl',
      gitBranch: 'claude-feature',
      createdAt: '2026-04-14T15:00:00.000Z',
      lastSeenAt: '2026-04-14T15:00:05.000Z',
      messages: [
        {
          id: 'user-1',
          turnId: 'user-1',
          role: 'user',
          kind: 'text',
          text: 'Inspect the failing tests',
          createdAt: '2026-04-14T15:00:00.000Z',
        },
        {
          id: 'msg_A:0',
          turnId: 'user-1',
          role: 'assistant',
          kind: 'text',
          text: 'Let me inspect that.',
          createdAt: '2026-04-14T15:00:01.000Z',
        },
        {
          id: 'msg_B:0',
          turnId: 'user-1',
          role: 'assistant',
          kind: 'text',
          text: 'The failure comes from the stale snapshot.',
          createdAt: '2026-04-14T15:00:05.000Z',
        },
      ],
    });
  });

  // upstream: "surfaces tool_use and tool_result blocks as intermediate messages"
  // The case that pins the numbering: one API message split across two records
  // must index its blocks 0 and 1, not 0 and 0.
  it('numbers blocks per API message across records', () => {
    const session = buildClaudeSessionFromText({
      path: '/tmp/session.jsonl',
      sessionId: 'session-2',
      text: [
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-14T15:00:00.000Z',
          cwd: '/tmp',
          message: { role: 'user', content: 'Read foo.txt' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1a',
          timestamp: '2026-04-14T15:00:01.000Z',
          message: {
            id: 'msg_A',
            role: 'assistant',
            stop_reason: null,
            content: [{ type: 'text', text: 'Reading the file.' }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1b',
          timestamp: '2026-04-14T15:00:01.500Z',
          message: {
            id: 'msg_A',
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Read',
                input: { file_path: '/tmp/foo.txt' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'tool-result-1',
          timestamp: '2026-04-14T15:00:02.000Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'hello world' }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-2',
          timestamp: '2026-04-14T15:00:03.000Z',
          message: {
            id: 'msg_B',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'It says hello world.' }],
          },
        }),
      ].join('\n'),
    });

    expect(session.messages).toEqual([
      {
        id: 'user-1',
        turnId: 'user-1',
        role: 'user',
        kind: 'text',
        text: 'Read foo.txt',
        createdAt: '2026-04-14T15:00:00.000Z',
      },
      {
        id: 'msg_A:0',
        turnId: 'user-1',
        role: 'assistant',
        kind: 'text',
        text: 'Reading the file.',
        createdAt: '2026-04-14T15:00:01.000Z',
      },
      {
        id: 'msg_A:1',
        turnId: 'user-1',
        role: 'assistant',
        kind: 'toolUse',
        toolName: 'Read',
        toolCallId: 'tool-1',
        text: '{"file_path":"/tmp/foo.txt"}',
        createdAt: '2026-04-14T15:00:01.500Z',
      },
      {
        id: 'tool_result:tool-1',
        turnId: 'user-1',
        role: 'user',
        kind: 'toolResult',
        toolCallId: 'tool-1',
        text: 'hello world',
        createdAt: '2026-04-14T15:00:02.000Z',
      },
      {
        id: 'msg_B:0',
        turnId: 'user-1',
        role: 'assistant',
        kind: 'text',
        text: 'It says hello world.',
        createdAt: '2026-04-14T15:00:03.000Z',
      },
    ]);
  });

  // New: a skipped block still advances the counter, or the persisted id of the
  // block after it would not match the one the live stream minted.
  it('advances the block index over a block it does not render', () => {
    const session = buildClaudeSessionFromText({
      path: '/tmp/s.jsonl',
      sessionId: 's',
      text: [
        JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          message: {
            id: 'msg_A',
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm' },
              { type: 'text', text: 'answer' },
            ],
          },
        }),
      ].join('\n'),
    });
    expect(session.messages[1]?.id).toBe('msg_A:1');
  });

  // New: records before the first user prompt have no turn to belong to.
  it('drops assistant records that precede the first user prompt', () => {
    const session = buildClaudeSessionFromText({
      path: '/tmp/s.jsonl',
      sessionId: 's',
      text: JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'orphan' }] },
      }),
    });
    expect(session.messages).toEqual([]);
  });

  // New: a corrupt line is skipped and reported by count, never by content —
  // a transcript line is user and model text, and telemetry here is redacted.
  it('skips a corrupt line and reports it without quoting it', () => {
    const warnings: string[] = [];
    const session = buildClaudeSessionFromText({
      path: '/tmp/s.jsonl',
      sessionId: 's',
      warn: (message) => warnings.push(message),
      text: [
        JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } }),
        '{"type":"assistant", truncated',
      ].join('\n'),
    });
    expect(session.messages).toHaveLength(1);
    expect(warnings).toEqual(['[agents] skipped 1 unparseable Claude transcript line(s)']);
    expect(warnings[0]).not.toContain('truncated');
  });

  it('reports no warning for a transcript with no corrupt lines', () => {
    const warnings: string[] = [];
    buildClaudeSessionFromText({
      path: '/tmp/s.jsonl',
      sessionId: 's',
      warn: (message) => warnings.push(message),
      text: JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } }),
    });
    expect(warnings).toEqual([]);
  });

  it('tolerates an empty transcript', () => {
    const session = buildClaudeSessionFromText({ path: '/tmp/s.jsonl', sessionId: 's', text: '' });
    expect(session).toEqual({
      sessionId: 's',
      cwd: '',
      path: '/tmp/s.jsonl',
      gitBranch: null,
      createdAt: null,
      lastSeenAt: null,
      messages: [],
    });
  });
});

describe('toClaudeConversationState', () => {
  // New: the shape both providers share. A conversation read from disk is by
  // definition finished, so nothing in it is `inProgress`.
  it('numbers messages by position and marks them completed', () => {
    const state = toClaudeConversationState(
      buildClaudeSessionFromText({
        path: '/tmp/s.jsonl',
        sessionId: 'sess',
        text: [
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            cwd: '/tmp/wt',
            message: { role: 'user', content: 'go' },
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'a1',
            message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
          }),
        ].join('\n'),
      }),
      { conversationId: 'pending', cwd: '/fallback' },
    );

    expect(state.provider).toBe('claudeCode');
    expect(state.conversationId).toBe('sess');
    expect(state.cwd).toBe('/tmp/wt');
    expect(state.running).toBe(false);
    expect(state.activeTurnId).toBeNull();
    expect(state.messages.map((message) => [message.order, message.status])).toEqual([
      [0, 'completed'],
      [1, 'completed'],
    ]);
  });

  it('falls back to the caller ids when there is no conversation yet', () => {
    const state = toClaudeConversationState(null, { conversationId: 'pending', cwd: '/fallback' });
    expect(state.conversationId).toBe('pending');
    expect(state.cwd).toBe('/fallback');
    expect(state.messages).toEqual([]);
  });
});

describe('createClaudeConversationGateway', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-claude-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeTranscript(dir: string, sessionId: string, cwd: string): Promise<string> {
    const target = join(home, '.claude', 'projects', dir);
    await mkdir(target, { recursive: true });
    const path = join(target, `${sessionId}.jsonl`);
    await writeFile(
      path,
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        cwd,
        timestamp: '2026-04-14T15:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      }),
    );
    return path;
  }

  // New: no upstream test touched the filesystem at all.
  it('lists the conversations recorded under the encoded directory', async () => {
    const cwd = '/tmp/wt/alpha';
    await writeTranscript(encodeClaudeProjectDir(cwd), 'sess-1', cwd);
    const gateway = createClaudeConversationGateway({ home });

    const sessions = await gateway.listSessions(cwd);
    expect(sessions.map((session) => session.sessionId)).toEqual(['sess-1']);
    expect(sessions[0]?.cwd).toBe(cwd);
  });

  // The encoding is lossy and has changed between releases, so a miss on the
  // encoded directory is not proof there is no conversation. The fallback reads
  // each file's own recorded cwd instead of trusting the directory name.
  it('falls back to a broad scan when the encoded directory has nothing', async () => {
    const cwd = '/tmp/wt/beta';
    await writeTranscript('some-other-encoding', 'sess-2', cwd);
    const gateway = createClaudeConversationGateway({ home });

    expect((await gateway.listSessions(cwd)).map((s) => s.sessionId)).toEqual(['sess-2']);
    expect((await gateway.readSession('sess-2', cwd))?.cwd).toBe(cwd);
  });

  it('returns an empty list when nothing was ever recorded', async () => {
    expect(await createClaudeConversationGateway({ home }).listSessions('/nowhere')).toEqual([]);
  });

  it('reads a conversation by id', async () => {
    const cwd = '/tmp/wt/gamma';
    const path = await writeTranscript(encodeClaudeProjectDir(cwd), 'sess-3', cwd);
    const session = await createClaudeConversationGateway({ home }).readSession('sess-3', cwd);
    expect(session?.path).toBe(path);
    expect(session?.messages).toHaveLength(1);
  });

  it('returns null for a conversation id that is not on disk', async () => {
    expect(
      await createClaudeConversationGateway({ home }).readSession('absent', '/tmp'),
    ).toBeNull();
  });
});
