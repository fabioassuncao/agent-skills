/**
 * The structured conversation channel's message shape.
 *
 * ADR-06 makes the terminal and the structured chat **independent channels**.
 * The terminal channel carries bytes; this one carries messages, and a message
 * is what the panel renders, what an export writes and what a reader keys by
 * id. Both providers normalise into this single shape so the consumer never
 * branches on which agent produced the turn.
 *
 * ## Why this lives here and not in the contract package
 *
 * The identical shape already exists in `@issue-flow/contract`
 * (`AgentsUiConversationMessage`), which is where it belongs once the two
 * packages can share it: the panel is its other end. `packages/issue-flow`
 * does not depend on that package today — only `web/` does — and the contract
 * is pinned to zod 3 while this package is on zod 4, so importing it here
 * would drag a second zod into the CLI's dependency graph for a type.
 *
 * The two definitions are therefore kept **structurally identical on purpose**:
 * every field below has the same name, order and optionality as the contract's,
 * so a value produced here is assignable to the contract's type without a cast
 * the day the dependency is added. Anything added to one must be added to the
 * other in the same change.
 *
 * ## Conversation content is data, never instruction
 *
 * Everything in a `ConversationMessage` was written by a model or read back
 * from a provider's transcript. Re-injecting it into a prompt without saying so
 * is prompt injection with the attacker already inside the pipeline — the same
 * rule `agents/handoff/types.ts` states for handoffs. `export.ts` is the only
 * module here that re-injects, and it fences and labels what it injects.
 */

export type ConversationMessageRole = 'user' | 'assistant';

export type ConversationMessageStatus = 'completed' | 'inProgress' | 'failed';

export type ConversationMessageKind = 'text' | 'thinking' | 'toolUse' | 'toolResult';

/** Which provider's conversation this is. Mirrors the contract's enum. */
export type ConversationProvider = 'codexAppServer' | 'claudeCode';

export interface ConversationMessage {
  /**
   * Stable across the live stream and the recorded transcript.
   *
   * For Claude this is `${anthropicMessageId}:${contentBlockIndex}` — see
   * `claude.ts`, where losing it is the bug §45.2-A exists to prevent. For
   * Codex it is the app-server item id.
   */
  id: string;
  /** The user turn this belongs to. Groups a prompt with everything it caused. */
  turnId: string;
  /** Position in the conversation. The panel sorts by this, not by arrival. */
  order: number;
  role: ConversationMessageRole;
  text: string;
  status: ConversationMessageStatus;
  createdAt: string | null;
  kind: ConversationMessageKind;
  /** Provider-specific phase label (Codex `analysis` renders as thinking). */
  phase?: string;
  toolName?: string;
  /** Correlates a `toolResult` back to the `toolUse` that produced it. */
  toolCallId?: string;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  durationMs?: number | null;
}

export interface ConversationState {
  provider: ConversationProvider;
  /** The provider's own conversation id — what `--resume` takes. */
  conversationId: string;
  cwd: string;
  running: boolean;
  activeTurnId: string | null;
  messages: ConversationMessage[];
}

/**
 * Sort by `order`, without mutating the input.
 *
 * The panel's reducer sorts too; doing it here as well is what lets a caller
 * hand a snapshot straight to a renderer that does not. Sorting is stable, so
 * two messages sharing an order keep the order they were built in.
 */
export function orderConversationMessages(
  messages: readonly ConversationMessage[],
): ConversationMessage[] {
  return [...messages].sort((left, right) => left.order - right.order);
}

/** How many distinct user turns a conversation contains. */
export function countConversationTurns(conversation: ConversationState): number {
  return new Set(conversation.messages.map((message) => message.turnId)).size;
}
