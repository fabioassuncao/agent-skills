<script lang="ts">
  import { onMount } from 'svelte';
  import WorktreeConversationPanel from './WorktreeConversationPanel.svelte';
  import {
    attachWorktreeConversation,
    fetchWorktreeConversationHistory,
    interruptWorktreeConversation,
    sendWorktreeConversationMessage,
  } from './api';
  import type {
    AgentsUiConversationState,
    AgentsUiWorktreeConversationResponse,
    WorktreeInfo,
  } from './types';
  import {
    buildConversationProgressSignature,
    markConversationTurnStarted,
    mergeConversationSnapshot,
  } from './worktree-conversation';

  /** The structured chat surface used on mobile and terminal-free desktop. */

  interface Props {
    worktree: WorktreeInfo;
    onConversationMessageSent?: () => void;
  }

  const { worktree, onConversationMessageSent = () => {} }: Props = $props();

  let conversation = $state<AgentsUiConversationState | null>(null);
  let conversationError = $state<string | null>(null);
  let conversationLoading = $state(false);
  let composerText = $state('');
  let isSending = $state(false);
  let isAnsweringQuestion = $state(false);
  let refreshPollingState = $state<{
    token: number;
    baselineSignature: string | null;
    lastSignature: string | null;
    sawProgress: boolean;
    unchangedTicks: number;
    stopWhenIdle: boolean;
  } | null>(null);
  let nextRefreshPollingToken = 1;

  const REFRESH_POLL_INTERVAL_MS = 1000;
  const REFRESH_POLL_SETTLE_TICKS = 3;

  function applyConversationResponse(response: AgentsUiWorktreeConversationResponse): void {
    conversation = mergeConversationSnapshot(conversation, response.conversation);
    conversationError = null;
  }

  function requestConversation(
    mode: 'attach' | 'history',
  ): Promise<AgentsUiWorktreeConversationResponse> {
    return mode === 'attach'
      ? attachWorktreeConversation(worktree.branch)
      : fetchWorktreeConversationHistory(worktree.branch);
  }

  async function loadConversation(mode: 'attach' | 'history'): Promise<void> {
    conversationLoading = true;
    conversationError = null;

    try {
      const response = await requestConversation(mode);
      applyConversationResponse(response);
    } catch (error) {
      conversationError = error instanceof Error ? error.message : String(error);
    } finally {
      conversationLoading = false;
    }
  }

  function startRefreshPolling(
    baselineConversation: AgentsUiConversationState | null = conversation,
    stopWhenIdle = false,
  ): void {
    const baselineSignature = buildConversationProgressSignature(baselineConversation);
    refreshPollingState = {
      token: nextRefreshPollingToken,
      baselineSignature,
      lastSignature: baselineSignature,
      sawProgress: false,
      unchangedTicks: 0,
      stopWhenIdle,
    };
    nextRefreshPollingToken += 1;
  }

  function updateRefreshPollingState(
    token: number,
    nextConversation: AgentsUiConversationState,
  ): void {
    const currentState = refreshPollingState;
    if (!currentState || currentState.token !== token) return;

    // Terminal-owned turns settle when the worktree agent goes idle (handled by
    // the busy-poll effect below), not via the message-progress heuristic used
    // for sends.
    if (currentState.stopWhenIdle) return;

    const nextSignature = buildConversationProgressSignature(nextConversation);
    const sawProgress =
      currentState.sawProgress || nextSignature !== currentState.baselineSignature;
    const unchangedTicks =
      nextSignature === currentState.lastSignature ? currentState.unchangedTicks + 1 : 0;

    if (sawProgress && unchangedTicks >= REFRESH_POLL_SETTLE_TICKS) {
      refreshPollingState = null;
      return;
    }

    refreshPollingState = {
      ...currentState,
      lastSignature: nextSignature,
      sawProgress,
      unchangedTicks,
    };
  }

  async function sendConversationText(text: string): Promise<boolean> {
    if (!conversation) return false;
    const baselineConversation = conversation;
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;

    isSending = true;
    conversationError = null;
    try {
      const response = await sendWorktreeConversationMessage(worktree.branch, { text: trimmed });
      if (conversation.conversationId !== response.conversationId) {
        conversation = {
          ...conversation,
          conversationId: response.conversationId,
        };
      }
      conversation = markConversationTurnStarted(conversation, response.turnId, trimmed);
      startRefreshPolling(baselineConversation);
      onConversationMessageSent();
      return true;
    } catch (error) {
      conversationError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      isSending = false;
    }
  }

  async function sendSelectedConversationMessage(): Promise<void> {
    if (composerText.trim().length === 0) return;
    const sent = await sendConversationText(composerText);
    if (sent) composerText = '';
  }

  async function interruptSelectedConversation(): Promise<void> {
    const baselineConversation = conversation;
    conversationError = null;
    try {
      await interruptWorktreeConversation(worktree.branch);
      startRefreshPolling(baselineConversation);
    } catch (error) {
      conversationError = error instanceof Error ? error.message : String(error);
    }
  }

  async function answerConversationQuestion(text: string): Promise<void> {
    if (!conversation || isSending || isAnsweringQuestion) return;
    isAnsweringQuestion = true;
    try {
      if (conversation.running) {
        await interruptSelectedConversation();
      }
      await sendConversationText(text);
    } finally {
      isAnsweringQuestion = false;
    }
  }

  onMount(() => {
    void loadConversation('attach');
  });

  $effect(() => {
    const agentBusy = worktree.agent === 'working';
    const isTerminalOwnedClaudeTurn =
      conversation?.provider === 'claudeCode' && conversation.running !== true;

    if (agentBusy && isTerminalOwnedClaudeTurn) {
      if (refreshPollingState === null) {
        startRefreshPolling(conversation, true);
      }
      return;
    }

    if (refreshPollingState?.stopWhenIdle === true) {
      refreshPollingState = null;
    }
  });

  $effect(() => {
    const pollingState = refreshPollingState;
    if (!pollingState) return;

    const token = pollingState.token;
    let requestInFlight = false;

    // `requestInFlight` keeps two polls from overlapping when the server is
    // slower than the interval.
    const interval = window.setInterval(() => {
      if (!refreshPollingState || refreshPollingState.token !== token || requestInFlight) return;
      requestInFlight = true;
      void (async () => {
        try {
          const response = await requestConversation('history');
          applyConversationResponse(response);
          updateRefreshPollingState(token, response.conversation);
        } catch (error) {
          conversationError = error instanceof Error ? error.message : String(error);
        } finally {
          requestInFlight = false;
        }
      })();
    }, REFRESH_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  });
</script>

<WorktreeConversationPanel
  {worktree}
  {conversation}
  {conversationError}
  {conversationLoading}
  {composerText}
  {isSending}
  onAttach={() => void loadConversation('attach')}
  onComposerInput={(value) => {
    composerText = value;
  }}
  onInterrupt={() => void interruptSelectedConversation()}
  onRefresh={() => void loadConversation('history')}
  onSend={() => void sendSelectedConversationMessage()}
  onAnswerQuestion={(text) => void answerConversationQuestion(text)}
/>
