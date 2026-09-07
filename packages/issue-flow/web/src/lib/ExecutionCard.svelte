<script lang="ts">
  import AgentStatusIcon, { executionStatusToAgentStatus } from './AgentStatusIcon.svelte';
  import { formatAgo, formatDuration, truncateText } from './format';
  import type { SessionSummary } from './types';
  import { AGENT_LIFECYCLE_LABELS } from './vocabulary';

  /**
   * One execution, on the dashboard (U1).
   *
   * PORT of `buildSessionCard`. A `<button>`, like the Kanban card and for the
   * same reason — so everything inside it is phrasing content.
   *
   * The metadata row is not decoration: a card that shows only a percentage
   * cannot tell a run that is progressing from one that has been retrying for
   * twenty minutes, which is the question somebody opens this screen to answer.
   */

  const DESCRIPTION_PREVIEW = 140;

  let {
    session,
    now,
    onselect,
  }: { session: SessionSummary; now: number; onselect: (sessionId: string) => void } = $props();

  let percent = $derived(Math.max(0, Math.min(100, session.progressPercent ?? 0)));

  let elapsed = $derived(
    session.elapsedSeconds !== null
      ? formatDuration(session.elapsedSeconds)
      : session.startedAt !== null
        ? formatAgo(session.startedAt, now)
        : '—',
  );

  let escalated = $derived(session.awaitingInputEscalatedAt !== null);
</script>

<button
  type="button"
  class="if-execution-card"
  data-session-id={session.sessionId}
  onclick={() => {
    if (session.sessionId) onselect(session.sessionId);
  }}
>
  <span class="if-card-head">
    <span class="if-card-project">{session.repositoryName ?? 'Projeto desconhecido'}</span>
    {#if session.humanHold}
      <span class="if-badge if-badge-run">em controle humano</span>
    {/if}
    {#if escalated}
      <span class="if-badge if-badge-error">ninguém respondeu</span>
    {:else if session.agentLifecycle === 'awaiting-input'}
      <span class="if-badge if-badge-warn">{AGENT_LIFECYCLE_LABELS['awaiting-input']}</span>
    {/if}
    <AgentStatusIcon pill status={executionStatusToAgentStatus(session.status)} />
  </span>

  <span class="if-card-title-row">
    {#if session.issueNumber !== null}
      <span class="if-card-issue">#{session.issueNumber}</span>
    {/if}
    <span class="if-card-title">{session.issueTitle ?? 'Sem título'}</span>
  </span>

  <span class="if-card-summary if-muted"
    >{truncateText(session.issueDescription, DESCRIPTION_PREVIEW) || 'Sem descrição'}</span
  >

  <span class="if-card-meta">
    <span>Fase: {session.currentPhase ?? '—'}</span>
    <span>{percent}%</span>
    <span>{elapsed}</span>
    {#if session.retries !== null && session.retries > 0}
      <span>{session.retries} retry(s)</span>
    {/if}
    {#if session.correctionCycle !== null && session.correctionCycle > 0}
      <span>correção {session.correctionCycle}</span>
    {/if}
    {#if session.lastActivityAt ?? session.updatedAt}
      <span>atividade {formatAgo(session.lastActivityAt ?? session.updatedAt, now)}</span>
    {/if}
    {#if session.provider}<span>provider {session.provider}</span>{/if}
    {#if session.attempt !== null && session.attempt > 0}
      <span>tentativa {session.attempt}</span>
    {/if}
  </span>

  <span class="if-card-progress">
    <span class="if-card-progress-bar" style={`width: ${percent}%`}></span>
  </span>

  {#if session.status === 'running'}
    <span class="if-card-live">
      <span class="if-live" aria-hidden="true"></span>
      ao vivo
    </span>
  {/if}
</button>

<style>
  .if-execution-card {
    display: grid;
    justify-items: start;
    gap: var(--space-8);
    text-align: left;
    width: 100%;
    min-width: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-medium);
    box-shadow: var(--shadow);
    padding: var(--space-16);
    font: inherit;
    color: var(--text);
    cursor: pointer;
  }

  .if-execution-card:hover {
    border-color: var(--border-strong);
  }

  .if-card-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8);
    width: 100%;
    min-width: 0;
  }

  .if-card-project {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    overflow-wrap: anywhere;
  }

  .if-card-title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-8);
    min-width: 0;
  }

  .if-card-issue {
    color: var(--accent);
    font-size: var(--font-size-md);
  }

  .if-card-title {
    font-size: var(--font-size-lg);
    overflow-wrap: anywhere;
  }

  .if-card-summary {
    font-size: var(--font-size-md);
    overflow-wrap: anywhere;
  }

  .if-card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4) var(--space-12);
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    min-width: 0;
  }

  .if-card-progress {
    display: block;
    width: 100%;
    height: var(--space-4);
    background: var(--surface-sunken);
    border-radius: var(--radius-pill);
    overflow: hidden;
  }

  .if-card-progress-bar {
    display: block;
    height: 100%;
    background: var(--state-run);
  }

  .if-card-live {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    font-size: var(--font-size-sm);
    color: var(--state-run);
  }

  .if-badge-run {
    background: var(--state-run-surface);
    color: var(--state-run);
  }

  .if-badge-warn {
    background: var(--state-warn-surface);
    color: var(--state-warn);
  }

  .if-badge-error {
    background: var(--state-error-surface);
    color: var(--state-error);
  }
</style>
