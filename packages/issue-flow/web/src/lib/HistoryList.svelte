<script lang="ts">
  import { filterHistory, type HistoryFilter, type JournalEntryView } from './executions';
  import { formatClock } from './format';
  import { historyMessage } from './vocabulary';

  /**
   * The journal (U11).
   *
   * PORT of `renderHistory`. The filter splits the two families the panel
   * distinguishes — resilience (retry, attempt, activity, result, failover) and
   * everything else, which is the pipeline. Most recent first, like the logs.
   */

  let {
    entries,
    filter,
    onfilterchange,
  }: {
    entries: readonly JournalEntryView[];
    filter: HistoryFilter;
    onfilterchange: (filter: HistoryFilter) => void;
  } = $props();

  let visible = $derived([...filterHistory(entries, filter)].reverse());
</script>

<section class="if-card">
  <div class="if-section-head">
    <h2>Histórico</h2>
    <label class="if-filter">
      <span class="if-muted">Evento</span>
      <select
        aria-label="Filtro do histórico"
        value={filter}
        onchange={(event) =>
          onfilterchange((event.currentTarget as HTMLSelectElement).value as HistoryFilter)}
      >
        <option value="all">todos</option>
        <option value="resilience">resiliência</option>
        <option value="pipeline">pipeline</option>
      </select>
    </label>
  </div>

  {#if visible.length === 0}
    <p class="if-empty">Nenhum evento para exibir.</p>
  {:else}
    <ol class="if-list">
      {#each visible as entry (entry.seq)}
        <li class="if-history">
          <span class="if-mono if-muted">{formatClock(entry.event.at)}</span>
          <span class="if-mono if-history-type">{String(entry.event.type ?? '')}</span>
          <span class="if-history-message">{historyMessage(entry.event)}</span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .if-section-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    min-width: 0;
  }

  .if-section-head h2 {
    margin: 0;
    font-size: var(--font-size-lg);
  }

  .if-filter {
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    font-size: var(--font-size-sm);
  }

  select {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    padding: 2px var(--space-4);
    font-size: var(--font-size-sm);
  }

  /*
    `minmax(0, 1fr)` plus `min-width: 0`: without them a long event message
    refuses to shrink below its content and widens the page instead of wrapping.
  */
  .if-history {
    display: grid;
    grid-template-columns: max-content max-content minmax(0, 1fr);
    gap: var(--space-8);
    padding: var(--space-4);
    font-size: var(--font-size-sm);
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .if-history-type {
    color: var(--text-subtle);
  }
</style>
