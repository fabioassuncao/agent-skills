import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  type ClaudeStreamBlock,
  compactToolPayload,
  extractToolResultText,
  parseClaudeStreamLine,
} from './claude-stream.js';
import type {
  ConversationMessage,
  ConversationMessageKind,
  ConversationState,
} from './conversation.js';

/**
 * Reading a Claude conversation — the structured channel's Claude half.
 *
 * ## What this adds that `core/stream.ts` does not
 *
 * `core/stream.ts` reads the stream of an invocation **this process started**,
 * and answers one question: how did the turn end. It has no memory across
 * lines, no notion of a message, and nothing to say about a conversation that
 * finished yesterday.
 *
 * This module answers the questions the panel asks instead:
 *
 * - read a **recorded** conversation back from the provider's transcript
 *   (`~/.claude/projects/<encoded cwd>/<session id>.jsonl`);
 * - list the conversations that exist for a working directory, so a session can
 *   be resumed by id rather than started again;
 * - turn a live stream into ordered messages with **stable identities**, so the
 *   same block arriving by both routes renders once.
 *
 * It **delegates** the grammar of a line to `claude-stream.ts`, which
 * `core/stream.ts` also uses. There is one parser for the format; what differs
 * is what each reader takes from it (invariant 13).
 *
 * ## The rule that is invisible until it breaks (§45.2-A)
 *
 * A block's identity is `${anthropicMessageId}:${contentBlockIndex}`.
 * `content_block.index` restarts at 0 on every `message_start`, and one user
 * turn routinely spans several API messages, so the index alone collides and
 * two separate paragraphs collapse into one bubble. The transcript reader
 * reproduces the same numbering — counting **every** block of a message, even
 * the ones it skips — so an id minted from the file equals the id minted from
 * the stream. That equality is the whole mechanism: it is what lets the panel
 * upsert instead of append when a block it already streamed shows up again in
 * the persisted transcript.
 *
 * ## ADR-05 is not violated by any of this
 *
 * Reading the provider's own conversation file is not reading the agent's
 * *screen*. Workflow state still comes from hooks (`agents/hooks/`); nothing
 * here decides whether a phase passed. This is a reader for a panel and for an
 * export, and its output is data.
 */

/** A message as the transcript stores it, before it is placed in a conversation. */
export interface ClaudeTranscriptMessage {
  id: string;
  turnId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string | null;
  kind: ConversationMessageKind;
  toolName?: string;
  toolCallId?: string;
}

/** A whole conversation, read back from one `.jsonl` transcript. */
export interface ClaudeStoredConversation {
  sessionId: string;
  cwd: string;
  path: string;
  gitBranch: string | null;
  createdAt: string | null;
  lastSeenAt: string | null;
  messages: ClaudeTranscriptMessage[];
}

/** Enough to list a conversation without reading it. */
export interface ClaudeConversationSummary {
  sessionId: string;
  cwd: string;
  path: string;
  lastSeenAt: string;
}

interface ClaudeStoredRecord {
  cwd?: unknown;
  gitBranch?: unknown;
  message?: unknown;
  sessionId?: unknown;
  timestamp?: unknown;
  type?: unknown;
  uuid?: unknown;
}

