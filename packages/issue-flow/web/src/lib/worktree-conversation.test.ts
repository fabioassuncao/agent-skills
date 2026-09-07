import { describe, expect, it } from 'vitest';
import type { AgentsUiConversationState } from './types';
import {
  buildConversationProgressSignature,
  markConversationTurnStarted,
  mergeConversationSnapshot,
} from './worktree-conversation';

function makeConversation(): AgentsUiConversationState {
  return {
    provider: 'codexAppServer',
    conversationId: 'thread-1',
    cwd: '/tmp/worktree',
    running: false,
    activeTurnId: null,
    messages: [
      {
        id: 'user-1',
        turnId: 'turn-1',
        order: 0,
        role: 'user',
        kind: 'text',
        text: 'Inspect the diff',
        status: 'completed',
        createdAt: '2026-04-15T10:00:00.000Z',
      },
    ],
  };
}

describe('worktree conversation helpers', () => {
  it('adds an optimistic user message when a turn starts', () => {
    const started = markConversationTurnStarted(makeConversation(), 'turn-2', 'Ship it');

    expect(started).toMatchObject({
      running: true,
      activeTurnId: 'turn-2',
    });
    expect(started?.messages.at(-1)).toMatchObject({
      id: 'pending-user:turn-2',
      turnId: 'turn-2',
      text: 'Ship it',
    });
  });

  it('preserves an optimistic message until the server records that turn', () => {
    const current = markConversationTurnStarted(makeConversation(), 'turn-2', 'Ship it');
    const merged = mergeConversationSnapshot(current, makeConversation());

    expect(merged.messages.some((message) => message.id === 'pending-user:turn-2')).toBe(true);
    expect(merged.running).toBe(true);
    expect(merged.activeTurnId).toBe('turn-2');
  });

  it('replaces an optimistic message with the matching server message', () => {
    const current = markConversationTurnStarted(makeConversation(), 'turn-2', 'Ship it');
    const merged = mergeConversationSnapshot(current, {
      ...makeConversation(),
      messages: [
        ...makeConversation().messages,
        {
          id: 'user-2',
          turnId: 'turn-2',
          order: 1,
          role: 'user',
          kind: 'text',
          text: 'Ship it',
          status: 'completed',
          createdAt: '2026-05-28T13:00:00.000Z',
        },
      ],
    });

    expect(merged.messages.filter((message) => message.text === 'Ship it')).toHaveLength(1);
    expect(merged.messages.at(-1)?.id).toBe('user-2');
  });

  it('does not match identical text from another turn', () => {
    const current = markConversationTurnStarted(makeConversation(), 'client-turn', 'Ship it');
    const merged = mergeConversationSnapshot(current, {
      ...makeConversation(),
      messages: [
        ...makeConversation().messages,
        {
          id: 'server-user',
          turnId: 'server-turn',
          order: 1,
          role: 'user',
          kind: 'text',
          text: 'Ship it',
          status: 'completed',
          createdAt: '2026-05-28T13:00:00.000Z',
        },
      ],
    });

    expect(merged.messages.filter((message) => message.text === 'Ship it')).toHaveLength(2);
  });

  it('treats server snapshots as authoritative for assistant messages', () => {
    const current: AgentsUiConversationState = {
      ...makeConversation(),
      running: true,
      activeTurnId: 'turn-2',
      messages: [
        ...makeConversation().messages,
        {
          id: 'assistant-2',
          turnId: 'turn-2',
          order: 1,
          role: 'assistant',
          kind: 'text',
          text: 'Still working',
          status: 'inProgress',
          createdAt: null,
        },
      ],
    };
    const incoming: AgentsUiConversationState = {
      ...makeConversation(),
      messages: [
        ...makeConversation().messages,
        {
          id: 'assistant-2',
          turnId: 'turn-2',
          order: 1,
          role: 'assistant',
          kind: 'text',
          text: 'Done',
          status: 'completed',
          createdAt: '2026-05-28T13:00:00.000Z',
        },
      ],
    };

    expect(mergeConversationSnapshot(current, incoming).messages.at(-1)?.text).toBe('Done');
  });

  it('changes the progress signature when the conversation advances', () => {
    const started = markConversationTurnStarted(makeConversation(), 'turn-2', 'Ship it');

    expect(buildConversationProgressSignature(started)).not.toBe(
      buildConversationProgressSignature(makeConversation()),
    );
  });
});
