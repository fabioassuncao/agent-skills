<script lang="ts">
  import AgentStatusIcon from './AgentStatusIcon.svelte';
  import type { WorktreeInfo } from './types';

  /**
   * "Sessões e worktrees" — the tab that makes §50.5's rule true.
   *
   * A Task **contains** its sessions, worktrees and services; it does not point
   * at another area. This is the component that holds them, and it is the
   * **same** component a free session uses to show its own workspace — the only
   * difference is how many rows it is given and what the heading calls them.
   *
   * That is deliberate and it is the anti-pattern the phase exists to avoid: a
   * second "session version" of this block is exactly how the two interfaces
   * would grow back inside one product.
   *
   * Service health comes from `runtime/services.ts` through the row, and a
   * probe can only tell `ready` from `stopped` — a port nobody allocated says
   * so rather than reading as "stopped", which would be a state somebody
   * observed.
   */

  let {
    worktrees,
    title,
    selected = null,
    emptyMessage = 'Nenhuma sessão aberta.',
    onselect = null,
    onopenterminal = null,
  }: {
    worktrees: readonly WorktreeInfo[];
    title: string;
    selected?: string | null;
    emptyMessage?: string;
    onselect?: ((branch: string) => void) | null;
    onopenterminal?: ((branch: string) => void) | null;
  } = $props();

  function agentStatus(worktree: WorktreeInfo): 'working' | 'waiting' | 'done' | 'error' | 'idle' {
    switch (worktree.status) {
      case 'running':
      case 'starting':
        return 'working';
      case 'idle':
        return 'waiting';
      case 'error':
        return 'error';
      case 'stopped':
        return 'done';
      default:
        return 'idle';
    }
  }
</script>

<section class="if-card">
  <h2>{title}</h2>

  {#if worktrees.length === 0}
    <p class="if-empty">{emptyMessage}</p>
  {:else}
    <ul class="if-list">
      {#each worktrees as worktree (worktree.branch)}
        <li class="if-row" class:is-selected={selected === worktree.branch}>
          <AgentStatusIcon status={agentStatus(worktree)} />
          <span class="if-row-main">
            <span class="wt-title">
              {#if onselect}
                <button
                  type="button"
                  class="wt-link"
                  data-worktree-branch={worktree.branch}
                  onclick={() => onselect?.(worktree.branch)}>{worktree.label ?? worktree.branch}</button
                >
              {:else}
                <span data-worktree-branch={worktree.branch}
                  >{worktree.label ?? worktree.branch}</span
                >
              {/if}
            </span>
            <span class="wt-meta if-muted">
              <!-- Only when the title is not already the branch: repeating it
                   is a line of noise on every row that has no label. -->
              {#if worktree.label}<span class="if-mono">{worktree.branch}</span>{/if}
              {#if worktree.agentLabel ?? worktree.agentName}
                <span>{worktree.agentLabel ?? worktree.agentName}</span>
              {/if}
              {#if worktree.profile}<span>profile {worktree.profile}</span>{/if}
              {#if worktree.dirty}<span class="wt-flag">alterações não commitadas</span>{/if}
              {#if worktree.unpushed}<span class="wt-flag">commits não enviados</span>{/if}
            </span>
            {#if worktree.services.length > 0}
              <span class="wt-services">
                {#each worktree.services as service (service.name)}
                  <span class="wt-service" class:is-up={service.running}>
                    {#if service.url}
                      <a href={service.url} target="_blank" rel="noopener"
                        >{service.name}{service.port === null ? '' : `:${service.port}`}</a
                      >
                    {:else}
                      {service.name}{service.port === null ? '' : `:${service.port}`}
                    {/if}
                  </span>
                {/each}
              </span>
            {/if}
          </span>
          {#if onopenterminal && worktree.mux === '✓'}
            <button type="button" class="wt-terminal" onclick={() => onopenterminal?.(worktree.branch)}
              >Terminal</button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .if-row.is-selected {
    box-shadow: inset 0 0 0 2px var(--state-run);
    /* Discounts the inset shadow so the rhythm survives. */
    padding: calc(var(--space-8) - 2px);
  }

  .wt-title {
    display: block;
    font-size: var(--font-size-md);
    overflow-wrap: anywhere;
  }

  .wt-link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
    text-align: left;
  }

  .wt-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-8);
    margin-top: var(--space-4);
    font-size: var(--font-size-sm);
    /* U20: `min-width: auto` refuses to shrink below the content, and a long
       branch name would then push the page wider than the viewport. */
    min-width: 0;
  }

  .wt-flag {
    color: var(--state-warn);
  }

  .wt-services {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
    margin-top: var(--space-4);
  }

  .wt-service {
    border-radius: var(--radius-small);
    padding: 0 var(--space-4);
    font-size: var(--font-size-xs);
    background: var(--surface);
    color: var(--text-muted);
  }

  .wt-service.is-up {
    background: var(--state-ok-surface);
    color: var(--state-ok);
  }

  .wt-terminal {
    flex: 0 0 auto;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    padding: var(--space-4) var(--space-8);
    font: inherit;
    font-size: var(--font-size-sm);
    color: var(--accent);
    cursor: pointer;
  }
</style>