interface ClaudeStoredMessage {
  content?: unknown;
  id?: unknown;
  role?: unknown;
  stop_reason?: unknown;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function readString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * How Claude names the directory it keeps a project's conversations in.
 *
 * Every character that is not alphanumeric becomes `-`, which is lossy: two
 * different paths can encode to the same directory. That is the provider's
 * scheme, not a choice made here, and it is why the lookups below fall back to
 * a broader scan instead of trusting the encoded path alone.
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function isTopLevelClaudeUserPrompt(raw: ClaudeStoredRecord): raw is ClaudeStoredRecord & {
  message: ClaudeStoredMessage & { content: string; role: 'user' };
  type: 'user';
  uuid: string;
} {
  if (raw.type !== 'user' || !isRecord(raw.message)) return false;
  return (
    raw.message.role === 'user' &&
    typeof raw.message.content === 'string' &&
    typeof raw.uuid === 'string' &&
    raw.message.content.trim().length > 0
  );
}

function isClaudeUserToolResultRecord(raw: ClaudeStoredRecord): raw is ClaudeStoredRecord & {
  message: ClaudeStoredMessage & { content: unknown[]; role: 'user' };
  type: 'user';
  uuid: string;
} {
  if (raw.type !== 'user' || !isRecord(raw.message)) return false;
  return (
    raw.message.role === 'user' &&
    Array.isArray(raw.message.content) &&
    typeof raw.uuid === 'string'
  );
}

function isClaudeAssistantRecord(raw: ClaudeStoredRecord): raw is ClaudeStoredRecord & {
  message: ClaudeStoredMessage & { role: 'assistant' };
  type: 'assistant';
  uuid: string;
} {
  if (raw.type !== 'assistant' || !isRecord(raw.message)) return false;
  return raw.message.role === 'assistant' && typeof raw.uuid === 'string';
}

/**
 * How a corrupt transcript line is reported.
 *
 * The upstream logs the first 120 characters of the offending line. A
 * conversation line is user and model content, and this project's telemetry is
 * redacted by contract (§45.3), so the default says *that* a line failed and
 * where — never what it contained. A caller that is debugging can pass its own.
 */
export type ClaudeTranscriptWarn = (message: string) => void;

const NO_WARNING: ClaudeTranscriptWarn = () => {};

function parseClaudeSessionRecords(text: string, warn: ClaudeTranscriptWarn): ClaudeStoredRecord[] {
  let skipped = 0;
  const records = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ClaudeStoredRecord];
      } catch {
        // The prefix filter already drops obvious non-JSON noise, so anything
        // reaching here is a corrupt record — a partial write or a truncated
        // file. Silence would make that indistinguishable from a short session.
        skipped += 1;
        return [];
      }
    });
  if (skipped > 0) warn(`[agents] skipped ${skipped} unparseable Claude transcript line(s)`);
  return records;
}

/**
 * Rebuild a conversation from the transcript's text.
 *
 * Pure, so the whole of the identity rule is testable without a filesystem.
 */
export function buildClaudeSessionFromText(input: {
  path: string;
  sessionId: string;
  text: string;
  warn?: ClaudeTranscriptWarn;
}): ClaudeStoredConversation {
  const records = parseClaudeSessionRecords(input.text, input.warn ?? NO_WARNING);
  const messages: ClaudeTranscriptMessage[] = [];
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let createdAt: string | null = null;
  let lastSeenAt: string | null = null;
  let currentTurnId: string | null = null;

  // Content-block index per Anthropic message id, mirroring the live stream's
  // `content_block.index`. Every block of a message advances the counter (even
  // skipped thinking/empty blocks) so persisted ids line up with live ids.
  const blockIndexByMessage = new Map<string, number>();
  const nextBlockIndex = (messageId: string): number => {
    const index = blockIndexByMessage.get(messageId) ?? 0;
    blockIndexByMessage.set(messageId, index + 1);
    return index;
  };

  for (const record of records) {
    cwd ??= readString(record.cwd);
    gitBranch ??= readString(record.gitBranch);
    if (!createdAt) createdAt = readString(record.timestamp);
    lastSeenAt = readString(record.timestamp) ?? lastSeenAt;

    if (isTopLevelClaudeUserPrompt(record)) {
      // A top-level user prompt opens a turn: everything until the next one
      // belongs to it, which is what groups a prompt with what it caused.
      currentTurnId = record.uuid;
      messages.push({
        id: record.uuid,
        turnId: record.uuid,
        role: 'user',
        kind: 'text',
        text: record.message.content.trim(),
        createdAt: readString(record.timestamp),
      });
      continue;
    }

    // Anything before the first user prompt has no turn to belong to.
    if (!currentTurnId) continue;

    if (isClaudeUserToolResultRecord(record)) {
      for (const entry of record.message.content) {
        if (!isRecord(entry) || entry.type !== 'tool_result') continue;
        const text = extractToolResultText(entry.content);
        if (text.length === 0) continue;
        const toolCallId = readString(entry.tool_use_id);
        messages.push({
          // Keyed by the call it answers, so it upserts over the streamed copy.
          id: `tool_result:${toolCallId ?? `${record.uuid}`}`,
          turnId: currentTurnId,
          role: 'user',
          kind: 'toolResult',
          ...(toolCallId ? { toolCallId } : {}),
          text,
          createdAt: readString(record.timestamp),
        });
      }
      continue;
    }

    if (!isClaudeAssistantRecord(record)) continue;
    if (!Array.isArray(record.message.content)) continue;
    const messageId = readString(record.message.id) ?? record.uuid;

    for (const block of record.message.content) {
      if (!isRecord(block)) continue;
      // Advanced for every block, including the ones skipped below: the live
      // stream counts them too, and an index that skipped would not match.
      const index = nextBlockIndex(messageId);
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text.trim();
        if (text.length === 0) continue;
        messages.push({
          id: `${messageId}:${index}`,
          turnId: currentTurnId,
          role: 'assistant',
          kind: 'text',
          text,
          createdAt: readString(record.timestamp),
        });
        continue;
      }
      if (block.type === 'tool_use') {
        const toolName = typeof block.name === 'string' ? block.name : 'tool';
        const toolCallId = readString(block.id);
        messages.push({
          id: `${messageId}:${index}`,
          turnId: currentTurnId,
          role: 'assistant',
          kind: 'toolUse',
          toolName,
          ...(toolCallId ? { toolCallId } : {}),
          text: compactToolPayload(block.input ?? {}),
          createdAt: readString(record.timestamp),
        });
      }
    }
  }

  return {
    sessionId: input.sessionId,
    cwd: cwd ?? '',
    path: input.path,
    gitBranch,
    createdAt,
    lastSeenAt,
    messages,
  };
}

