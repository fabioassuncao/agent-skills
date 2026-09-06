<script lang="ts">
  import type { WorktreeTab } from './types';

  /**
   * PORT of `frontend/src/lib/TabBar.svelte` @ d8c9d5f (55 lines).
   *
   * Session tabs over the terminal: `tabs[0]` is the root and only forks can be
   * closed, which is why the close button is conditional on `kind`.
   */

  let {
    tabs,
    activeTabId,
    busy = false,
    oncreate,
    onselect,
    ondelete,
  }: {
    tabs: WorktreeTab[];
    activeTabId: string | null;
    busy?: boolean;
    oncreate: () => void;
    onselect: (tabId: string) => void;
    ondelete: (tabId: string) => void;
  } = $props();
</script>

<nav
  class="flex items-stretch bg-topbar border-b border-edge overflow-x-auto tab-bar"
  aria-label="Sessões"
>
  {#each tabs as tab (tab.tabId)}
    <div class="flex items-center border-r border-edge {activeTabId === tab.tabId ? 'tab-active' : ''}">
      <button
        type="button"
        aria-current={activeTabId === tab.tabId ? 'true' : undefined}
        class="px-3 py-2 text-sm font-medium whitespace-nowrap cursor-pointer border-none bg-transparent {activeTabId ===
        tab.tabId
          ? 'text-accent'
          : 'text-muted hover:text-accent'}"
        onclick={() => onselect(tab.tabId)}
      >
        {tab.label}
      </button>
      {#if tab.kind === 'fork'}
        <button
          type="button"
          aria-label={`Fechar ${tab.label}`}
          class="mr-1.5 flex items-center justify-center w-5 h-5 rounded text-muted cursor-pointer border-none bg-transparent hover:text-danger hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={busy}
          onclick={() => ondelete(tab.tabId)}
        >
          ×
        </button>
      {/if}
    </div>
  {/each}
  <button
    type="button"
    aria-label="Nova sessão derivada"
    title="Nova sessão derivada"
    class="px-3 py-2 text-sm text-muted cursor-pointer border-none bg-transparent hover:text-accent disabled:opacity-50 disabled:cursor-not-allowed"
    disabled={busy}
    onclick={() => oncreate()}
  >
    +
  </button>
</nav>

<style>
  .tab-active {
    box-shadow: inset 0 -2px 0 0 var(--accent);
  }
</style>
