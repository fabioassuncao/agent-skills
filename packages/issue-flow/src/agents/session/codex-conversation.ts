import type {
  CodexAppServerAgentMessageItem,
  CodexAppServerCommandExecutionItem,
  CodexAppServerDynamicToolCallContentItem,
  CodexAppServerDynamicToolCallItem,
  CodexAppServerFileChangeItem,
  CodexAppServerFileUpdateChange,
  CodexAppServerMcpToolCallItem,
  CodexAppServerThread,
  CodexAppServerThreadItem,
  CodexAppServerTurn,
  CodexAppServerUserMessageItem,
  CodexAppServerWebSearchItem,
} from './codex.js';
import type {
  ConversationMessage,
  ConversationMessageStatus,
  ConversationState,
} from './conversation.js';

/**
 * A Codex thread, as the structured channel's shared message shape.
 *
 * ## Why this file exists
 *
 * `codex.ts` speaks the app-server's own vocabulary: threads, turns and a dozen
 * item types. The panel speaks `ConversationMessage`, and so does Claude's half
 * of this channel. Without the translation the port would deliver a typed
 * client that nothing can render — half a channel.
 *
 * §22 assigns only `adapters/codex-app-server.ts` to this phase, so the
 * translation is taken from the **pure half** of the upstream's
 * `services/worktree-conversation-service.ts` (the item → message builders and
 * the turn-status predicates). The stateful service wrapped around them — meta
 * persistence, streaming subscriptions, tab bookkeeping — is not ported here;
 * that file belongs to the panel's own phase and half of it depends on state
 * this project keeps elsewhere.
 *
 * ## What the shapes encode
 *
 * A tool call becomes **two** messages, not one: an assistant `toolUse` and, if
 * there is output, a `toolResult` keyed `${id}:result`. That is what lets a
 * long command's output collapse independently of the command line, and it is
 * why `order` advances by the number of messages an item produced rather than
 * by one per item.
 */

/**
 * Codex reports times in epoch **seconds**; the shared shape carries ISO-8601.
 * Treating the number as milliseconds silently dates every message to 1970.
 */
function toIsoTimestamp(epochSeconds: number | null): string | null {
  if (epochSeconds === null) return null;
  return new Date(epochSeconds * 1000).toISOString();
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function isUserMessageItem(item: CodexAppServerThreadItem): item is CodexAppServerUserMessageItem {
  return item.type === 'userMessage';
}

function isAgentMessageItem(
  item: CodexAppServerThreadItem,
): item is CodexAppServerAgentMessageItem {
  return item.type === 'agentMessage';
}

function isCommandExecutionItem(
  item: CodexAppServerThreadItem,
): item is CodexAppServerCommandExecutionItem {
  return item.type === 'commandExecution';
}

function isFileChangeItem(item: CodexAppServerThreadItem): item is CodexAppServerFileChangeItem {
  return item.type === 'fileChange';
}

function isMcpToolCallItem(item: CodexAppServerThreadItem): item is CodexAppServerMcpToolCallItem {
  return item.type === 'mcpToolCall';
}

function isDynamicToolCallItem(
  item: CodexAppServerThreadItem,
): item is CodexAppServerDynamicToolCallItem {
  return item.type === 'dynamicToolCall';
}

function isWebSearchItem(item: CodexAppServerThreadItem): item is CodexAppServerWebSearchItem {
  return item.type === 'webSearch';
}

function extractUserText(item: CodexAppServerUserMessageItem): string {
  return item.content
    .map((contentItem) => contentItem.text ?? '')
    .join('')
    .trim();
}

/** Two field names for the same thing across app-server versions. */
function extractAgentText(item: CodexAppServerAgentMessageItem): string {
  return item.text ?? item.message ?? '';
}

/**
 * A command that ran to completion with a non-zero exit is a **failed** message
 * even though the app-server calls the execution `completed` — "the tool
 * finished" and "the command worked" are different questions, and the panel is
 * asking the second one.
 */
function commandExecutionStatus(
  item: CodexAppServerCommandExecutionItem,
): ConversationMessageStatus {
  switch (item.status) {
    case 'inProgress':
      return 'inProgress';
    case 'completed':
      return item.exitCode !== null && item.exitCode !== 0 ? 'failed' : 'completed';
    default:
      return 'failed';
  }
}

function commandExecutionDisplayText(item: CodexAppServerCommandExecutionItem): string {
  const commands = item.commandActions
    .map((action) => action.command ?? '')
    .filter((command) => command.length > 0);
  return commands.length > 0 ? commands.join(' && ') : item.command;
}

function toolStatus(
  status: 'inProgress' | 'completed' | 'failed' | 'declined',
): ConversationMessageStatus {
  switch (status) {
    case 'inProgress':
      return 'inProgress';
    case 'completed':
      return 'completed';
    default:
      return 'failed';
  }
}

function jsonDisplayText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
}

