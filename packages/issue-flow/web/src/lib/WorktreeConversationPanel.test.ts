import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorktree as createBaseWorktree } from './test-fixtures';
import type { AgentsUiConversationState, WorktreeInfo } from './types';
import WorktreeConversationPanel from './WorktreeConversationPanel.svelte';

/**
 * PORT of `frontend/src/lib/WorktreeConversationPanel.test.ts` @ d8c9d5f — 14
 * cases. Interface strings are pt-BR; conversation payloads are data and stay
 * as they were.
 */

function createWorktree(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return createBaseWorktree('feature/mobile-chat', {
    mux: '✓',
    elapsed: '1m',
    agentName: 'claude',
    agentLabel: 'Claude',
    ...overrides,
  });
}

function createConversation(
  overrides: Partial<AgentsUiConversationState> = {},
): AgentsUiConversationState {
  return {
    provider: 'claudeCode',
    conversationId: 'session-1',
    cwd: '/repo/__worktrees/feature/mobile-chat',
    running: false,
    activeTurnId: null,
    messages: [],
    ...overrides,
  };
}

function renderPanel({
  worktree = createWorktree(),
  conversation = createConversation(),
  conversationError = null,
  composerText = '',
  isSending = false,
  onAnswerQuestion = vi.fn(),
}: {
  worktree?: WorktreeInfo;
  conversation?: AgentsUiConversationState | null;
  conversationError?: string | null;
  composerText?: string;
  isSending?: boolean;
  onAnswerQuestion?: (text: string) => void;
} = {}) {
  const onInterrupt = vi.fn();

  render(WorktreeConversationPanel, {
    props: {
      worktree,
      conversation,
      conversationError,
      conversationLoading: false,
      composerText,
      isSending,
      onAttach: vi.fn(),
      onComposerInput: vi.fn(),
      onInterrupt,
      onRefresh: vi.fn(),
      onSend: vi.fn(),
      onAnswerQuestion,
    },
  });

  return { onInterrupt, onAnswerQuestion };
}

