<script lang="ts">
  /**
   * PORT of `frontend/src/lib/PaneBar.svelte` @ d8c9d5f (28 lines).
   *
   * The mobile pane selector. `env(safe-area-inset-bottom)` is not cosmetic:
   * without it the bar sits under the home indicator on a notched phone and
   * the last pane cannot be tapped.
   */

  let {
    activePane,
    panes,
    onselect,
  }: {
    activePane: number;
    panes: { index: number; label: string }[];
    onselect: (pane: number) => void;
  } = $props();
</script>

<nav class="flex items-stretch bg-topbar border-t border-edge pane-bar" aria-label="Painéis">
  {#each panes as p (p.index)}
    <button
      type="button"
      aria-current={activePane === p.index ? 'true' : undefined}
      class="flex-1 py-3 text-sm font-medium cursor-pointer border-none bg-transparent {activePane ===
      p.index
        ? 'text-accent pane-active'
        : 'text-muted'}"
      onclick={() => onselect(p.index)}
    >
      {p.label}
    </button>
  {/each}
</nav>

<style>
  .pane-bar {
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .pane-active {
    box-shadow: inset 0 2px 0 0 var(--accent);
  }
</style>