// ── Live stream → messages with stable identities ──────────────────────────

/** A finalised content block, stamped with the id the panel keys it by. */
export interface ClaudeStreamMessage {
  id: string;
  role: 'user' | 'assistant';
  kind: ConversationMessageKind;
  text: string;
  createdAt: string | null;
  toolName?: string;
  toolCallId?: string;
}

export type ClaudeStreamEvent =
  | { type: 'sessionId'; sessionId: string }
  | { type: 'delta'; itemId: string; delta: string }
  | { type: 'message'; message: ClaudeStreamMessage }
  | { type: 'complete'; sessionId: string }
  | { type: 'error'; message: string };

/** The message/block currently being streamed. See §45.2-A. */
interface ClaudeStreamCursor {
  messageId: string | null;
  blockIndex: number;
}

function toStreamMessage(
  block: ClaudeStreamBlock,
  cursor: ClaudeStreamCursor,
): ClaudeStreamMessage {
  const id =
    block.kind === 'toolResult'
      ? `tool_result:${block.toolCallId ?? `${cursor.messageId ?? 'msg'}:${cursor.blockIndex}`}`
      : `${block.messageId ?? cursor.messageId ?? 'msg'}:${cursor.blockIndex}`;
  return {
    id,
    role: block.role,
    kind: block.kind,
    text: block.text,
    createdAt: block.createdAt,
    ...(block.toolName ? { toolName: block.toolName } : {}),
    ...(block.toolCallId ? { toolCallId: block.toolCallId } : {}),
  };
}

export interface ClaudeStreamReader {
  /** Feed one raw stream line. A line that is not JSON yields no events. */
  read(line: string): ClaudeStreamEvent[];
  /** The session id, once any line has carried one. */
  readonly sessionId: string | null;
}

/**
 * A stateful reader over the live stream.
 *
 * The state is the cursor and nothing else, and it is the reason this cannot be
 * a pure function: `message_start` and `content_block_start` arrive on their own
 * lines, before the deltas and the finalised blocks they identify.
 *
 * It does **not** start a process. Launching an agent is `agents/invoke.ts`
 * (headless) or `agents/tty.ts` (interactive) — one launcher, per §25 — and
 * this reader consumes whatever those produce.
 */
export function createClaudeStreamReader(): ClaudeStreamReader {
  const cursor: ClaudeStreamCursor = { messageId: null, blockIndex: 0 };
  let sessionId: string | null = null;

  return {
    get sessionId() {
      return sessionId;
    },
    read(line: string): ClaudeStreamEvent[] {
      const parsed = parseClaudeStreamLine(line);
      if (!parsed) return [];
      const events: ClaudeStreamEvent[] = [];

      if (parsed.sessionId !== null && parsed.sessionId !== sessionId) {
        sessionId = parsed.sessionId;
        events.push({ type: 'sessionId', sessionId: parsed.sessionId });
      }
      // `blockIndex` is deliberately *not* reset here, matching the upstream:
      // every message that emits a block is preceded by its own
      // `content_block_start`, which sets the index. Resetting would look
      // tidier and would change the id of a block that arrives without one.
      if (parsed.messageStart) cursor.messageId = parsed.messageStart.messageId;
      if (parsed.blockStart) cursor.blockIndex = parsed.blockStart.index;
      if (parsed.assistantDelta) {
        events.push({
          type: 'delta',
          itemId: `${cursor.messageId ?? 'msg'}:${parsed.assistantDelta.blockIndex}`,
          delta: parsed.assistantDelta.delta,
        });
      }
      for (const block of parsed.blocks) {
        events.push({ type: 'message', message: toStreamMessage(block, cursor) });
      }
      if (parsed.completeSessionId) {
        events.push({ type: 'complete', sessionId: parsed.completeSessionId });
      }
      if (parsed.error) events.push({ type: 'error', message: parsed.error });

      return events;
    },
  };
}

