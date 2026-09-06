<script lang="ts">
  import CursorButton from './CursorButton.svelte';
  import PrStatusGroup from './PrStatusGroup.svelte';
  import type { PrEntry, ServiceStatus } from './types';

  /**
   * PORT of `frontend/src/lib/RepoGroup.svelte` @ d8c9d5f (45 lines).
   *
   * This is also where service health lands (§19): port, state and a link, and
   * a service that is not running is `pointer-events-none` rather than hidden —
   * "configured but down" and "not configured" are different answers.
   */

  let {
    label,
    prs,
    services = [],
    cursorUrl = null,
    onCiClick,
    onReviewsClick,
  }: {
    label?: string;
    prs: PrEntry[];
    services?: ServiceStatus[];
    cursorUrl?: string | null;
    onCiClick: (pr: PrEntry) => void;
    onReviewsClick: (pr: PrEntry) => void;
  } = $props();
</script>

<div class="repo-group flex flex-wrap items-center gap-x-2 gap-y-1.5 min-w-0">
  {#if label}
    <span class="shrink-0 text-[10px] font-medium text-muted">{label}:</span>
  {/if}
  {#each prs as pr (`${pr.repo}#${pr.number}`)}
    <PrStatusGroup {pr} {onCiClick} {onReviewsClick} />
  {/each}
  {#each services as svc (svc.name)}
    {#if svc.port}
      <a
        href="{window.location.protocol}//{window.location.hostname}:{svc.port}"
        target="_blank"
        rel="noopener"
        title={svc.running ? `${svc.name} no ar` : `${svc.name} fora do ar`}
        class="shrink-0 text-[11px] px-1.5 py-0.5 rounded border font-mono no-underline hover:opacity-80 {svc.running
          ? 'text-success border-success/40'
          : 'text-muted border-edge pointer-events-none'}"
      >{svc.name} :{svc.port}</a>
    {/if}
  {/each}
  {#if cursorUrl}
    <CursorButton url={cursorUrl} />
  {/if}
</div>
