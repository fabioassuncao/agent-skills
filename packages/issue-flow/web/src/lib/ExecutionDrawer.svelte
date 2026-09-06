<script module lang="ts">
  export interface DrawerSelection {
    kind: 'phase' | 'story';
    id: string;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import {
    formatClock,
    formatCost,
    formatDuration,
    formatUsage,
    itemSideText,
    metric,
  } from './format';
  import {
    executionsFor,
    getStoryById,
    record,
    type ExecutionSnapshot,
    type SnapshotExecution,
  } from './snapshot';
  import { configSourceLabel, STORY_STAGE_LABELS, STORY_STATUS_LABELS } from './vocabulary';

  /**
   * The details drawer (U12).
   *
   * PORT of `openDrawer`/`renderDrawer`/`drawerSection`/`renderExecutionHistory`/
   * `renderProcessLogs`/`renderGlobalDiagnostics`. One drawer for **both** a
   * phase and a story, and its content is rehydrated from `{kind, id}` on every
   * update rather than captured when it opened — the boards and lists behind it
   * are rebuilt on each refresh, so anything captured would be stale by the
   * next frame, and a story that leaves the plan closes the drawer instead of
   * showing a ghost.
   *
   * `data-story-id` on the Kanban card is how focus returns on close, for the
   * same reason.
   */

  let {
    snapshot,
    selection,
    diagnostics,
    onclose,
  }: {
    snapshot: ExecutionSnapshot;
    selection: DrawerSelection;
    diagnostics: readonly Record<string, unknown>[];
    onclose: () => void;
  } = $props();

  let dialog: HTMLElement | null = $state(null);

  let story = $derived(
    selection.kind === 'story' ? getStoryById(snapshot, selection.id) : null,
  );
  let phase = $derived(
    selection.kind === 'phase'
      ? (snapshot.phases.find((entry) => entry.name === selection.id) ?? null)
      : null,
  );
  let missing = $derived(
    (selection.kind === 'story' && story === null) || (selection.kind === 'phase' && phase === null),
  );

  let executions = $derived(executionsFor(snapshot, selection.kind, selection.id));

  let executionIds = $derived(new Set(executions.map((execution) => execution.id)));

  let processLogs = $derived(
    snapshot.processLogs.filter(
      (entry) =>
        (entry.executionId !== null && executionIds.has(entry.executionId)) ||
        (executionIds.size === 0 &&
          entry.phase === (selection.kind === 'phase' ? selection.id : 'execute')),
    ),
  );

  /**
   * Diagnostics correlated to what the drawer is showing.
   *
   * Three ways in, and all three matter: by execution id (the precise one), by
   * phase, and by the `story` field, which the writer records as a
   * comma-separated list when one invocation covered several stories.
   */
  let correlatedDiagnostics = $derived(
    diagnostics.filter((raw) => {
      const entry = record(raw);
      const executionId = entry.executionId;
      if (typeof executionId === 'string' && executionIds.has(executionId)) return true;
      if (selection.kind === 'phase') return entry.phase === selection.id;
      return typeof entry.story === 'string' && entry.story.split(',').includes(selection.id);
    }),
  );

  let configuredPhase = $derived(
    phase === null
      ? null
      : (snapshot.configuration?.phases.find((entry) => entry.phase === phase.name) ?? null),
  );

  function executionCost(execution: SnapshotExecution): string {
    if (execution.cost.status === 'reported' || execution.cost.status === 'estimated') {
      if (execution.cost.amount === null) return 'não informado';
      return formatCost(execution.cost.amount, execution.cost.status === 'estimated');
    }
    return execution.cost.reason ? `não informado (${execution.cost.reason})` : 'não informado';
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') onclose();
  }

  onMount(() => {
    dialog?.focus();
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  });

  $effect(() => {
    if (missing) onclose();
  });
</script>

{#if !missing}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events (the overlay duplicates the close button and Escape, which both exist) -->
  <div class="if-overlay" onclick={onclose}></div>
  <!--
    A `<div role="dialog">` rather than an `<aside>`: `<aside>` is a
    non-interactive landmark and giving it an interactive role is the a11y rule
    svelte-check flags. The current panel's `<aside id="drawer">` predates the
    check; the port takes the corrected form.
  -->
  <div
    class="if-drawer"
    role="dialog"
    aria-modal="true"
    aria-labelledby="if-drawer-title"
    tabindex="-1"
    bind:this={dialog}
  >
    <div class="if-drawer-head">
      <h2 id="if-drawer-title">
        {#if phase}Fase · {phase.name}{:else if story}{story.id} · {story.title}{/if}
      </h2>
      <button type="button" class="if-drawer-close" aria-label="Fechar detalhes" onclick={onclose}
        >✕</button
      >
    </div>

    <div class="if-drawer-body">
      {#if phase}
        <span class="if-badge if-phase-{phase.status}">{phase.status}</span>
        <dl class="if-grid">
          <dt>Início</dt>
          <dd>{phase.startedAt ? formatClock(phase.startedAt) : '—'}</dd>
          <dt>Fim</dt>
          <dd>{phase.endedAt ? formatClock(phase.endedAt) : '—'}</dd>
          <dt>Duração</dt>
          <dd>{phase.durationSeconds === null ? '—' : formatDuration(phase.durationSeconds)}</dd>
          <dt>Uso total</dt>
          <dd>{formatUsage(phase) || '—'}</dd>
          {#if configuredPhase}
            <dt>Harness efetivo</dt>
            <dd>{configuredPhase.provider.value ?? '—'}</dd>
            <dt>Origem</dt>
            <dd>{configSourceLabel(configuredPhase.provider.source)}</dd>
            <dt>Modelo efetivo</dt>
            <dd>{configuredPhase.model.value ?? 'default do provider'}</dd>
          {/if}
        </dl>
        {#if phase.error}
          <p class="if-drawer-error">{phase.error}</p>
        {/if}
      {:else if story}
        <span class="if-badge if-status-{story.status}">{STORY_STATUS_LABELS[story.status]}</span>
        {#if itemSideText([story.completedAt ? `concluída ${formatClock(story.completedAt)}` : '', story.durationSeconds === null ? '' : formatDuration(story.durationSeconds)])}
          <p class="if-muted">
            {itemSideText([
              story.completedAt ? `concluída ${formatClock(story.completedAt)}` : '',
              story.durationSeconds === null ? '' : formatDuration(story.durationSeconds),
            ])}
          </p>
        {/if}

        <section class="if-drawer-section">
          <h3>Descrição</h3>
          {#if story.description}
            <p class="if-drawer-text">{story.description}</p>
          {:else}
            <p class="if-empty">Sem descrição.</p>
          {/if}
        </section>

        <section class="if-drawer-section">
          <h3>Critérios de aceite</h3>
          {#if story.acceptanceCriteria.length === 0}
            <p class="if-empty">Nenhum critério declarado.</p>
          {:else}
            <ul class="if-drawer-list">
              {#each story.acceptanceCriteria as criterion, index (index)}
                <li>{criterion}</li>
              {/each}
            </ul>
          {/if}
        </section>

        <section class="if-drawer-section">
          <h3>Dependências</h3>
          {#if story.dependencies.length === 0}
            <p class="if-empty">Nenhuma dependência.</p>
          {:else}
            <div class="if-badge-row">
              {#each story.dependencies as dependency (dependency)}
                <span class="if-badge if-label">{dependency}</span>
              {/each}
            </div>
          {/if}
        </section>

        {#if story.history.length > 0}
          <section class="if-drawer-section">
            <h3>Histórico</h3>
            <ol class="if-drawer-list">
              {#each story.history as entry, index (index)}
                <li>
                  {#if entry.at}<span class="if-mono if-muted">{formatClock(entry.at)}</span>{/if}
                  {STORY_STAGE_LABELS[entry.stage as keyof typeof STORY_STAGE_LABELS] ??
                    entry.stage}{entry.detail ? ` · ${entry.detail}` : ''}
                </li>
              {/each}
            </ol>
          </section>
        {/if}
      {/if}

      <section class="if-drawer-section">
        <h3>Tentativas, revisões e correções</h3>
        {#if executions.length === 0}
          <p class="if-empty">Nenhuma invocação associada.</p>
        {:else}
          <ol class="if-timeline">
            {#each [...executions].reverse() as execution (execution.id)}
              <li class="if-timeline-entry">
                <div class="if-timeline-head">
                  <span class="if-badge if-phase-{execution.status}">{execution.status}</span>
                  <strong
                    >{execution.purpose} · tentativa {execution.attempt ?? '—'} · {execution.trigger}</strong
                  >
                </div>
                <dl class="if-grid">
                  <dt>Harness</dt>
                  <dd>{execution.agent.harness ?? '—'}</dd>
                  <dt>Modelo</dt>
                  <dd>{execution.agent.model ?? '—'}</dd>
                  <dt>Início</dt>
                  <dd>{formatClock(execution.startedAt) || '—'}</dd>
                  <dt>Fim</dt>
                  <dd>
                    {execution.finishedAt ? formatClock(execution.finishedAt) : 'em andamento'}
                  </dd>
                  <dt>Duração</dt>
                  <dd>
                    {metric(execution.durationMs) === null
                      ? '—'
                      : formatDuration((execution.durationMs ?? 0) / 1000)}
                  </dd>
                  <dt>Tokens</dt>
                  <dd>{formatUsage(execution.usage) || '—'}</dd>
                  <dt>Custo</dt>
                  <dd>{executionCost(execution)}</dd>
                  {#if execution.correctionCycle !== null && execution.correctionCycle > 0}
                    <dt>Correção</dt>
                    <dd>ciclo {execution.correctionCycle}</dd>
                  {/if}
                  {#if execution.verdict}
                    <dt>Veredito</dt>
                    <dd>{execution.verdict}</dd>
                  {/if}
                </dl>
                {#if execution.failure}
                  <p class="if-drawer-error">{execution.failure}</p>
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
      </section>

      <section class="if-drawer-section">
        <h3>Saída do processo</h3>
        <details>
          <summary>{processLogs.length} linha(s) sanitizada(s)</summary>
          {#if processLogs.length === 0}
            <p class="if-empty">Nenhuma saída capturada.</p>
          {:else}
            <pre class="if-output">{processLogs
                .slice(-200)
                .map((entry) => `${formatClock(entry.at)} ${entry.message}`)
                .join('\n')}</pre>
          {/if}
        </details>
      </section>

      {#if correlatedDiagnostics.length > 0}
        <section class="if-drawer-section">
          <h3>Diagnóstico global persistente</h3>
          <details>
            <summary>{correlatedDiagnostics.length} registro(s) em ~/.issue-flow/logs</summary>
            <pre class="if-output">{correlatedDiagnostics
                .slice(0, 200)
                .map((raw) => {
                  const entry = record(raw);
                  return `${formatClock(entry.timestamp)} ${String(entry.level ?? '')} ${String(
                    entry.message ?? '',
                  )}`;
                })
                .join('\n')}</pre>
          </details>
        </section>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* 20/21 so the drawer covers the sticky disconnection banner, which is 10. */
  .if-overlay {
    position: fixed;
    inset: 0;
    background: var(--overlay);
    z-index: 20;
  }

  .if-drawer {
    position: fixed;
    inset-block: 0;
    inset-inline-end: 0;
    z-index: 21;
    width: min(560px, 100vw);
    background: var(--surface);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .if-drawer-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-8);
    padding: var(--space-16);
    border-bottom: 1px solid var(--border);
  }

  .if-drawer-head h2 {
    margin: 0;
    font-size: var(--font-size-lg);
    overflow-wrap: anywhere;
  }

  .if-drawer-close {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: var(--font-size-lg);
    cursor: pointer;
    padding: 0;
  }

  .if-drawer-body {
    overflow-y: auto;
    padding: var(--space-16);
    display: grid;
    gap: var(--space-16);
    align-content: start;
    min-width: 0;
  }

  .if-drawer-section {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .if-drawer-section h3 {
    margin: 0;
    font-size: var(--font-size-md);
    color: var(--text-muted);
  }

  .if-drawer-text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .if-drawer-list {
    margin: 0;
    padding-left: var(--space-16);
    display: grid;
    gap: var(--space-4);
    font-size: var(--font-size-md);
  }

  .if-drawer-error {
    margin: 0;
    padding: var(--space-8);
    border-radius: var(--radius-small);
    background: var(--state-error-surface);
    color: var(--state-error);
    overflow-wrap: anywhere;
  }

  .if-timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-12);
  }

  .if-timeline-entry {
    display: grid;
    gap: var(--space-8);
    padding: var(--space-8);
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    min-width: 0;
  }

  .if-timeline-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8);
    font-size: var(--font-size-md);
  }

  .if-output {
    margin: var(--space-8) 0 0;
    max-height: 320px;
    overflow: auto;
    background: var(--surface-sunken);
    border-radius: var(--radius-small);
    padding: var(--space-8);
    font-size: var(--font-size-xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .if-badge-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
  }

  .if-label {
    background: var(--surface-sunken);
    color: var(--text-muted);
    font-weight: 400;
  }

  .if-phase-pending {
    background: var(--surface-sunken);
    color: var(--text-muted);
  }

  .if-phase-running {
    background: var(--state-run-surface);
    color: var(--state-run);
  }

  .if-phase-completed {
    background: var(--state-ok-surface);
    color: var(--state-ok);
  }

  .if-phase-failed,
  .if-phase-timeout {
    background: var(--state-error-surface);
    color: var(--state-error);
  }

  .if-status-backlog {
    background: var(--surface-sunken);
    color: var(--text-muted);
  }

  .if-status-in_progress {
    background: var(--state-run-surface);
    color: var(--state-run);
  }

  .if-status-in_review {
    background: var(--state-warn-surface);
    color: var(--state-warn);
  }

  .if-status-done {
    background: var(--state-ok-surface);
    color: var(--state-ok);
  }
</style>
