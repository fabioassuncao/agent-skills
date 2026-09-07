<script lang="ts">
  import { untrack } from 'svelte';
  import AgentStatusIcon, { agentIconVisible } from './AgentStatusIcon.svelte';
  import LinearBadge from './LinearBadge.svelte';
  import PrBadge from './PrBadge.svelte';
  import type { WorktreeListRow } from './types';
  import { worktreeCreationPhaseLabel } from './utils';
  import {
    OVERFLOW_STATUS_BAR_STATUSES,
    type OverflowStatusBarStatus,
    branchesWithAgentStatus,
    countAgentStatusesIn,
  } from './worktree-list';

  /**
   * The sidebar list.
   *
   * PORT of `frontend/src/lib/WorktreeList.svelte` @ d8c9d5f (474 lines). §50.3 makes
   * this the single sidebar list — Tasks and Sessions as two groups over the
   * same rows — and phase 8C adds the grouping; the row itself already carries
   * what it needs (`issueRef`, `executionId`).
   *
   * The overflow status bars are the part that looks elaborate and is not
   * decorative: with twenty worktrees, the one that is waiting on you is
   * usually off screen. An `IntersectionObserver` tracks whether each row is
   * above, inside or below the viewport, the two floating bars count what is
   * hidden in each direction, and clicking one scrolls to the next such row.
   *
   * Two details in there have specific reasons:
   *
   * - **`rootMargin` is measured, not guessed.** The bars sit 8px inside the
   *   list edges and would otherwise cover rows that the observer still reports
   *   as visible — the count would say zero while the row is behind the bar.
   * - **`branchKey` and `untrack`.** The observer is rebuilt only when rows are
   *   added or removed, not on every status poll; and pruning `rowPositions`
   *   inside `untrack` keeps the effect from re-running on its own write.
   */

  type RowPosition = 'above' | 'visible' | 'below';

  let openMenuBranch = $state<string | null>(null);

  let {
    rows,
    selected,
    removing,
    initializing,
    archiving,
    notifiedBranches,
    emptyMessage = 'Nenhum worktree encontrado.',
    onselect,
    onclose,
    onarchive,
    onmerge,
    onremove,
    oneditprofile,
    oncreatesubworktree,
    canPostToLinear = false,
    postingLinear = new Set<string>(),
    onposttolinear,
  }: {
    rows: WorktreeListRow[];
    selected: string | null;
    removing: Set<string>;
    initializing: Set<string>;
    archiving: Set<string>;
    notifiedBranches: Set<string>;
    emptyMessage?: string;
    onselect: (branch: string) => void;
    onclose: (branch: string) => void;
    onarchive: (branch: string) => void;
    onmerge: (branch: string) => void;
    onremove: (branch: string) => void;
    oneditprofile: (branch: string) => void;
    oncreatesubworktree: (branch: string) => void;
    canPostToLinear?: boolean;
    postingLinear?: Set<string>;
    onposttolinear?: (branch: string) => void;
  } = $props();

  function toggleMenu(branch: string): void {
    openMenuBranch = openMenuBranch === branch ? null : branch;
  }

  function runMenuAction(branch: string, action: (branch: string) => void): void {
    openMenuBranch = null;
    action(branch);
  }

  $effect(() => {
    if (!openMenuBranch) return;

    function handleDocumentClick(event: MouseEvent): void {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest('[data-worktree-row-menu]')) {
        openMenuBranch = null;
      }
    }

    function handleEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        openMenuBranch = null;
      }
    }

    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('click', handleDocumentClick);
      document.removeEventListener('keydown', handleEscape);
    };
  });

  let listEl = $state<HTMLUListElement | null>(null);
  let rowPositions = $state<Map<string, RowPosition>>(new Map());
  let cycleCursor = $state<Record<string, string>>({});

  // Measure the rendered bars (each sits `top-2`/`bottom-2` = 8px off the list
  // edge) so the observer's margins occlude exactly the band each bar covers —
  // no magic number.
  const BAR_OFFSET = 8;
  let topBarEl = $state<HTMLElement | null>(null);
  let bottomBarEl = $state<HTMLElement | null>(null);
  let topBarHeight = $state(0);
  let bottomBarHeight = $state(0);
  $effect(() => {
    topBarHeight = topBarEl?.offsetHeight ?? 0;
  });
  $effect(() => {
    bottomBarHeight = bottomBarEl?.offsetHeight ?? 0;
  });
  let rootMargin = $derived(
    `-${topBarHeight ? topBarHeight + BAR_OFFSET : 0}px 0px ` +
      `-${bottomBarHeight ? bottomBarHeight + BAR_OFFSET : 0}px 0px`,
  );

  // The identity of the rows present, independent of per-row status churn.
  let branchKey = $derived(rows.map((row) => row.worktree.branch).join('\n'));

  $effect(() => {
    const root = listEl;
    if (!root) return;
    void branchKey; // re-observe only when rows are added or removed
    const margin = rootMargin; // and when the measured bar band changes

    untrack(() => {
      const present = new Set(rows.map((row) => row.worktree.branch));
      const pruned = new Map([...rowPositions].filter(([branch]) => present.has(branch)));
      if (pruned.size !== rowPositions.size) rowPositions = pruned;
    });

    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const next = new Map(rowPositions);
        for (const entry of entries) {
          const target = entry.target;
          if (!(target instanceof HTMLElement)) continue;
          const branch = target.dataset.branch;
          if (!branch) continue;
          if (entry.isIntersecting) {
            next.set(branch, 'visible');
          } else {
            const rootTop = entry.rootBounds?.top ?? 0;
            next.set(branch, entry.boundingClientRect.top < rootTop ? 'above' : 'below');
          }
        }
        rowPositions = next;
      },
      // Negative top/bottom margins keep rows tucked behind the floating bars
      // counted as hidden.
      { root, rootMargin: margin, threshold: 0 },
    );
    for (const li of root.querySelectorAll('[data-branch]')) {
      observer.observe(li);
    }
    return () => observer.disconnect();
  });

  function branchesAt(position: RowPosition): Set<string> {
    const set = new Set<string>();
    for (const [branch, value] of rowPositions) {
      if (value === position) set.add(branch);
    }
    return set;
  }

  let aboveBranches = $derived(branchesAt('above'));
  let belowBranches = $derived(branchesAt('below'));
  let aboveCounts = $derived(countAgentStatusesIn(rows, aboveBranches, notifiedBranches));
  let belowCounts = $derived(countAgentStatusesIn(rows, belowBranches, notifiedBranches));
  let hasAbove = $derived(OVERFLOW_STATUS_BAR_STATUSES.some((s) => aboveCounts[s] > 0));
  let hasBelow = $derived(OVERFLOW_STATUS_BAR_STATUSES.some((s) => belowCounts[s] > 0));

  const statusLabels: Record<OverflowStatusBarStatus, string> = {
    waiting: 'aguardando',
    error: 'com falha',
    'done-unread': 'concluído e não visto',
  };

  function cycleToStatus(status: OverflowStatusBarStatus, direction: 'above' | 'below'): void {
    const branches = branchesWithAgentStatus(
      rows,
      status,
      direction === 'above' ? aboveBranches : belowBranches,
      notifiedBranches,
    );
    // Cycle nearest-to-the-fold first: rows below are already in that order,
    // rows above need reversing so the first click lands on the row just above
    // the fold.
    if (direction === 'above') branches.reverse();
    if (branches.length === 0 || !listEl) return;
    const key = `${direction}:${status}`;
    // Advance from the last branch scrolled to; if it has since scrolled into
    // view (no longer in the list), `indexOf` is -1 and it restarts from the
    // first.
    const nextIndex = (branches.indexOf(cycleCursor[key] ?? '') + 1) % branches.length;
    const nextBranch = branches[nextIndex];
    cycleCursor = { ...cycleCursor, [key]: nextBranch };
    const target = Array.from(listEl.querySelectorAll<HTMLElement>('[data-branch]')).find(
      (el) => el.dataset.branch === nextBranch,
    );
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
</script>

<div class="relative flex min-h-0 flex-1 flex-col">
  <ul bind:this={listEl} class="list-none overflow-y-auto flex-1 min-h-0 p-2">
    {#if rows.length === 0}
      <li class="px-3 py-4 text-xs text-muted text-center">{emptyMessage}</li>
    {/if}
    {#each rows as row (row.worktree.branch)}
      {@const wt = row.worktree}
      {@const isActive = wt.branch === selected}
      {@const isRemoving = removing.has(wt.branch)}
      {@const isClosed = wt.mux !== '✓'}
      {@const isInitializing = initializing.has(wt.branch)}
      {@const isArchiving = archiving.has(wt.branch)}
      {@const isCreating = wt.creating}
      {@const isArchived = wt.archived}
      {@const isBusy = isRemoving || isInitializing}
      {@const hasLabel = !!wt.label}
      {@const hasBadgeRow =
        isArchived ||
        isCreating ||
        isInitializing ||
        isClosed ||
        wt.prs.length > 0 ||
        !!wt.linearIssue ||
        !!wt.issueRef ||
        wt.source === 'oneshot'}
      <li
        data-branch={wt.branch}
        class="mb-0.5 group relative {isBusy ? 'opacity-40 pointer-events-none' : ''}"
      >
        <button
          type="button"
          disabled={isBusy}
          class="w-full py-2.5 rounded-md border cursor-pointer flex flex-col gap-1 text-left text-inherit text-sm bg-transparent hover:bg-hover {isActive
            ? 'bg-active border-accent'
            : 'border-transparent'} {isClosed && !isInitializing && !isCreating
            ? 'opacity-50'
            : ''} {isArchived ? 'opacity-70' : ''}"
          style={`padding-left:${12 + row.depth * 18}px; padding-right:40px;`}
          onclick={() => {
            openMenuBranch = null;
            onselect(wt.branch);
          }}
        >
          <span class="flex min-w-0 items-start gap-2 pr-5">
            {#if row.depth > 0}
              <span class="shrink-0 text-muted" aria-hidden="true">↳</span>
            {/if}
            <span class="min-w-0 flex flex-1 flex-col gap-1">
              <span class="flex min-w-0 items-center gap-1.5" data-worktree-name-row>
                <span class="min-w-0 flex flex-1 flex-col">
                  <span class="font-medium truncate">{wt.label ?? wt.branch}</span>
                  {#if hasLabel}
                    <span class="text-[10px] leading-tight text-muted truncate">{wt.branch}</span>
                  {/if}
                </span>
                {#if !isCreating && !isInitializing && !isClosed && agentIconVisible(wt.agent, notifiedBranches.has(wt.branch))}
                  <span class="shrink-0"
                    ><AgentStatusIcon
                      status={wt.agent}
                      size={14}
                      unread={notifiedBranches.has(wt.branch)}
                    /></span
                  >
                {/if}
              </span>
              {#if hasBadgeRow}
                <span class="flex min-w-0 flex-wrap items-center gap-1.5" data-worktree-badge-row>
                  {#if wt.source === 'oneshot'}
                    <span
                      class="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-edge text-muted"
                      title="Execução autônoma — fecha sozinha ao terminar"
                    >
                      autônoma
                    </span>
                  {/if}
                  {#if isArchived}
                    <span
                      class="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-edge text-muted"
                    >
                      arquivado
                    </span>
                  {/if}
                  {#if isCreating}
                    <span class="shrink-0 inline-flex items-center gap-1 text-[10px] text-muted">
                      <span class="spinner"></span>
                      {worktreeCreationPhaseLabel(wt.creationPhase)}…
                    </span>
                  {:else if isInitializing}
                    <span class="shrink-0 text-[10px] text-muted">abrindo…</span>
                  {:else if isClosed}
                    <span class="shrink-0 text-[10px] text-muted">fechado</span>
                  {/if}
                  {#each wt.prs as pr (`${pr.repo}#${pr.number}`)}
                    <PrBadge {pr} />
                  {/each}
                  {#if wt.linearIssue}
                    <LinearBadge issue={wt.linearIssue} />
                  {/if}
                  {#if wt.issueRef}
                    <span
                      class="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-edge text-muted"
                      title="Issue vinculada"
                    >
                      {wt.issueRef}
                    </span>
                  {/if}
                </span>
              {/if}
            </span>
          </span>
          <span class="flex gap-2 text-[11px] text-muted items-center flex-wrap">
            {#if wt.agentLabel ?? wt.agentName}
              <span>{wt.agentLabel ?? wt.agentName}</span>
            {/if}
            {#if wt.profile}
              <span>{wt.profile}</span>
            {/if}
          </span>
          {#if wt.services.length > 0}
            <span class="flex gap-2 text-[11px] text-muted font-mono">
              {#each wt.services as svc (svc.name)}
                {#if svc.port}
                  <span class={svc.running ? 'text-success' : ''}>{svc.name}:{svc.port}</span>
                {/if}
              {/each}
            </span>
          {/if}
        </button>
        <button
          type="button"
          disabled={isBusy}
          class="absolute top-2 right-2 w-6 h-6 rounded flex items-center justify-center text-muted hover:text-primary hover:bg-hover opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
          title="Ações do worktree"
          aria-label={`Ações de ${wt.branch}`}
          aria-haspopup="menu"
          aria-expanded={openMenuBranch === wt.branch}
          onclick={(event) => {
            event.stopPropagation();
            toggleMenu(wt.branch);
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="5" r="1" />
            <circle cx="12" cy="12" r="1" />
            <circle cx="12" cy="19" r="1" />
          </svg>
        </button>
        {#if openMenuBranch === wt.branch}
          <div
            class="absolute top-9 right-2 z-10 min-w-32 rounded-md border border-edge bg-surface shadow-lg p-1"
            data-worktree-row-menu
          >
            <button
              type="button"
              disabled={isClosed || isCreating}
              class="w-full px-2 py-1.5 rounded text-left text-xs text-primary hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
              onclick={(event) => {
                event.stopPropagation();
                runMenuAction(wt.branch, onclose);
              }}
            >
              Fechar
            </button>
            <button
              type="button"
              disabled={isCreating || isArchiving}
              class="w-full px-2 py-1.5 rounded text-left text-xs text-primary hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
              onclick={(event) => {
                event.stopPropagation();
                runMenuAction(wt.branch, onarchive);
              }}
            >
              {wt.archived ? 'Restaurar' : 'Arquivar'}
            </button>
            <button
              type="button"
              disabled={isCreating}
              class="w-full px-2 py-1.5 rounded text-left text-xs text-primary hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
              onclick={(event) => {
                event.stopPropagation();
                runMenuAction(wt.branch, oneditprofile);
              }}
            >
              Trocar profile…
            </button>
            <button
              type="button"
              class="w-full px-2 py-1.5 rounded text-left text-xs text-primary hover:bg-hover"
              onclick={(event) => {
                event.stopPropagation();
                runMenuAction(wt.branch, onmerge);
              }}
            >
              Integrar
            </button>
            <button
              type="button"
              disabled={isCreating}
              class="w-full px-2 py-1.5 rounded text-left text-xs text-primary hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
              onclick={(event) => {
                event.stopPropagation();
                runMenuAction(wt.branch, oncreatesubworktree);
              }}
            >
              Criar worktree derivado
            </button>
            {#if canPostToLinear && onposttolinear}
              <button
                type="button"
                disabled={isCreating || postingLinear.has(wt.branch)}
                class="w-full px-2 py-1.5 rounded text-left text-xs text-primary hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
                onclick={(event) => {
                  event.stopPropagation();
                  runMenuAction(wt.branch, onposttolinear);
                }}
              >
                {postingLinear.has(wt.branch)
                  ? 'Enviando ao Linear…'
                  : wt.linearIssue
                    ? `Enviar conversa para ${wt.linearIssue.identifier}`
                    : 'Enviar conversa ao Linear…'}
              </button>
            {/if}
            <button
              type="button"
              class="w-full px-2 py-1.5 rounded text-left text-xs text-danger hover:bg-hover"
              onclick={(event) => {
                event.stopPropagation();
                runMenuAction(wt.branch, onremove);
              }}
            >
              Remover
            </button>
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  {#if hasAbove}
    <div bind:this={topBarEl} class="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
      {@render statusBar(aboveCounts, 'above')}
    </div>
  {/if}
  {#if hasBelow}
    <div
      bind:this={bottomBarEl}
      class="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center"
    >
      {@render statusBar(belowCounts, 'below')}
    </div>
  {/if}
</div>

{#snippet statusBar(counts: Record<OverflowStatusBarStatus, number>, direction: 'above' | 'below')}
  <div
    class="pointer-events-auto flex items-center gap-1 rounded-full border border-edge bg-surface px-1.5 py-1 shadow-lg"
  >
    {#each OVERFLOW_STATUS_BAR_STATUSES as status (status)}
      {#if counts[status] > 0}
        <button
          type="button"
          class="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums hover:bg-hover cursor-pointer"
          title={`Ir para o próximo worktree ${statusLabels[status]} ${
            direction === 'above' ? 'acima' : 'abaixo'
          }`}
          onclick={() => cycleToStatus(status, direction)}
        >
          <AgentStatusIcon
            status={status === 'done-unread' ? 'done' : status}
            unread={status === 'done-unread'}
            size={12}
          />
          <span>{counts[status]}</span>
        </button>
      {/if}
    {/each}
  </div>
{/snippet}
