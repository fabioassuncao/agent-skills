<script lang="ts">
  import { formatAgo, formatClock, formatDuration } from './format';
  import type { ExecutionSnapshot } from './snapshot';



  const PREVIEW = 3;

  let { snapshot, now }: { snapshot: ExecutionSnapshot; now: number } = $props();

  let escalated = $derived(snapshot.agent.awaitingInputEscalatedAt);
  let errors = $derived(snapshot.errors);
  let warnings = $derived(snapshot.warnings);

  let any = $derived(
    errors.length > 0 || warnings.length > 0 || snapshot.lastError !== null || escalated !== null,
  );

  let counts = $derived.by(() => {
    const parts: string[] = [];
    if (errors.length > 0) parts.push(`${errors.length} erro(s)`);
    if (warnings.length > 0) parts.push(`${warnings.length} aviso(s)`);
    return parts.join(' · ');
  });
</script>

{#if any}
  <section class="if-card if-alerts" aria-live="polite">
    <h2>Erros e avisos</h2>
    <div class="if-alert-body">
      {#if escalated}
        <p class="if-alert if-alert-error">
          <strong>Ninguém respondeu ao agente.</strong>
          {#if snapshot.agent.phase}Ele está bloqueado na fase {snapshot.agent.phase}.{/if}
          A execução não avança até alguém agir. Esperando
          {#if snapshot.agent.awaitingInputWaitedMs !== null}
            há {formatDuration(snapshot.agent.awaitingInputWaitedMs / 1000)}
          {:else}
            {formatAgo(escalated, now)}
          {/if}.
        </p>
      {/if}
      {#if counts}
        <p class="if-alert-count if-muted">{counts}</p>
      {/if}
      {#if snapshot.lastError}
        <p class="if-alert if-alert-error">
          <strong>Último erro: </strong>{snapshot.lastError.message}
        </p>
      {/if}
      {#each errors.slice(-PREVIEW) as entry (`${entry.at}:${entry.message}`)}
        <p class="if-alert if-alert-error">
          <span class="if-mono if-muted">{formatClock(entry.at)}</span>
          {entry.message}
        </p>
      {/each}
      {#each warnings.slice(-PREVIEW) as entry (`${entry.at}:${entry.message}`)}
        <p class="if-alert if-alert-warn">
          <span class="if-mono if-muted">{formatClock(entry.at)}</span>
          {entry.message}
        </p>
      {/each}
    </div>
  </section>
{/if}

<style>
  .if-alerts {
    gap: var(--space-8);
  }

  .if-alert-body {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
  }

  .if-alert {
    margin: 0;
    padding: var(--space-8);
    border-radius: var(--radius-small);
    font-size: var(--font-size-md);
    overflow-wrap: anywhere;
  }

  .if-alert-count {
    margin: 0;
    font-size: var(--font-size-sm);
  }

  .if-alert-error {
    background: var(--state-error-surface);
    color: var(--state-error);
  }

  .if-alert-warn {
    background: var(--state-warn-surface);
    color: var(--state-warn);
  }
</style>
