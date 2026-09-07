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

  function handleTabKeydown(event: KeyboardEvent, tabId: string): void {
    if (busy) return;
    const current = tabs.findIndex((tab) => tab.tabId === tabId);
    if (current < 0) return;
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const nextTab = tabs[next];
    if (!nextTab) return;
    onselect(nextTab.tabId);
    const tabList = (event.currentTarget as HTMLElement).closest('[role="tablist"]');
    (tabList?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next] ?? null)?.focus();
  }
</script>

<div
  class="flex items-stretch bg-topbar border-b border-edge overflow-x-auto tab-bar"
  aria-label="Sessões"
  role="tablist"
>
  {#each tabs as tab (tab.tabId)}
    <div class="flex items-center border-r border-edge {activeTabId === tab.tabId ? 'tab-active' : ''}">
      <button
        type="button"
        role="tab"
        aria-selected={activeTabId === tab.tabId}
        tabindex={activeTabId === tab.tabId ? 0 : -1}
        class="px-3 py-2 text-sm font-medium whitespace-nowrap cursor-pointer border-none bg-transparent {activeTabId ===
        tab.tabId
          ? 'text-accent'
          : 'text-muted hover:text-accent'}"
        onclick={() => onselect(tab.tabId)}
        onkeydown={(event) => handleTabKeydown(event, tab.tabId)}
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
</div>

<style>
  .tab-active {
    box-shadow: inset 0 -2px 0 0 var(--accent);
  }
</style>
