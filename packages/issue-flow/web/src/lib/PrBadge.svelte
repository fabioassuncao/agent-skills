<script lang="ts">
  import type { PrEntry } from './types';
  import { isDraftPr, type PrBadgeInput, prBadgeClass, prLabel } from './utils';

  /**
   * PORT of `frontend/src/lib/PrBadge.svelte` @ d8c9d5f (24 lines).
   *
   * One adaptation, for §50.3's merge: `state` may be `null`. The panel's PR
   * list comes from the execution snapshot, which records that a pull request
   * was opened and nothing about what happened to it afterwards. Rendering that
   * as "aberto" would be a state nobody observed, so it renders as unknown —
   * and there is still only one PR badge in the product.
   */

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
