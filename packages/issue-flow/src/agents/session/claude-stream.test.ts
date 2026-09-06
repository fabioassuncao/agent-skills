import { describe, expect, it } from 'vitest';
import {
  extractToolResultText,
  parseClaudeStreamLine,
  parseClaudeStreamRecord,
  TOOL_PAYLOAD_TRUNCATE_LIMIT,
} from './claude-stream.js';

/**
 * Parity suite for the Claude stream grammar.
 *
 * Ported from `.references/webmux-main/backend/src/__tests__/claude-cli.test.ts`
 * (the `parseClaudeStreamLine` half; the transcript half lives in
 * `claude.test.ts`). The expected objects gained one key, `result`, which this
 * project's headless reader needs and the upstream had no use for — see
 * `claude-stream.ts`.
 */

const EMPTY = {
  messageStart: null,
  blockStart: null,
  assistantDelta: null,
  blocks: [],
  completeSessionId: null,
  result: null,
  error: null,
};

describe('parseClaudeStreamLine', () => {
  // upstream: "parses text deltas from Claude stream-json output"
  it('parses text deltas', () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: 'stream_event',
          session_id: 'session-1',
          event: {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'text_delta', text: 'hello' },
          },
        }),
      ),
    ).toEqual({
      ...EMPTY,
      sessionId: 'session-1',
      assistantDelta: { delta: 'hello', blockIndex: 2 },
    });
  });

  // upstream: "surfaces message_start and content_block_start so the client can
  // key blocks" — the pair that makes `${messageId}:${blockIndex}` possible.
  it('surfaces message_start and content_block_start so a reader can key blocks', () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: 'stream_event',
          session_id: 'session-1',
          event: { type: 'message_start', message: { id: 'msg_AAA', role: 'assistant' } },
        }),
      )?.messageStart,
    ).toEqual({ messageId: 'msg_AAA' });

    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: 'stream_event',
          session_id: 'session-1',
          event: { type: 'content_block_start', index: 3, content_block: { type: 'text' } },
        }),
      )?.blockStart,
    ).toEqual({ index: 3 });
  });

  // upstream: "parses finalized text and tool blocks from Claude stream-json output"
  it('parses finalised text and tool_use blocks', () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: 'assistant',
          session_id: 'session-1',
          uuid: 'assistant-1',
          message: {
            id: 'msg_AAA',
            role: 'assistant',
            content: [
              { type: 'text', text: 'Reading the file.' },
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Read',
                input: { file_path: '/tmp/foo.txt' },
              },
            ],
          },
        }),
      )?.blocks,
    ).toEqual([
      {
        messageId: 'msg_AAA',
        role: 'assistant',
        kind: 'text',
        text: 'Reading the file.',
        createdAt: null,
      },
      {
        messageId: 'msg_AAA',
        role: 'assistant',
        kind: 'toolUse',
        toolName: 'Read',
        toolCallId: 'tool-1',
        text: '{"file_path":"/tmp/foo.txt"}',
        createdAt: null,
      },
    ]);
  });

  // upstream: same case, the `user` half — a tool_result correlated by id.
  it('parses tool_result blocks correlated by tool_use_id', () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: 'user',
          session_id: 'session-1',
          uuid: 'tool-result-1',
          timestamp: '2026-04-14T15:00:02.000Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'hello world' }],
          },
        }),
      )?.blocks,
    ).toEqual([
      {
        messageId: null,
        role: 'user',
        kind: 'toolResult',
        toolCallId: 'tool-1',
        text: 'hello world',
        createdAt: '2026-04-14T15:00:02.000Z',
      },
    ]);
  });

  // upstream: "parses errored result lines without completing the session"
  it('does not complete the session on an errored result', () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: 'result',
          session_id: 'session-1',
          is_error: true,
          result: 'API key is invalid',
        }),
      ),
    ).toEqual({
      ...EMPTY,
      sessionId: 'session-1',
      completeSessionId: null,
      result: { text: 'API key is invalid', isError: true },
      error: 'API key is invalid',
    });
  });

  // New: the headless reader's half of the same line. `core/stream.ts` reads
  // `result` from here, which is the whole point of delegating to one grammar.
  it('reports a successful result with its text and its session', () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: 'result',
          session_id: 'session-1',
          is_error: false,
          result: 'done',
        }),
      ),
    ).toEqual({
      ...EMPTY,
      sessionId: 'session-1',
      completeSessionId: 'session-1',
      result: { text: 'done', isError: false },
    });
  });

  // New: a `result` whose payload is not a string still ends the turn.
  it('reports an empty result text when the result field is not a string', () => {
    const parsed = parseClaudeStreamLine(
      JSON.stringify({ type: 'result', session_id: 's', is_error: false, result: { a: 1 } }),
    );
    expect(parsed?.result).toEqual({ text: '', isError: false });
  });

  // New: an errored result with no message still says something usable.
  it('falls back to a generic message for an errored result with no text', () => {
    const parsed = parseClaudeStreamLine(
      JSON.stringify({ type: 'result', session_id: 's', is_error: true }),
    );
    expect(parsed?.error).toBe('Claude returned an error');
  });

  // New: the top-level `error` line, which the upstream parsed but never tested.
  it('parses a top-level error line', () => {
    expect(
      parseClaudeStreamLine(JSON.stringify({ type: 'error', message: 'rate limited' }))?.error,
    ).toBe('rate limited');
  });

  // New: malformed input is data, not an exception. The CLI interleaves its own
  // diagnostics with the stream and a run must survive them.
  it('returns null for a line that is not JSON', () => {
    expect(parseClaudeStreamLine('not json at all')).toBeNull();
  });

  it('returns null for JSON that is not an object', () => {
    expect(parseClaudeStreamLine('42')).toBeNull();
    expect(parseClaudeStreamLine('[1,2]')).toBeNull();
  });

  // New: a newer CLI emitting an unknown event is not a parse failure.
  it('returns the empty shape for an unknown event type', () => {
    expect(parseClaudeStreamLine(JSON.stringify({ type: 'system', session_id: 'x' }))).toEqual({
      ...EMPTY,
      sessionId: 'x',
    });
  });

  it('ignores a content_block_delta that is not a text delta', () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta' } },
        }),
      )?.assistantDelta,
    ).toBeNull();
  });

  it('ignores a message_start with no message id', () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: {} } }),
      )?.messageStart,
    ).toBeNull();
  });

  // New: a text block that is only whitespace is dropped, but it still exists
  // as far as block numbering is concerned — that is the transcript's problem,
  // and `claude.test.ts` covers it.
  it('drops an empty assistant text block', () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: 'assistant',
          message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: '   ' }] },
        }),
      )?.blocks,
    ).toEqual([]);
  });

  // New: the record's own uuid stands in when the API message id is absent.
  it('falls back to the record uuid when the message carries no id', () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: 'assistant',
          uuid: 'rec-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        }),
      )?.blocks[0]?.messageId,
    ).toBe('rec-1');
  });

  it('names an unnamed tool "tool" rather than dropping the call', () => {
    expect(
      parseClaudeStreamLine(
        JSON.stringify({
          type: 'assistant',
          message: { id: 'm', role: 'assistant', content: [{ type: 'tool_use', input: {} }] },
        }),
      )?.blocks[0]?.toolName,
    ).toBe('tool');
  });
});

