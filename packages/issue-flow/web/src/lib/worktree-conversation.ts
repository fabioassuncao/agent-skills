import type { AgentsUiConversationMessage, AgentsUiConversationState } from './types';

function compareMessagesByOrder(
  left: AgentsUiConversationMessage,
  right: AgentsUiConversationMessage,
): number {
  return left.order - right.order;
}

function orderConversationMessages(
  messages: AgentsUiConversationMessage[],
): AgentsUiConversationMessage[] {
  return [...messages].sort(compareMessagesByOrder);
}

function nextMessageOrder(conversation: AgentsUiConversationState): number {
  return conversation.messages.reduce((order, message) => Math.max(order, message.order + 1), 0);
}

function buildOptimisticUserMessage(
  turnId: string,
  text: string,
  order: number,
): AgentsUiConversationMessage {
  return {
    id: `pending-user:${turnId}`,
    turnId,
    order,
    role: 'user',
    kind: 'text',
    text,
    status: 'completed',
    createdAt: new Date().toISOString(),
  };
}

function isOptimisticUserMessage(message: AgentsUiConversationMessage): boolean {
  return message.role === 'user' && message.id.startsWith('pending-user:');
}

function isServerUserForPendingTurn(
  pendingMessage: AgentsUiConversationMessage,
  incomingMessage: AgentsUiConversationMessage,
): boolean {
  return (
    incomingMessage.role === 'user' &&
    incomingMessage.kind === 'text' &&
    pendingMessage.turnId === incomingMessage.turnId
  );
}

export function mergeConversationSnapshot(
  current: AgentsUiConversationState | null,
  incoming: AgentsUiConversationState,
): AgentsUiConversationState {
  const orderedIncoming = {
    ...incoming,
    messages: orderConversationMessages(incoming.messages),
  };

  if (
    !current ||
    current.conversationId !== incoming.conversationId ||
    current.provider !== incoming.provider
  ) {
    return orderedIncoming;
  }

  const incomingUserMessages = orderedIncoming.messages.filter(
    (message) => message.role === 'user',
  );
  const messages = [...orderedIncoming.messages];
  let nextOrder = messages.reduce((order, message) => Math.max(order, message.order + 1), 0);
  let preservedOptimisticTurnId: string | null = null;

  for (const currentMessage of current.messages) {
    if (!isOptimisticUserMessage(currentMessage)) continue;
    const serverMessageArrived = incomingUserMessages.some((message) =>
      isServerUserForPendingTurn(currentMessage, message),
    );
    if (serverMessageArrived) continue;

    messages.push({
      ...currentMessage,
      order: nextOrder,
    });
    nextOrder += 1;
    preservedOptimisticTurnId = currentMessage.turnId;
  }

  return {
    ...orderedIncoming,
    running: orderedIncoming.running || preservedOptimisticTurnId !== null,
    activeTurnId: orderedIncoming.activeTurnId ?? preservedOptimisticTurnId,
    messages: orderConversationMessages(messages),
  };
}

export function markConversationTurnStarted(
  conversation: AgentsUiConversationState | null,
  turnId: string,
  text: string,
): AgentsUiConversationState | null {
  if (!conversation) return conversation;

  const nextMessages = conversation.messages.some(
    (message) => message.turnId === turnId && message.role === 'user',
  )
    ? conversation.messages
    : [
        ...conversation.messages,
        buildOptimisticUserMessage(turnId, text, nextMessageOrder(conversation)),
      ];

  return {
    ...conversation,
    running: true,
    activeTurnId: turnId,
    messages: orderConversationMessages(nextMessages),
  };
}

export function buildConversationProgressSignature(
  conversation: AgentsUiConversationState | null,
): string | null {
  if (!conversation) return null;

  const messages = conversation.messages;
  const lastMessage = messages[messages.length - 1] ?? null;
  return JSON.stringify({
    conversationId: conversation.conversationId,
    running: conversation.running,
    activeTurnId: conversation.activeTurnId,
    messageCount: messages.length,
    lastMessageId: lastMessage?.id ?? null,
    lastMessageStatus: lastMessage?.status ?? null,
    lastMessageTextLength: lastMessage?.text.length ?? 0,
  });
}
