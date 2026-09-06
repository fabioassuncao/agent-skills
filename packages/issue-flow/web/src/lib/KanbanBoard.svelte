<script lang="ts">
  import type { SnapshotStory } from './snapshot';
  import { KANBAN_COLUMNS, STORY_STATUS_LABELS } from './vocabulary';

  /**
   * The Kanban (U10).
   *
   * PORT of `renderKanban`/`storyCard`. Each card is a `<button>` — Enter,
   * Space and focus come for free — which is exactly why everything inside it
   * is a `<span>`: `<button>` only accepts phrasing content, so a `<p>` or a
   * `<div>` in there is invalid HTML that browsers repair in ways that break
   * the click target.
   *
   * `data-story-id` is what the drawer focuses back on when it closes: the
   * board is rebuilt on every update, so a node reference captured on opening
   * would point outside the document by then.
   */

  let {
    stories,
    onopenstory,
  }: { stories: readonly SnapshotStory[]; onopenstory: (id: string) => void } = $props();
</script>

<div class="if-scroll-x">
  <div class="if-kanban">
    {#each KANBAN_COLUMNS as column (column.status)}
      {@const entries = stories.filter((story) => story.status === column.status)}
      <section class="if-column">
        <div class="if-column-head">
          <h3>{column.title}</h3>
          <span class="if-column-count">{entries.length}</span>
        </div>
        {#if entries.length === 0}
          <p class="if-empty">Nenhuma story.</p>
        {:else}
          {#each entries as story (story.id)}
            <button
              type="button"
              class="if-kanban-card"
              data-story-id={story.id}
              onclick={() => onopenstory(story.id)}
            >
              <span class="if-kanban-head">
                <span
                  class="if-icon"
                  class:if-icon-completed={story.passes}
                  class:if-icon-pending={!story.passes}
                  aria-hidden="true">{story.passes ? '✓' : '○'}</span
                >
                <span class="if-mono if-muted">{story.id}</span>
              </span>
              <span class="if-kanban-title">{story.title}</span>
              {#if story.description}
                <span class="if-kanban-desc if-muted">{story.description}</span>
              {/if}
              <span class="if-badge if-status-{story.status}"
                >{STORY_STATUS_LABELS[story.status]}</span
              >
            </button>
          {/each}
        {/if}
      </section>
    {/each}
  </div>
</div>

<style>
  .if-kanban {
    display: grid;
    grid-template-columns: repeat(4, minmax(200px, 1fr));
    gap: var(--space-12);
    /* Four columns need room; the box scrolls, never the page (U20). */
    min-width: 860px;
  }

  .if-column {
    display: grid;
    align-content: start;
    gap: var(--space-8);
    background: var(--surface-sunken);
    border-radius: var(--radius-medium);
    padding: var(--space-8);
  }

  .if-column-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8);
  }

  .if-column-head h3 {
    margin: 0;
    font-size: var(--font-size-md);
  }

  .if-column-count {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }

  .if-kanban-card {
    display: grid;
    justify-items: start;
    gap: var(--space-4);
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    padding: var(--space-8);
    font: inherit;
    color: var(--text);
    cursor: pointer;
    width: 100%;
    min-width: 0;
  }

  .if-kanban-card:hover {
    border-color: var(--border-strong);
  }

  .if-kanban-head {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    font-size: var(--font-size-sm);
  }

  .if-kanban-title {
    display: block;
    font-size: var(--font-size-md);
    overflow-wrap: anywhere;
  }

  .if-kanban-desc {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: var(--font-size-sm);
  }

  .if-icon-pending {
    color: var(--text-subtle);
  }

  .if-icon-completed {
    color: var(--state-ok);
  }

  .if-status-backlog {
    background: var(--surface-sunken);
    color: var(--text-muted);
  }

  .if-status-in_progress {
    background: var(--state-run-surface);
    color: var(--state-run);
  }

  .if-status-in_review {
    background: var(--state-warn-surface);
    color: var(--state-warn);
  }

  .if-status-done {
    background: var(--state-ok-surface);
    color: var(--state-ok);
  }
</style>