describe('parseClaudeStreamRecord', () => {
  // New: the entry point `core/stream.ts` uses, so neither reader parses JSON
  // twice for the same line.
  it('reads an already-decoded record without re-parsing JSON', () => {
    expect(
      parseClaudeStreamRecord({ type: 'result', session_id: 's', is_error: false, result: 'ok' })
        .result,
    ).toEqual({ text: 'ok', isError: false });
  });
});

describe('extractToolResultText', () => {
  // upstream: covered indirectly; broken out because both readers depend on the
  // two shapes being accepted.
  it('accepts a string payload', () => {
    expect(extractToolResultText('  hello  ')).toBe('hello');
  });

  it('accepts an array of content blocks', () => {
    expect(
      extractToolResultText([
        { type: 'text', text: 'one ' },
        { type: 'text', text: 'two' },
      ]),
    ).toBe('one two');
  });

  it('serialises a non-text block rather than dropping it', () => {
    expect(extractToolResultText([{ type: 'image', source: 'x' }])).toContain('"image"');
  });

  it('serialises a payload that is neither a string nor an array', () => {
    expect(extractToolResultText({ ok: true })).toBe('{"ok":true}');
  });

  // New: the truncation rule, and the suffix that lets a reader tell a
  // truncated payload from a short one.
  it('truncates a long payload and says how much it dropped', () => {
    const text = 'a'.repeat(TOOL_PAYLOAD_TRUNCATE_LIMIT + 25);
    const result = extractToolResultText(text);
    expect(result.startsWith('a'.repeat(TOOL_PAYLOAD_TRUNCATE_LIMIT))).toBe(true);
    expect(result).toContain('(truncated, 25 more chars)');
  });
});
