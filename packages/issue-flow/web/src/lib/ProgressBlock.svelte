<script lang="ts">
  import { formatAgo, formatClock, formatDuration, formatUsage, itemSideText } from './format';
  import type { ExecutionSnapshot } from './snapshot';
  import { phaseIcon, STORY_STAGE_LABELS, STORY_STATUS_LABELS } from './vocabulary';

  /**
   * "Andamento" — the third of the four blocks (U9).
   *
   * PORT of `renderPhases` and `renderStories`. Every row opens the drawer, by
   * click and by Enter/Space, and carries its metrics in the shared side slot:
   * duration and usage joined by ` · `, with empty parts dropping out — an empty
   * string is the signal not to render the slot, not to render an empty one.
   */

  let {
    snapshot,
    now,
    onopenphase,
    onopenstory,
  }: {
    snapshot: ExecutionSnapshot;
    now: number;
    onopenphase: (name: string) => void;
    onopenstory: (id: string) => void;
  } = $props();
</script>

<section class="if-card">
  <h2>Andamento</h2>

  <div class="if-part">
    <h3>Fases</h3>
    {#if snapshot.phases.length === 0}
      <p class="if-empty">Nenhuma fase registrada ainda.</p>
    {:else}
      <ol class="if-list">
        {#each snapshot.phases as phase (phase.name)}
          <li>
            <button type="button" class="if-row if-clickable" onclick={() => onopenphase(phase.name)}>
              <span class="if-icon if-icon-{phase.status}" aria-hidden="true"
                >{phaseIcon(phase.status)}</span
              >
              <span class="if-row-main">
                <span class="if-title">{phase.name}</span>
                {#if phase.error}<span class="if-error">{phase.error}</span>{/if}
              </span>
              {#if itemSideText([phase.durationSeconds === null ? '' : formatDuration(phase.durationSeconds), formatUsage(phase)])}
                <span class="if-row-side"
                  >{itemSideText([
                    phase.durationSeconds === null ? '' : formatDuration(phase.durationSeconds),
                    formatUsage(phase),
                  ])}</span
                >
              {/if}
            </button>
          </li>
        {/each}
      </ol>
    {/if}
  </div>

  <div class="if-part">
    <h3>User stories</h3>
    {#if snapshot.stories.length === 0}
      <p class="if-empty">Nenhuma user story registrada ainda.</p>
    {:else}
      <ol class="if-list">
        {#each snapshot.stories as story (story.id)}
          <li>
            <button
              type="button"
              class="if-row if-clickable"
              class:if-story-executing={story.stage === 'executing'}
              onclick={() => onopenstory(story.id)}
            >
              <span
                class="if-icon"
                class:if-icon-completed={story.passes}
                class:if-icon-pending={!story.passes}
                aria-hidden="true">{story.passes ? '✓' : '○'}</span
              >
              <span class="if-row-main">
                <span class="if-title"
                  ><span class="if-story-id if-mono">{story.id}</span>{story.title}</span
                >
                <span class="if-story-meta">
                  <span class="if-badge if-status-{story.status}"
                    >{STORY_STATUS_LABELS[story.status]}</span
                  >
                  {#if story.dependencies.length > 0}
                    <span class="if-muted">depende de: {story.dependencies.join(', ')}</span>
                  {/if}
                </span>
              </span>
              {#if itemSideText([story.stageSince ? `${STORY_STAGE_LABELS[story.stage]} ${formatAgo(story.stageSince, now)}` : STORY_STAGE_LABELS[story.stage], story.completedAt ? `concluída ${formatClock(story.completedAt)}` : '', story.durationSeconds === null ? '' : formatDuration(story.durationSeconds), formatUsage(story)])}
                <span class="if-row-side"
                  >{itemSideText([
                    story.stageSince
                      ? `${STORY_STAGE_LABELS[story.stage]} ${formatAgo(story.stageSince, now)}`
                      : STORY_STAGE_LABELS[story.stage],
                    story.completedAt ? `concluída ${formatClock(story.completedAt)}` : '',
                    story.durationSeconds === null ? '' : formatDuration(story.durationSeconds),
                    formatUsage(story),
                  ])}</span
                >
              {/if}
            </button>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</section>

<style>
  /*
    A row is a `<button>`, so Enter/Space and focus come for free — which is why
    everything inside it is phrasing content (`<span>`), never `<div>`/`<p>`.
  */
  .if-clickable {
    width: 100%;
    border: none;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .if-clickable:hover {
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--border);
  }

  .if-icon {
    flex: 0 0 auto;
    font-size: var(--font-size-md);
  }

  .if-icon-pending {
    color: var(--text-subtle);
  }

  .if-icon-running {
    color: var(--state-run);
  }

  .if-icon-completed {
    color: var(--state-ok);
  }

  .if-icon-failed {
    color: var(--state-error);
  }

  .if-title {
    display: block;
    font-size: var(--font-size-md);
    overflow-wrap: anywhere;
  }

  .if-story-id {
    color: var(--text-muted);
    margin-right: var(--space-8);
  }

  .if-story-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8);
    margin-top: var(--space-4);
    font-size: var(--font-size-sm);
    min-width: 0;
  }

  .if-error {
    display: block;
    color: var(--state-error);
    font-size: var(--font-size-sm);
    margin-top: var(--space-4);
  }

  /*
    The inset shadow eats into the row, so the padding discounts it to keep the
    vertical rhythm. One of the three documented exceptions to the scale.
  */
  .if-story-executing {
    box-shadow: inset 0 0 0 2px var(--state-run);
    padding: calc(var(--space-8) - 2px);
  }

  .if-status-backlog {
    background: var(--surface);
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