// ── The recorded-conversation gateway ──────────────────────────────────────

export interface ClaudeConversationGateway {
  /** Conversations recorded for this working directory, newest first. */
  listSessions(cwd: string): Promise<ClaudeConversationSummary[]>;
  /** One conversation by its provider id, or `null` when it is not on disk. */
  readSession(sessionId: string, cwd: string): Promise<ClaudeStoredConversation | null>;
}

export interface ClaudeConversationGatewayOptions {
  /** Where `~/.claude` lives. Injected so a test never touches a real home. */
  home?: string;
  warn?: ClaudeTranscriptWarn;
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

export function createClaudeConversationGateway(
  options: ClaudeConversationGatewayOptions = {},
): ClaudeConversationGateway {
  const warn = options.warn ?? NO_WARNING;
  const projectsRoot = join(options.home ?? homedir(), '.claude', 'projects');

  const readSessionFile = async (filePath: string): Promise<ClaudeStoredConversation | null> => {
    try {
      const text = await readFile(filePath, 'utf8');
      return buildClaudeSessionFromText({
        path: filePath,
        sessionId: basename(filePath, '.jsonl'),
        text,
        warn,
      });
    } catch {
      return null;
    }
  };

  const summarize = async (
    filePaths: string[],
    cwd: string,
  ): Promise<ClaudeConversationSummary[]> => {
    const items = await Promise.all(
      filePaths.map(async (filePath) => {
        const info = await stat(filePath).catch(() => null);
        if (!info) return null;
        return {
          sessionId: basename(filePath, '.jsonl'),
          cwd,
          path: filePath,
          lastSeenAt: info.mtime.toISOString(),
        };
      }),
    );
    return items
      .filter((item): item is ClaudeConversationSummary => item !== null)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  };

  return {
    async listSessions(cwd: string): Promise<ClaudeConversationSummary[]> {
      const primaryFiles = await listJsonlFiles(join(projectsRoot, encodeClaudeProjectDir(cwd)));
      if (primaryFiles.length > 0) return await summarize(primaryFiles, cwd);

      // The encoding is lossy and Claude has changed it between releases, so a
      // miss on the encoded directory is not proof there is no conversation.
      // The broad scan reads each file's own recorded `cwd` instead of trusting
      // the directory name.
      const projectDirs = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
      const matched: string[] = [];
      for (const entry of projectDirs) {
        if (!entry.isDirectory()) continue;
        for (const filePath of await listJsonlFiles(join(projectsRoot, entry.name))) {
          const session = await readSessionFile(filePath);
          if (session?.cwd === cwd) matched.push(filePath);
        }
      }
      return await summarize(matched, cwd);
    },

    async readSession(sessionId: string, cwd: string): Promise<ClaudeStoredConversation | null> {
      const primaryPath = join(projectsRoot, encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
      if (
        await stat(primaryPath).then(
          () => true,
          () => false,
        )
      ) {
        return await readSessionFile(primaryPath);
      }

      // Same reason as above: the conversation may have been recorded under a
      // differently encoded directory, and its id is unique across all of them.
      const projectDirs = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of projectDirs) {
        if (!entry.isDirectory()) continue;
        const candidate = join(projectsRoot, entry.name, `${sessionId}.jsonl`);
        if (
          await stat(candidate).then(
            () => true,
            () => false,
          )
        ) {
          return await readSessionFile(candidate);
        }
      }
      return null;
    },
  };
}

/**
 * Lift a recorded conversation into the shape both providers share.
 *
 * `order` is the position in the file and `status` is `completed`, because a
 * conversation read from disk is by definition one that is no longer being
 * written. A live turn's `inProgress` comes from the stream reader instead.
 */
export function toClaudeConversationState(
  conversation: ClaudeStoredConversation | null,
  fallback: { conversationId: string; cwd: string },
): ConversationState {
  const messages: ConversationMessage[] = (conversation?.messages ?? []).map(
    (message, order): ConversationMessage => ({
      ...message,
      order,
      status: 'completed',
    }),
  );
  return {
    provider: 'claudeCode',
    conversationId: conversation?.sessionId ?? fallback.conversationId,
    cwd: conversation?.cwd || fallback.cwd,
    running: false,
    activeTurnId: null,
    messages,
  };
}
