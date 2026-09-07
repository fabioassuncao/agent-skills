<script module lang="ts">
  import type { ExecutionSnapshot, SnapshotExecution } from './snapshot';

  /**
   * Which executions are a review of the work rather than the work itself.
   *
   * The three purposes `telemetry/types.ts` declares for looking at what was
   * produced. `execute` and the planning purposes are deliberately absent: a
   * screen that listed every execution would not be a review screen.
   */
  export const REVIEW_PURPOSES: readonly string[] = ['review', 'pr-review', 'verify'];

  export function reviewExecutions(
    snapshot: ExecutionSnapshot | null,
  ): readonly SnapshotExecution[] {
    if (snapshot === null) return [];
    return snapshot.executions.filter((execution) =>
      REVIEW_PURPOSES.includes(execution.purpose),
    );
  }
</script>

<script lang="ts">
  import PrBadge from './PrBadge.svelte';
  import { formatClock } from './format';
  import type { PrEntry } from './types';

  /**
   * "Review" — I6, and the §50.3 merge that has to happen on **one** screen.
   *
   * The two products each had half of it: the Issue Flow knows what its own
   * independent reviewer concluded, and WebMux knows what people wrote on the
   * pull request. §50.2's decision for the row is `M` — *one* panel with both —
   * and this is it. Two tabs would have been the two interfaces again.
   *
   * The reviewer's half is read from the executions the pipeline recorded, and
   * a verdict nobody reached shows as `—`: the same rule U21 states for
   * verification, applied to a review. The pull-request half is read from the
   * entries the display sync of §20 observed; without that sync the section
   * says so instead of pretending the pull request has no comments.
   */

  let {
    snapshot = null,
    pullRequests = [],
    hasPullRequestSync = false,
    onopencomments = null,
  }: {
    snapshot?: ExecutionSnapshot | null;
    pullRequests?: readonly PrEntry[];
    hasPullRequestSync?: boolean;
    onopencomments?: ((pr: PrEntry) => void) | null;
  } = $props();

  let reviews = $derived(reviewExecutions(snapshot));
  let commented = $derived(pullRequests.filter((pr) => pr.comments.length > 0));
</script>

<section class="if-card">
  <h2>Review</h2>

  <div class="if-part">
    <h3>Achados do revisor</h3>
    {#if reviews.length === 0}
      <p class="if-empty">Nenhuma revisão registrada nesta execução.</p>
    {:else}
      <ul class="if-list">
        {#each reviews as execution (execution.id)}
          <li class="if-row">
            <span class="if-row-main">
              <span class="rv-title"
                >{execution.purpose} · tentativa {execution.attempt ?? '—'}</span
              >
              <span class="rv-meta if-muted">
                <span>veredito: {execution.verdict ?? '—'}</span>
                <span>{execution.status}</span>
                {#if execution.finishedAt}<span>{formatClock(execution.finishedAt)}</span>{/if}
              </span>
              {#if execution.failure}
                <span class="rv-failure">{execution.failure}</span>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="if-part">
    <h3>Comentários do pull request</h3>
    {#if !hasPullRequestSync}
      <p class="if-empty">
        Este monitor não consulta o GitHub, então não há comentários para mostrar.
      </p>
    {:else if commented.length === 0}
      <p class="if-empty">Nenhum comentário nos pull requests desta branch.</p>
    {:else}
      <ul class="if-list">
        {#each commented as pr (pr.url)}
          <li class="if-row">
            <PrBadge {pr} clickable />
            <span class="if-row-main">
              <span class="rv-title"
                >{pr.comments.length}
                {pr.comments.length === 1 ? 'comentário' : 'comentários'}</span
              >
              <span class="rv-meta if-muted">
                {#each pr.comments.slice(0, 3) as comment, index (index)}
                  <span>{comment.author}{comment.path ? ` · ${comment.path}` : ''}</span>
                {/each}
              </span>
            </span>
            {#if onopencomments}
              <button type="button" class="rv-open" onclick={() => onopencomments?.(pr)}
                >Ver e responder</button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  .rv-title {
    display: block;
    font-size: var(--font-size-md);
    overflow-wrap: anywhere;
  }

  .rv-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-8);
    margin-top: var(--space-4);
    font-size: var(--font-size-sm);
    /* U20: `min-width: auto` refuses to shrink below the content, and a long
       branch name would then push the page wider than the viewport. */
    min-width: 0;
  }

  .rv-failure {
    display: block;
    margin-top: var(--space-4);
    color: var(--state-error);
    font-size: var(--font-size-sm);
  }

  .rv-open {
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
