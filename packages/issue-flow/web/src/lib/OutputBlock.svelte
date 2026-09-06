<script lang="ts">
  import PrBadge from './PrBadge.svelte';
  import { filterLogs, type LogFilter } from './executions';
  import { formatClock, itemSideText, repoUrlFromIssueUrl } from './format';
  import type { ExecutionSnapshot } from './snapshot';

  /**
   * "Saída" — the fourth of the four blocks (U14).
   *
   * PORT of `renderGit` and `renderLogs`. The verification verdict used to sit
   * here; §50.5 gives it a tab of its own, so `VerificationVerdictCard` moved
   * there rather than being rendered twice. U21 is about *what* the verdict
   * says, not about which tab shows it, and the card is unchanged.
   *
   * Two §50.3 merges land in this block:
   *
   * - **Commits open the `DiffDialog`** rather than growing a second diff
     *   renderer. The dialog needs the worktree diff route, so the row is a
   *   button only where that capability exists; otherwise it stays the link to
   *   the commit it already was.
   * - **The PR list carries the WebMux badge.** One PR badge in the product —
   *   with `state: null`, because this list records that a pull request was
   *   opened and nothing about what happened to it since.
   */

  let {
    snapshot,
    logFilter,
    onlogfilterchange,
    ondiff = null,
  }: {
    snapshot: ExecutionSnapshot;
    logFilter: LogFilter;
    onlogfilterchange: (filter: LogFilter) => void;
    ondiff?: (() => void) | null;
  } = $props();

  let repoUrl = $derived(repoUrlFromIssueUrl(snapshot.issue.url));

  // Most recent first: monitoring reads the top and never manages a scrollbar.
  let logs = $derived([...filterLogs(snapshot.logs, logFilter)].reverse());
</script>

<section class="if-card">
  <h2>Saída</h2>

  <div class="if-columns">
    <div class="if-part">
      <h3>Commits</h3>
      {#if snapshot.git.commits.length === 0}
        <p class="if-empty">Nenhum commit ainda.</p>
      {:else}
        <ul class="if-list">
          {#each snapshot.git.commits as commit (commit.hash)}
            <li class="if-row">
              {#if ondiff}
                <button
                  type="button"
                  class="if-hash if-mono if-hash-button"
                  onclick={ondiff}
                  title="Ver as mudanças">{commit.hash}</button
                >
              {:else if repoUrl}
                <a
                  class="if-hash if-mono"
                  href={`${repoUrl}/commit/${commit.hash}`}
                  target="_blank"
                  rel="noopener">{commit.hash}</a
                >
              {:else}
                <span class="if-hash if-mono">{commit.hash}</span>
              {/if}
              <span class="if-row-main">
                <span class="if-commit-subject">{commit.subject}</span>
                {#if itemSideText([commit.storyId, commit.committedAt ? formatClock(commit.committedAt) : ''])}
                  <span class="if-muted if-commit-meta"
                    >{itemSideText([
                      commit.storyId,
                      commit.committedAt ? formatClock(commit.committedAt) : '',
                    ])}</span
                  >
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="if-part">
      <h3>Pull requests</h3>
      {#if snapshot.pullRequests.length === 0}
        <p class="if-empty">Nenhum pull request ainda.</p>
      {:else}
        <ul class="if-list">
          {#each snapshot.pullRequests as pr (pr.url ?? pr.number)}
            <li class="if-row">
              <PrBadge
                clickable={pr.url !== null}
                pr={{
                  repo: '',
                  number: pr.number ?? 0,
                  state: null,
                  isDraft: false,
                  url: pr.url,
                }}
              />
              <span class="if-row-main">{pr.title}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>

  <div class="if-part">
    <div class="if-section-head">
      <h3>Logs recentes</h3>
      <label class="if-filter">
        <span class="if-muted">Nível</span>
        <select
          aria-label="Filtro por nível de log"
          value={logFilter}
          onchange={(event) =>
            onlogfilterchange((event.currentTarget as HTMLSelectElement).value as LogFilter)}
        >
          <option value="all">todos</option>
          <option value="info">info</option>
          <option value="warn">avisos</option>
          <option value="error">erros</option>
        </select>
      </label>
    </div>
    {#if logs.length === 0}
      <p class="if-empty">Nenhum log para exibir.</p>
    {:else}
      <ol class="if-list if-logs">
        {#each logs as entry, index (`${entry.at}:${index}`)}
          <li class="if-log if-log-{entry.level}">
            <span class="if-mono if-muted">{formatClock(entry.at)}</span>
            <span class="if-log-level">{entry.level}</span>
            <span class="if-log-message">{entry.message}</span>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</section>

<style>
  .if-section-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
    min-width: 0;
  }

  .if-filter {
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

  .if-hash {
    flex: 0 0 auto;
    color: var(--accent);
    font-size: var(--font-size-sm);
  }

  .if-hash-button {
    background: none;
    border: none;
    padding: 0;
    font-family: inherit;
    cursor: pointer;
  }

  .if-commit-subject {
    display: block;
    font-size: var(--font-size-md);
    overflow-wrap: anywhere;
  }

  .if-commit-meta {
    display: block;
    font-size: var(--font-size-sm);
  }

  .if-logs {
    max-height: 320px;
    overflow-y: auto;
  }

  /*
    A log line is the widest thing on the page. `minmax(0, 1fr)` and
    `min-width: 0` are what make it wrap instead of widening the viewport.
  */
  .if-log {
    display: grid;
    grid-template-columns: max-content max-content minmax(0, 1fr);
    gap: var(--space-8);
    font-size: var(--font-size-sm);
    padding: var(--space-4);
    border-radius: var(--radius-small);
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .if-log-level {
    text-transform: uppercase;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .if-log-warn {
    background: var(--state-warn-surface);
  }

  .if-log-warn .if-log-level {
    color: var(--state-warn);
  }

  .if-log-error {
    background: var(--state-error-surface);
  }

  .if-log-error .if-log-level {
    color: var(--state-error);
  }
</style>
