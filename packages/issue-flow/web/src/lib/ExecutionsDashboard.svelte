<script lang="ts">
  import ExecutionCard from './ExecutionCard.svelte';
  import RefreshSelect from './RefreshSelect.svelte';
  import { ALL_PROJECTS, activeWorkGroups, summarizeSessions } from './executions';
  import type { ProjectSummary, SessionSummary } from './types';

  /**
   * The executions dashboard (U1).
   *
   * PORT of `renderDashboard`/`renderDashboardSummary`/`renderProjectSelect`.
   * Two rules hold this together, and both are about not surprising a
   * single-project user:
   *
   * - **The project selector only appears with more than one project.** On a
   *   single-project monitor it would be a control with one option.
   * - **The chosen project is a viewing preference**, kept in this browser like
   *   the theme and the interval. The registry is the authority over which
   *   projects exist, never over which one somebody is looking at — and a
   *   project that leaves the registry while the filter points at it returns the
   *   view to "all" rather than leaving an empty screen with no explanation.
   *
   * The heading is "Trabalho ativo", not the product's name: the brand lives in
   * the document `<title>`.
   */

  let {
    sessions,
    projects,
    selectedProjectId,
    refreshSeconds,
    now,
    onselect,
    onprojectchange,
    onrefreshchange,
  }: {
    sessions: readonly SessionSummary[];
    projects: readonly ProjectSummary[];
    selectedProjectId: string;
    refreshSeconds: number;
    now: number;
    onselect: (sessionId: string) => void;
    onprojectchange: (projectId: string) => void;
    onrefreshchange: (seconds: number) => void;
  } = $props();

  let multiProject = $derived(projects.length > 1);
  let summary = $derived(
    sessions.length === 0 ? 'Nenhuma execução ativa' : summarizeSessions(sessions),
  );
  let groups = $derived(
    multiProject ? activeWorkGroups({ sessions, projects, selectedProjectId }) : [],
  );
</script>

<header class="if-card if-dashboard-header">
  <div class="if-dashboard-main">
    <h1>Trabalho ativo</h1>
    <p class="if-muted if-dashboard-summary">{summary}</p>
  </div>
  <div class="if-dashboard-side">
    {#if multiProject}
      <label class="if-project">
        <span class="if-muted">Projeto</span>
        <select
          aria-label="Projeto exibido"
          value={selectedProjectId}
          onchange={(event) =>
            onprojectchange((event.currentTarget as HTMLSelectElement).value)}
        >
          <option value={ALL_PROJECTS}>Todos os projetos</option>
          {#each projects as project (project.id)}
            <option value={project.id}>{project.name || project.id}</option>
          {/each}
        </select>
      </label>
    {/if}
    <RefreshSelect seconds={refreshSeconds} onchange={onrefreshchange} />
  </div>
</header>

{#if multiProject}
  <div class="if-groups">
    {#each groups as group (group.id ?? 'orphans')}
      <section class="if-group">
        <h2>{group.label}</h2>
        {#if group.sessions.length === 0}
          <p class="if-empty">Nenhuma execução ativa.</p>
        {:else}
          <div class="if-cards">
            {#each group.sessions as session (session.sessionId)}
              <ExecutionCard {session} {now} {onselect} />
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  </div>
{:else if sessions.length === 0}
  <p class="if-empty">Nenhuma execução ativa.</p>
{:else}
  <div class="if-cards">
    {#each sessions as session (session.sessionId)}
      <ExecutionCard {session} {now} {onselect} />
    {/each}
  </div>
{/if}

<style>
  .if-dashboard-header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-12);
  }

  .if-dashboard-main {
    flex: 1 1 320px;
    min-width: 0;
    display: grid;
    gap: var(--space-4);
  }

  .if-dashboard-main h1 {
    margin: 0;
    font-size: var(--font-size-xl);
  }

  .if-dashboard-summary {
    margin: 0;
    font-size: var(--font-size-sm);
  }

  .if-dashboard-side {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8);
    min-width: 0;
  }

  .if-project {
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
    max-width: 12rem;
  }

  .if-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr));
    gap: var(--space-16);
    min-width: 0;
  }

  .if-groups {
    display: grid;
    gap: var(--space-24);
    min-width: 0;
  }

  .if-group {
    display: grid;
    gap: var(--space-12);
    min-width: 0;
  }

  .if-group h2 {
    margin: 0;
    font-size: var(--font-size-lg);
  }
</style>
