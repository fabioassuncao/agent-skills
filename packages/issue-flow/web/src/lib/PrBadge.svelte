<script lang="ts">
  import type { PrEntry } from './types';
  import { isDraftPr, type PrBadgeInput, prBadgeClass, prLabel } from './utils';



  let {
    pr,
    clickable = false,
  }: {
    pr: PrBadgeInput & { url?: string | null };
    clickable?: boolean;
  } = $props();

  const STATE_LABELS: Record<PrEntry['state'], string> = {
    open: 'aberto',
    closed: 'fechado',
    merged: 'integrado',
  };

  let label = $derived(prLabel(pr));
  let title = $derived(
    isDraftPr(pr)
      ? 'rascunho'
      : pr.state === null
        ? 'estado não consultado'
        : STATE_LABELS[pr.state],
  );
</script>

{#if clickable && pr.url}
  <a
    href={pr.url}
    target="_blank"
    rel="noopener"
    class="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full no-underline hover:opacity-80 {prBadgeClass(
      pr,
    )}"
    {title}
  >{label}</a>
{:else}
  <span
    class="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full {prBadgeClass(pr)}"
    {title}>{label}</span
  >
{/if}
