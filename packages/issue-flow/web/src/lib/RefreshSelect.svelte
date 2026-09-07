<script lang="ts">
  import { REFRESH_PAUSED, refreshOptions } from './executions';



  let {
    seconds,
    onchange,
    label = 'Atualizar',
  }: { seconds: number; onchange: (seconds: number) => void; label?: string } = $props();

  let options = $derived(refreshOptions(seconds));
</script>

<label class="if-refresh">
  <span class="if-muted">{label}</span>
  <select
    aria-label="Intervalo de atualização"
    value={String(seconds)}
    onchange={(event) => onchange(Number((event.currentTarget as HTMLSelectElement).value))}
  >
    {#each options as option (option)}
      <option value={String(option)}>{option}s</option>
    {/each}
    <option value={String(REFRESH_PAUSED)}>pausar</option>
  </select>
</label>

<style>
  .if-refresh {
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
</style>
