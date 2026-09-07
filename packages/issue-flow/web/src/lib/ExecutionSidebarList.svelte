<script lang="ts">
  import AgentStatusIcon, { executionStatusToAgentStatus } from './AgentStatusIcon.svelte';
  import type { SessionSummary } from './types';

  /**
   * The executions group in the sidebar.
   *
   * §50.3 merges the two lists the two products had — the WebMux worktree list
   * and the panel's execution cards — into **one** sidebar with two groups. This
   * is the first group; `WorktreeList` is the second. Selecting a row here
   * clears the worktree selection and vice versa: the main panel shows what is
   * selected, and exactly one thing is.
   *
   * The vocabulary is the glossary's and the collision is the one §50.4
   * resolved: an *execução* is a run of the workflow over a Task, a *sessão* is
   * a live agent in a worktree, and neither word is a synonym of the other.
   */

  let {
    sessions,
    selected,
    onselect,
  }: {
    sessions: readonly SessionSummary[];
    selected: string | null;
    onselect: (sessionId: string | null) => void;
  } = $props();
</script>

<div class="group">
  <div class="head">
    <span class="title">Execuções</span>
    {#if sessions.length > 0}
      <button
        type="button"
        class="all"
        aria-pressed={selected === null}
        onclick={() => onselect(null)}>todas</button
      >
    {/if}
  </div>

  {#if sessions.length === 0}
    <p class="empty">Nenhuma execução ativa.</p>
  {:else}
    <ul>
      {#each sessions as session (session.sessionId)}
        <li>
          <button
            type="button"
            class="row"
            data-execution-id={session.sessionId}
            class:is-selected={selected !== null && selected === session.sessionId}
            onclick={() => onselect(session.sessionId)}
          >
            <span class="row-main">
              <span class="row-title">
                {#if session.issueNumber !== null}<span class="number">#{session.issueNumber}</span
                  >{/if}{session.issueTitle ?? 'Sem título'}
              </span>
              <span class="row-meta">{session.currentPhase ?? '—'}</span>
            </span>
            <AgentStatusIcon status={executionStatusToAgentStatus(session.status)} />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .group {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-8) var(--space-12);
    border-bottom: 1px solid var(--border);
    min-width: 0;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
  }

  .title {
    font-size: var(--font-size-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .all {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    font-size: var(--font-size-xs);
    cursor: pointer;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    width: 100%;
    min-width: 0;
    text-align: left;
    background: none;
    border: none;
    border-radius: var(--radius-small);
    padding: var(--space-4) var(--space-8);
    font: inherit;
    color: var(--text);
    cursor: pointer;
  }

  .row:hover {
    background: var(--surface-sunken);
  }

  .row.is-selected {
    background: var(--state-run-surface);
    color: var(--state-run);
  }

  .row-main {
    flex: 1 1 auto;
    min-width: 0;
  }

  .row-title {
    display: block;
    font-size: var(--font-size-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .number {
    color: var(--text-muted);
    margin-right: var(--space-4);
  }

  .row-meta {
    display: block;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .empty {
    margin: 0;
    font-size: var(--font-size-xs);
    color: var(--text-subtle);
  }
</style>
