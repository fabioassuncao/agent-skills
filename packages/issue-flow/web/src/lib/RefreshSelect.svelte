<script lang="ts">
  import { REFRESH_PAUSED, refreshOptions } from './executions';

  /**
   * The refresh interval control (U16).
   *
   * PORT of `fillRefreshSelect`/`onRefreshChange`. It exists in **both**
   * headers — the dashboard's and the execution's — and the two are the same
   * value: the state lives in the shell, so changing it in one is changing it
   * in the other, with no synchronisation step to forget.
   *
   * It stopped being the delivery path when `/api/stream` arrived, and it did
   * **not** stop mattering: it is the safety net for when the stream drops, and
   * "pausar" has to pause for real — with the stream open the server would keep
   * pushing and this control would be decoration.
   */

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
