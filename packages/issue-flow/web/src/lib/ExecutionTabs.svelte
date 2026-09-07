<script module lang="ts">
  export interface TabDefinition {
    id: string;
    label: string;
  }

  /**
   * Where the arrow keys move from `current`. Exported so the ARIA contract is
   * testable without a DOM, and reused by the component below.
   *
   * Returns `null` for a key the tablist does not own, which is what keeps
   * Tab, Escape and everything else working normally.
   */
  export function nextTabIndex(key: string, current: number, count: number): number | null {
    if (count === 0) return null;
    if (key === 'ArrowRight') return (current + 1) % count;
    if (key === 'ArrowLeft') return (current - 1 + count) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return null;
  }
</script>

<script lang="ts">
  /**
   * The ARIA tablist (U5).
   *
   * PORT of `setActiveTab`/`onTabListKeydown`. The pattern is the whole point:
   * ←/→ move between tabs, Home/End go to the ends, and **only the active tab is
   * in the Tab order** (roving `tabindex`) — a tablist where every tab is
   * tabbable makes the keyboard user walk through all of them to leave.
   *
   * Switching a tab changes visibility and ARIA state and **nothing else**. The
   * panels are all rendered on every update, so an inactive tab is never stale
   * — which is also why the drawer stays current while the Kanban is hidden.
   */

  let {
    tabs,
    active,
    onselect,
    label = 'Visualizações do painel',
  }: {
    tabs: readonly TabDefinition[];
    active: string;
    onselect: (id: string) => void;
    label?: string;
  } = $props();

  let buttons: HTMLButtonElement[] = $state([]);

  function handleKeydown(event: KeyboardEvent): void {
    const current = tabs.findIndex((tab) => tab.id === active);
    if (current === -1) return;
    const next = nextTabIndex(event.key, current, tabs.length);
    if (next === null) return;
    event.preventDefault();
    onselect(tabs[next].id);
    buttons[next]?.focus();
  }
</script>

<!--
  `tabindex="-1"` on the tablist itself: the roving tabindex lives on the tabs,
  so the container must be focusable-by-script but never in the Tab order.
-->
<div
  class="if-tabs"
  role="tablist"
  aria-label={label}
  tabindex="-1"
  onkeydown={handleKeydown}
>
  {#each tabs as tab, index (tab.id)}
    <button
      type="button"
      role="tab"
      id={`tab-${tab.id}`}
      class="if-tab"
      class:is-active={tab.id === active}
      aria-controls={`panel-${tab.id}`}
      aria-selected={tab.id === active}
      tabindex={tab.id === active ? 0 : -1}
      bind:this={buttons[index]}
      onclick={() => onselect(tab.id)}>{tab.label}</button
    >
  {/each}
</div>

<style>
  .if-tabs {
    display: flex;
    gap: var(--space-4);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }

  .if-tab {
    background: none;
    border: none;
    /* Compensates the container's own border so the active tab sits on it.
       Alignment, not spacing — this is one of the documented exceptions to the
       closed scale. */
    margin-bottom: -1px;
    border-bottom: 2px solid transparent;
    padding: var(--space-8) var(--space-12);
    color: var(--text-muted);
    font-size: var(--font-size-md);
    white-space: nowrap;
    cursor: pointer;
  }

  .if-tab.is-active {
    color: var(--text);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
</style>
