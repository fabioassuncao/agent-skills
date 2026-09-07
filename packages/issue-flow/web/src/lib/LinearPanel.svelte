<script lang="ts">
  import Btn from './Btn.svelte';
  import type { LinearIssue, LinearIssueAvailability } from './types';

  let {
    issues,
    availability,
    canAssign,
    onassign,
    onselect,
  }: {
    issues: LinearIssue[];
    availability: LinearIssueAvailability;
    canAssign: boolean;
    onassign: (issue: LinearIssue) => void;
    onselect: (issue: LinearIssue) => void;
  } = $props();

  let collapsed = $state(true);
  let query = $state('');
  let normalized = $derived(query.trim().toLocaleLowerCase('pt-BR'));
  let filtered = $derived(
    normalized
      ? issues.filter((issue) =>
          `${issue.identifier} ${issue.title} ${issue.description ?? ''}`
            .toLocaleLowerCase('pt-BR')
            .includes(normalized),
        )
      : issues,
  );
</script>

<section class="border-t border-edge" aria-label="Tickets do Linear">
  <button
    type="button"
    class="w-full flex items-center justify-between px-4 py-2 text-xs text-muted cursor-pointer bg-transparent border-none hover:bg-hover"
    aria-expanded={!collapsed}
    onclick={() => (collapsed = !collapsed)}
  >
    <span class="font-semibold">Linear{availability === 'ready' ? ` (${issues.length})` : ''}</span>
    <span class="text-[10px]" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
  </button>

  {#if !collapsed}
    {#if availability === 'missing_api_key'}
      <p class="m-0 px-4 pb-3 text-xs text-muted">
        Defina <code>LINEAR_API_KEY</code> no ambiente do monitor para ver seus tickets atribuídos.
      </p>
    {:else if availability === 'disabled'}
      <p class="m-0 px-4 pb-3 text-xs text-muted">A integração com o Linear está desativada.</p>
    {:else if issues.length === 0}
      <p class="m-0 px-4 pb-3 text-xs text-muted">Nenhum ticket atribuído no momento.</p>
    {:else}
      <div class="px-2 pb-1">
        <input
          type="search"
          placeholder="Buscar tickets…"
          aria-label="Buscar tickets do Linear"
          class="w-full px-2 py-1 text-xs rounded border border-edge bg-surface text-primary placeholder:text-muted outline-none focus:border-accent"
          bind:value={query}
        />
      </div>
      <ul class="list-none overflow-y-auto max-h-64 px-2 pb-2">
        {#each filtered as issue (issue.id)}
          <li class="mb-1 rounded-md border border-transparent hover:bg-hover text-[12px]">
            <div class="flex items-end gap-2 p-2">
              <button
                type="button"
                class="min-w-0 flex-1 text-left bg-transparent text-inherit"
                aria-label={`Ver detalhes de ${issue.identifier}`}
                onclick={() => onselect(issue)}
              >
                <span class="flex items-center gap-1.5 mb-0.5">
                  <span class="shrink-0 w-2 h-2 rounded-full" style={`background:${issue.state.color}`}></span>
                  <span class="font-mono text-[11px] text-accent">{issue.identifier}</span>
                  <span class="text-[10px] text-muted">{issue.priorityLabel}</span>
                </span>
                <span class="block truncate text-primary mb-1">{issue.title}</span>
                <span class="block text-[10px] text-muted truncate">
                  {issue.team.key}{issue.project ? ` · ${issue.project}` : ''}
                </span>
              </button>
              {#if canAssign}
                <Btn small variant="accent-outline" onclick={() => onassign(issue)}>Implementar</Btn>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