describe('WorktreeConversationPanel', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows an interrupt button in the normal running state', async () => {
    const { onInterrupt } = renderPanel({
      conversation: createConversation({
        running: true,
        activeTurnId: 'turn-1',
      }),
    });

    const interruptButton = screen.getByRole('button', { name: 'Interromper' });
    expect(interruptButton).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar' })).not.toBeInTheDocument();

    await fireEvent.click(interruptButton);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('does not show the old status header above the transcript', () => {
    renderPanel();

    expect(screen.queryByText('Pronto')).not.toBeInTheDocument();
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
  });

  it('keeps the interrupt button inside the error banner when the conversation is running', () => {
    renderPanel({
      conversation: createConversation({
        running: true,
        activeTurnId: 'turn-1',
      }),
      conversationError: 'O fluxo da conversa foi desconectado.',
    });

    expect(screen.getByText('O fluxo da conversa foi desconectado.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Interromper' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconectar' })).toBeInTheDocument();
  });

  it('shows only the send button when idle', () => {
    renderPanel();

    expect(screen.getByRole('button', { name: 'Enviar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Interromper' })).not.toBeInTheDocument();
  });

  it('does not duplicate the stale terminal banner inside chat', () => {
    renderPanel({
      worktree: createWorktree({ agentTerminalStale: true }),
    });

    expect(screen.queryByText('Terminal desatualizado')).not.toBeInTheDocument();
  });

  it('renders thinking and tool blocks', () => {
    renderPanel({
      conversation: createConversation({
        messages: [
          {
            id: 'thinking-1',
            turnId: 'turn-1',
            order: 0,
            role: 'assistant',
            kind: 'thinking',
            text: 'I will inspect the directory.',
            status: 'completed',
            createdAt: null,
          },
          {
            id: 'call-1',
            turnId: 'turn-1',
            order: 1,
            role: 'assistant',
            kind: 'toolUse',
            toolName: 'shell',
            toolCallId: 'call-1',
            text: 'ls',
            status: 'completed',
            createdAt: null,
            cwd: '/repo/__worktrees/feature/mobile-chat',
            exitCode: 0,
            durationMs: 4,
          },
          {
            id: 'call-1:result',
            turnId: 'turn-1',
            order: 2,
            role: 'user',
            kind: 'toolResult',
            toolCallId: 'call-1',
            text: 'README.md',
            status: 'completed',
            createdAt: null,
          },
        ],
      }),
    });

    expect(screen.getByText('Raciocínio')).toBeInTheDocument();
    expect(screen.getByText('I will inspect the directory.')).toBeInTheDocument();
    expect(screen.getByText('Concluído shell')).toBeInTheDocument();
    expect(screen.getAllByText('ls')).toHaveLength(2);
    expect(screen.getByText('Saída')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.queryByText('/repo/__worktrees/feature/mobile-chat')).not.toBeInTheDocument();

    const toolBlock = screen.getByText('Concluído shell').closest('details');
    expect(toolBlock).toHaveTextContent('ls');
    expect(toolBlock).toHaveTextContent('README.md');
    expect(toolBlock?.querySelector('details')).toBeNull();
  });

  it('renders an AskUserQuestion tool as a clickable question card', () => {
    renderPanel({
      conversation: createConversation({
        messages: [
          {
            id: 'ask-1',
            turnId: 'turn-1',
            order: 0,
            role: 'assistant',
            kind: 'toolUse',
            toolName: 'AskUserQuestion',
            toolCallId: 'ask-1',
            text: JSON.stringify({
              questions: [
                {
                  question: 'Do you prefer cats or dogs?',
                  header: 'Pet type',
                  multiSelect: false,
                  options: [{ label: 'Cats' }, { label: 'Dogs' }],
                },
              ],
            }),
            status: 'completed',
            createdAt: null,
          },
          {
            id: 'tool_result:ask-1',
            turnId: 'turn-1',
            order: 1,
            role: 'user',
            kind: 'toolResult',
            toolCallId: 'ask-1',
            text: 'Answer questions?',
            status: 'failed',
            createdAt: null,
          },
        ],
      }),
    });

    expect(screen.getByText('Do you prefer cats or dogs?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cats' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dogs' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Resposta livre…')).toBeInTheDocument();
    expect(screen.queryByText('Answer questions?')).not.toBeInTheDocument();
    expect(screen.queryByText('Falhou AskUserQuestion')).not.toBeInTheDocument();
  });

  function askQuestionConversation(running: boolean): AgentsUiConversationState {
    return createConversation({
      running,
      activeTurnId: running ? 'turn-1' : null,
      messages: [
        {
          id: 'ask-1',
          turnId: 'turn-1',
          order: 0,
          role: 'assistant',
          kind: 'toolUse',
          toolName: 'AskUserQuestion',
          toolCallId: 'ask-1',
          text: JSON.stringify({
            questions: [
              {
                question: 'Do you prefer cats or dogs?',
                header: 'Pet type',
                multiSelect: false,
                options: [{ label: 'Cats' }, { label: 'Dogs' }],
              },
            ],
          }),
          status: 'completed',
          createdAt: null,
        },
      ],
    });
  }

  it('answers through onAnswerQuestion when a question option is clicked', async () => {
    const onAnswerQuestion = vi.fn();
    renderPanel({ onAnswerQuestion, conversation: askQuestionConversation(false) });

    await fireEvent.click(screen.getByRole('button', { name: 'Cats' }));

    expect(onAnswerQuestion).toHaveBeenCalledWith('Pet type: Cats');
  });

  it('keeps the question card answerable while the turn is still running', async () => {
    const onAnswerQuestion = vi.fn();
    renderPanel({ onAnswerQuestion, conversation: askQuestionConversation(true) });

    const option = screen.getByRole('button', { name: 'Cats' });
    expect(option).not.toBeDisabled();

    await fireEvent.click(option);
    expect(onAnswerQuestion).toHaveBeenCalledWith('Pet type: Cats');
  });

  it('shows a processing indicator before visible progress arrives', () => {
    renderPanel({
      conversation: createConversation({
        running: true,
        activeTurnId: 'turn-1',
        messages: [],
      }),
    });

    expect(screen.getByText('Claude está processando')).toBeInTheDocument();
  });

  it('shows a processing indicator while a Codex send is pending', () => {
    renderPanel({
      worktree: createWorktree({ agentName: 'codex', agentLabel: 'Codex' }),
      conversation: createConversation({
        provider: 'codexAppServer',
        conversationId: 'thread-1',
      }),
      composerText: 'Ship it',
      isSending: true,
    });

    expect(screen.getByText('Codex está processando')).toBeInTheDocument();
  });

  it('keeps the processing indicator while the interrupt button is visible', () => {
    renderPanel({
      worktree: createWorktree({ agentName: 'codex', agentLabel: 'Codex' }),
      conversation: createConversation({
        provider: 'codexAppServer',
        running: true,
        activeTurnId: 'turn-1',
        messages: [
          {
            id: 'assistant-1',
            turnId: 'turn-1',
            order: 0,
            role: 'assistant',
            kind: 'text',
            text: 'I am checking the files.',
            status: 'inProgress',
            createdAt: null,
          },
        ],
      }),
    });

    expect(screen.getByRole('button', { name: 'Interromper' })).toBeInTheDocument();
    expect(screen.getByText('Codex está processando')).toBeInTheDocument();
  });

  it('does not render blank assistant bubbles for empty streamed starts', () => {
    renderPanel({
      worktree: createWorktree({ agentName: 'codex', agentLabel: 'Codex' }),
      conversation: createConversation({
        provider: 'codexAppServer',
        running: true,
        activeTurnId: 'turn-1',
        messages: [
          {
            id: 'assistant-empty',
            turnId: 'turn-1',
            order: 0,
            role: 'assistant',
            kind: 'text',
            text: '',
            status: 'inProgress',
            createdAt: null,
          },
        ],
      }),
    });

    expect(screen.getByText('Codex está processando')).toBeInTheDocument();
    expect(screen.queryByText('typing')).not.toBeInTheDocument();
  });

  it('keeps the processing indicator for empty Codex tool starts', () => {
    renderPanel({
      worktree: createWorktree({ agentName: 'codex', agentLabel: 'Codex' }),
      conversation: createConversation({
        provider: 'codexAppServer',
        running: true,
        activeTurnId: 'turn-1',
        messages: [
          {
            id: 'call-1',
            turnId: 'turn-1',
            order: 0,
            role: 'assistant',
            kind: 'toolUse',
            toolName: 'shell',
            toolCallId: 'call-1',
            text: '',
            status: 'inProgress',
            createdAt: null,
          },
        ],
      }),
    });

    expect(screen.getByText('Codex está processando')).toBeInTheDocument();
  });
});