function patchChangeLabel(change: CodexAppServerFileUpdateChange): string {
  switch (change.kind.type) {
    case 'add':
      return `add ${change.path}`;
    case 'delete':
      return `delete ${change.path}`;
    default:
      return change.kind.move_path
        ? `move ${change.kind.move_path} -> ${change.path}`
        : `update ${change.path}`;
  }
}

function fileChangeDisplayText(item: CodexAppServerFileChangeItem): string {
  return item.changes.map(patchChangeLabel).join('\n');
}

function fileChangeResultText(item: CodexAppServerFileChangeItem): string {
  return item.changes
    .map((change) => change.diff.trimEnd())
    .filter((diff) => diff.length > 0)
    .join('\n\n');
}

function mcpContentText(content: unknown): string {
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  return jsonDisplayText(content);
}

function mcpToolResultText(item: CodexAppServerMcpToolCallItem): string {
  if (item.error) return item.error.message;
  if (!item.result) return '';

  const parts = (item.result.content as unknown[]).map(mcpContentText);
  if (item.result.structuredContent !== null) {
    parts.push(jsonDisplayText(item.result.structuredContent));
  }
  return parts.join('\n\n').trim();
}

function dynamicToolName(item: CodexAppServerDynamicToolCallItem): string {
  return item.namespace ? `${item.namespace}.${item.tool}` : item.tool;
}

function dynamicToolContentText(content: CodexAppServerDynamicToolCallContentItem): string {
  return content.type === 'inputText' ? content.text : content.imageUrl;
}

function dynamicToolResultText(item: CodexAppServerDynamicToolCallItem): string {
  return (item.contentItems ?? []).map(dynamicToolContentText).join('\n\n').trim();
}

function webSearchDisplayText(item: CodexAppServerWebSearchItem): string {
  const action = item.action;
  if (!action) return item.query;

  switch (action.type) {
    case 'search':
      return action.queries?.join('\n') ?? action.query ?? item.query;
    case 'openPage':
      return action.url ?? item.query;
    case 'findInPage':
      return [action.url, action.pattern].filter((part) => part !== null).join('\n');
    default:
      return item.query;
  }
}

/**
 * Whether a turn is still going.
 *
 * Five spellings on purpose: the app-server's turn status is an open string
 * (see `codex.ts`), and a status this list does not know is treated as finished
 * — which shows a completed message rather than one that spins forever.
 */
export function isActiveTurnStatus(status: string): boolean {
  return (
    status === 'inProgress' ||
    status === 'active' ||
    status === 'running' ||
    status === 'pending' ||
    status === 'queued'
  );
}

/** The last turn that is still running, or `null`. Searched from the end. */
export function findActiveTurn(thread: CodexAppServerThread): CodexAppServerTurn | null {
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const turn = thread.turns[index];
    if (turn && isActiveTurnStatus(turn.status)) return turn;
  }
  return null;
}

interface ItemBuildInput {
  turnId: string;
  createdAt: string | null;
  order: number;
}

function buildCommandExecutionMessages(
  item: CodexAppServerCommandExecutionItem,
  input: ItemBuildInput,
): ConversationMessage[] {
  const { turnId, createdAt, order } = input;
  const status = commandExecutionStatus(item);
  const toolUse: ConversationMessage = {
    id: item.id,
    turnId,
    order,
    role: 'assistant',
    kind: 'toolUse',
    toolName: 'shell',
    toolCallId: item.id,
    text: commandExecutionDisplayText(item),
    command: item.command,
    ...(item.cwd === null ? {} : { cwd: item.cwd }),
    status,
    createdAt,
    exitCode: item.exitCode,
    durationMs: item.durationMs,
  };
  const output = item.aggregatedOutput?.trimEnd() ?? '';
  if (output.length === 0) return [toolUse];

  return [
    toolUse,
    {
      ...toolUse,
      id: `${item.id}:result`,
      order: order + 1,
      role: 'user',
      kind: 'toolResult',
      text: output,
    },
  ];
}

function buildFileChangeMessages(
  item: CodexAppServerFileChangeItem,
  input: ItemBuildInput,
): ConversationMessage[] {
  const { turnId, createdAt, order } = input;
  const status = toolStatus(item.status);
  const toolUse: ConversationMessage = {
    id: item.id,
    turnId,
    order,
    role: 'assistant',
    kind: 'toolUse',
    toolName: 'file change',
    toolCallId: item.id,
    text: fileChangeDisplayText(item),
    status,
    createdAt,
  };
  const resultText = fileChangeResultText(item);
  if (resultText.length === 0) return [toolUse];

  return [
    toolUse,
    {
      ...toolUse,
      id: `${item.id}:result`,
      order: order + 1,
      role: 'user',
      kind: 'toolResult',
      text: resultText,
    },
  ];
}

