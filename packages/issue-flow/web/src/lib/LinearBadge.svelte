<script lang="ts">
  import type { LinearIssue } from './types';

  let { issue, clickable = false }: { issue: LinearIssue; clickable?: boolean } = $props();
  const classes = 'shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full';
  let style = $derived(`color:${issue.state.color};background:${issue.state.color}20;`);
  let title = $derived(`${issue.identifier} (${issue.state.name})`);
</script>

{#if clickable}
  <a
    href={issue.url}
    target="_blank"
    rel="noopener noreferrer"
    class="{classes} no-underline hover:opacity-80"
    {style}
    {title}>{issue.identifier}</a
  >
{:else}
  <span class={classes} {style} {title}>{issue.identifier}</span>
{/if}
