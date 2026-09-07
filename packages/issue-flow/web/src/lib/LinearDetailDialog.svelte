<script lang="ts">
  import BaseDialog from './BaseDialog.svelte';
  import Btn from './Btn.svelte';
  import type { LinearIssue } from './types';

  let {
    issue,
    canAssign,
    onassign,
    onclose,
  }: {
    issue: LinearIssue;
    canAssign: boolean;
    onassign: (issue: LinearIssue) => void;
    onclose: () => void;
  } = $props();
</script>

<BaseDialog {onclose} wide>
  <div class="flex items-center gap-2 mb-1">
    <span class="shrink-0 w-2.5 h-2.5 rounded-full" style={`background:${issue.state.color}`}></span>
    <a href={issue.url} target="_blank" rel="noopener noreferrer" class="font-mono text-xs text-accent no-underline hover:underline">{issue.identifier}</a>
    <span class="text-[11px] text-muted">{issue.state.name} · {issue.priorityLabel}</span>
  </div>
  <h2 class="text-base font-semibold mb-3">{issue.title}</h2>
  {#if issue.description}
    <div class="text-[13px] text-secondary whitespace-pre-wrap max-h-64 overflow-y-auto mb-4 leading-relaxed">{issue.description}</div>
  {:else}
    <p class="text-[13px] text-muted italic mb-4">Sem descrição.</p>
  {/if}
  <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted mb-4">
    <span>{issue.team.key}</span>
    {#if issue.project}<span>· {issue.project}</span>{/if}
    {#each issue.labels as label (label.name)}
      <span class="px-1.5 py-0.5 rounded-full text-[10px]" style={`color:${label.color};background:${label.color}20`}>{label.name}</span>
    {/each}
    {#if issue.dueDate}<span>Prazo: {issue.dueDate}</span>{/if}
  </div>
  <div class="flex justify-end gap-2">
    <Btn onclick={onclose}>Fechar</Btn>
    {#if canAssign}
      <Btn variant="accent-outline" onclick={() => onassign(issue)}>Implementar</Btn>
    {/if}
  </div>
</BaseDialog>