function buildMcpToolCallMessages(
  item: CodexAppServerMcpToolCallItem,
  input: ItemBuildInput,
): ConversationMessage[] {
  const { turnId, createdAt, order } = input;
  const status = item.error ? 'failed' : toolStatus(item.status);
  const toolName = `${item.server}.${item.tool}`;
  const toolUse: ConversationMessage = {
    id: item.id,
    turnId,
    order,
    role: 'assistant',
    kind: 'toolUse',
    toolName,
    toolCallId: item.id,
    text: jsonDisplayText(item.arguments),
    status,
    createdAt,
    durationMs: item.durationMs,
  };
  const resultText = mcpToolResultText(item);
  if (resultText.length === 0) return [toolUse];

  return [
    toolUse,
    {
      ...toolUse,
      id: `${item.id}:result`,
      order: order + 1,
      role: 'user',
      kind: 'toolResult',
      text: resultText,
    },
  ];
}

function buildDynamicToolCallMessages(
  item: CodexAppServerDynamicToolCallItem,
  input: ItemBuildInput,
): ConversationMessage[] {
  const { turnId, createdAt, order } = input;
  // `success: false` on a "completed" call is still a failure, for the same
  // reason a non-zero exit code is.
  const status = item.success === false ? 'failed' : toolStatus(item.status);
  const toolName = dynamicToolName(item);
  const toolUse: ConversationMessage = {
    id: item.id,
    turnId,
    order,
    role: 'assistant',
    kind: 'toolUse',
    toolName,
    toolCallId: item.id,
    text: jsonDisplayText(item.arguments),
    status,
    createdAt,
    durationMs: item.durationMs,
  };
  const resultText = dynamicToolResultText(item);
  if (resultText.length === 0) return [toolUse];

  return [
    toolUse,
    {
      ...toolUse,
      id: `${item.id}:result`,
      order: order + 1,
      role: 'user',
      kind: 'toolResult',
      text: resultText,
    },
  ];
}

/** Turn one thread item into the zero, one or two messages it renders as. */
export function buildCodexItemConversationMessages(input: {
  item: CodexAppServerThreadItem;
  turnId: string;
  turnStatus: string;
  createdAt: string | null;
  order: number;
  /** Keep a message whose text is empty. Used while a turn is still streaming. */
  includeEmptyText?: boolean;
}): ConversationMessage[] {
  const { item, turnId, turnStatus, createdAt, order, includeEmptyText = false } = input;

  if (isUserMessageItem(item)) {
    const text = extractUserText(item);
    if (text.length === 0 && !includeEmptyText) return [];
    return [
      {
        id: item.id,
        turnId,
        order,
        role: 'user',
        kind: 'text',
        text,
        status: 'completed',
        createdAt,
      },
    ];
  }

  if (isAgentMessageItem(item)) {
    const text = extractAgentText(item);
    if (text.length === 0 && !includeEmptyText) return [];
    const phase = item.phase ?? undefined;
    // Codex labels its own reasoning `analysis`; the panel renders that as
    // thinking rather than as an answer.
    const isThinking = phase === 'analysis';
    return [
      {
        id: item.id,
        turnId,
        order,
        role: 'assistant',
        kind: isThinking ? 'thinking' : 'text',
        ...(phase === undefined ? {} : { phase }),
        text,
        status: isActiveTurnStatus(turnStatus) ? 'inProgress' : 'completed',
        createdAt,
      },
    ];
  }

  const build: ItemBuildInput = { turnId, createdAt, order };
  if (isCommandExecutionItem(item)) return buildCommandExecutionMessages(item, build);
  if (isFileChangeItem(item)) return buildFileChangeMessages(item, build);
  if (isMcpToolCallItem(item)) return buildMcpToolCallMessages(item, build);
  if (isDynamicToolCallItem(item)) return buildDynamicToolCallMessages(item, build);
  if (isWebSearchItem(item)) {
    return [
      {
        id: item.id,
        turnId,
        order,
        role: 'assistant',
        kind: 'toolUse',
        toolName: 'web search',
        toolCallId: item.id,
        text: webSearchDisplayText(item),
        status: 'completed',
        createdAt,
      },
    ];
  }

  // Ignored and unmodelled items render as nothing, on purpose: they are the
  // reason a newer Codex does not break the panel.
  return [];
}

/** Flatten a thread's turns into ordered conversation messages. */
export function buildCodexConversationMessages(
  thread: CodexAppServerThread,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  let order = 0;

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      const itemMessages = buildCodexItemConversationMessages({
        item,
        turnId: turn.id,
        turnStatus: turn.status,
        // A user message is stamped with when the turn started; everything the
        // agent produced is stamped with when it ended, falling back to the
        // start for a turn that has not finished.
        createdAt: toIsoTimestamp(
          isUserMessageItem(item) ? turn.startedAt : (turn.completedAt ?? turn.startedAt),
        ),
        order,
      });
      messages.push(...itemMessages);
      order += itemMessages.length;
    }
  }

  return messages;
}

/** Lift a whole thread into the shape both providers share. */
export function toCodexConversationState(thread: CodexAppServerThread): ConversationState {
  const activeTurn = findActiveTurn(thread);
  return {
    provider: 'codexAppServer',
    conversationId: thread.id,
    cwd: thread.cwd,
    running: activeTurn !== null,
    activeTurnId: activeTurn?.id ?? null,
    messages: buildCodexConversationMessages(thread),
  };
}
