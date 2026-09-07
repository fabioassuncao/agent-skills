import type { ConversationMessageKind } from './conversation.js';

/** A parsed content block, before a reader stamps it with its stable id. */
export interface ClaudeStreamBlock {
  role: 'user' | 'assistant';
  kind: ConversationMessageKind;
  text: string;
  createdAt: string | null;
  /** The Anthropic message id, when the record carried one. */
  messageId: string | null;
  toolName?: string;
  toolCallId?: string;
}

export interface ParsedClaudeStreamLine {
  /** The Claude session id, present on nearly every line once it is known. */
  sessionId: string | null;
  /** A new API message started; resets the block index. */
  messageStart: { messageId: string } | null;
  /** A new content block started, at this index within the current message. */
  blockStart: { index: number } | null;
  /** Partial assistant text for the block at `blockIndex`. */
  assistantDelta: { delta: string; blockIndex: number } | null;
  /** Finalised content blocks carried by an `assistant` or `user` record. */
  blocks: ClaudeStreamBlock[];
  /** Set on a successful `result` line — the turn is over and this is its id. */
  completeSessionId: string | null;

  result: { text: string; isError: boolean } | null;
  /** A human-readable error from a `result` with `is_error`, or an `error` line. */
  error: string | null;
}

interface ClaudeStreamRecord {
  [key: string]: unknown;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function readString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function readNumber(raw: unknown): number | null {
  return typeof raw === 'number' ? raw : null;
}

/**
 * How much of a tool payload is kept.
 *
 * A single `Read` of a large file would otherwise put megabytes into a message
 * the panel has to render and an export has to write. The suffix counts what
 * was dropped so the reader can tell a truncated payload from a short one.
 */
export const TOOL_PAYLOAD_TRUNCATE_LIMIT = 2000;

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, limit = TOOL_PAYLOAD_TRUNCATE_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (truncated, ${text.length - limit} more chars)`;
}

/**
 * Render a tool call's input the one way both readers must render it.
 *
 * The live stream and the persisted transcript carry the same `tool_use` block,
 * and the panel upserts one over the other by id. Two truncation rules would
 * make the two copies differ by their tail, which shows up as a block that
 * rewrites itself when the transcript is read back.
 */
export function compactToolPayload(value: unknown): string {
  return truncate(compactJson(value));
}

/**
 * Read a `tool_result` payload, which is a string in some turns and an array of
 * content blocks in others. Both shapes are real; neither is a bug to reject.
 */
export function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return truncate(content.trim());
  if (!Array.isArray(content)) return truncate(compactJson(content));
  const text = content
    .map((entry) => {
      if (!isRecord(entry)) return '';
      if (entry.type === 'text' && typeof entry.text === 'string') return entry.text;
      return compactJson(entry);
    })
    .join('')
    .trim();
  return truncate(text);
}

function buildBlocksFromAssistantRecord(raw: Record<string, unknown>): ClaudeStreamBlock[] {
  if (!isRecord(raw.message)) return [];
  const message = raw.message;
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  // The record's own uuid is the fallback identity for a build that omits the
  // API message id; without it the whole message would key as `msg`.
  const messageId = readString(message.id) ?? readString(raw.uuid);

  return message.content.flatMap((block): ClaudeStreamBlock[] => {
    if (!isRecord(block)) return [];
    const createdAt = readString(raw.timestamp);
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text.length === 0) return [];
      return [{ messageId, role: 'assistant', kind: 'text', text, createdAt }];
    }
    if (block.type === 'tool_use') {
      const toolName = typeof block.name === 'string' ? block.name : 'tool';
      const toolCallId = readString(block.id) ?? undefined;
      return [
        {
          messageId,
          role: 'assistant',
          kind: 'toolUse',
          toolName,
          ...(toolCallId ? { toolCallId } : {}),
          text: truncate(compactJson(block.input ?? {})),
          createdAt,
        },
      ];
    }
    return [];
  });
}

function buildBlocksFromUserRecord(raw: Record<string, unknown>): ClaudeStreamBlock[] {
  if (!isRecord(raw.message)) return [];
  const message = raw.message;
  if (message.role !== 'user' || !Array.isArray(message.content)) return [];

  return message.content.flatMap((block): ClaudeStreamBlock[] => {
    if (!isRecord(block) || block.type !== 'tool_result') return [];
    const text = extractToolResultText(block.content);
    if (text.length === 0) return [];
    const toolCallId = readString(block.tool_use_id) ?? undefined;
    return [
      {
        // A tool result carries no message id of its own: it is correlated by
        // `tool_use_id`, which is what makes it findable from its tool call.
        messageId: null,
        role: 'user',
        kind: 'toolResult',
        ...(toolCallId ? { toolCallId } : {}),
        text,
        createdAt: readString(raw.timestamp),
      },
    ];
  });
}

const EMPTY_LINE: ParsedClaudeStreamLine = {
  sessionId: null,
  messageStart: null,
  blockStart: null,
  assistantDelta: null,
  blocks: [],
  completeSessionId: null,
  result: null,
  error: null,
};

/**
 * Read one already-decoded stream record.
 *
 * An unrecognised `type` returns the empty shape rather than `null`: a newer
 * CLI emitting an event this release has never seen is not a parse failure, and
 * treating it as one would make every reader log a warning per line.
 */
export function parseClaudeStreamRecord(parsed: ClaudeStreamRecord): ParsedClaudeStreamLine {
  const base: ParsedClaudeStreamLine = { ...EMPTY_LINE, sessionId: readString(parsed.session_id) };

  if (parsed.type === 'stream_event' && isRecord(parsed.event)) {
    const event = parsed.event;
    if (event.type === 'message_start' && isRecord(event.message)) {
      const messageId = readString(event.message.id);
      return messageId ? { ...base, messageStart: { messageId } } : base;
    }
    if (event.type === 'content_block_start') {
      const index = readNumber(event.index);
      return index !== null ? { ...base, blockStart: { index } } : base;
    }
    if (
      event.type === 'content_block_delta' &&
      isRecord(event.delta) &&
      event.delta.type === 'text_delta'
    ) {
      const delta = readString(event.delta.text);
      const blockIndex = readNumber(event.index);
      if (delta !== null && blockIndex !== null) {
        return { ...base, assistantDelta: { delta, blockIndex } };
      }
    }
    return base;
  }

  if (parsed.type === 'assistant') {
    return { ...base, blocks: buildBlocksFromAssistantRecord(parsed) };
  }

  if (parsed.type === 'user') {
    return { ...base, blocks: buildBlocksFromUserRecord(parsed) };
  }

  if (parsed.type === 'result') {
    const isError = parsed.is_error === true;
    return {
      ...base,
      // An errored turn has no session to resume into, so it never completes.
      completeSessionId: isError ? null : readString(parsed.session_id),
      result: { text: typeof parsed.result === 'string' ? parsed.result : '', isError },
      error: isError ? (readString(parsed.result) ?? 'Claude returned an error') : null,
    };
  }

  if (parsed.type === 'error') {
    return { ...base, error: readString(parsed.message) ?? 'Claude returned an error' };
  }

  return base;
}

/** Read one raw line. `null` means it was not JSON, or not an object. */
export function parseClaudeStreamLine(line: string): ParsedClaudeStreamLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return parseClaudeStreamRecord(parsed);
}
