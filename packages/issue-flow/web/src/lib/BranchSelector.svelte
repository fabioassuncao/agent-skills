<script lang="ts">
  import Toggle from './Toggle.svelte';
  import type { AvailableBranch } from './types';
  import { searchMatch } from './utils';

  /**
   * PORT of `frontend/src/lib/BranchSelector.svelte` @ d8c9d5f (227 lines).
   *
   * Two details that look like noise and are not:
   *
   * - **`onmousedown={(e) => e.preventDefault()}` on every option.** Selecting
   *   an option moves focus out of the search input, `focusout` closes the
   *   dropdown, and the click never lands on the option it was aimed at.
   *   Preventing the default keeps focus where it is until `onclick` runs.
   * - **`preserveMouseFocus` on the inline toggle row**, for the same reason,
   *   as an action so the behaviour is attached rather than repeated.
   *
   * The dropdown reports "updating" and "update failed" separately from
   * "loading" and "load failed": a refresh that fails while a stale list is on
   * screen is a different situation from having no list at all.
   */

  let {
    label,
    selected = '',
    branches = [],
    loading = false,
    error = null,
    placeholder = 'Selecione uma branch',
    initialOpen = false,
    disabled = false,
    inlineToggleLabel,
    inlineToggleAriaLabel,
    inlineToggleChecked = false,
    oninlinetoggle,
    onselect,
  }: {
    label: string;
    selected?: string;
    branches?: AvailableBranch[];
    loading?: boolean;
    error?: string | null;
    placeholder?: string;
    initialOpen?: boolean;
    disabled?: boolean;
    inlineToggleLabel?: string;
    inlineToggleAriaLabel?: string;
    inlineToggleChecked?: boolean;
    oninlinetoggle?: () => void;
    onselect: (branch: string) => void;
  } = $props();

  let selectorOpen = $state(false);
  let searchQuery = $state('');
  let fieldEl = $state<HTMLDivElement | undefined>(undefined);
  let searchEl = $state<HTMLInputElement | undefined>(undefined);
  let autoOpened = $state(false);
  let autoFocused = $state(false);

  let filteredBranches = $derived(
    searchQuery.trim()
      ? branches.filter((branch) => searchMatch(searchQuery, branch.name))
      : branches,
  );

  $effect(() => {
    if (!initialOpen || autoOpened) return;
    autoOpened = true;
    selectorOpen = true;
  });

  $effect(() => {
    if (!selectorOpen || autoFocused) return;
    autoFocused = true;
    focusSearch();
  });

  function focusSearch(): void {
    queueMicrotask(() => searchEl?.focus());
  }

  function closeSelector(): void {
    selectorOpen = false;
    searchQuery = '';
    autoFocused = false;
  }

  function toggleSelector(): void {
    if (selectorOpen) {
      closeSelector();
      return;
    }
    selectorOpen = true;
  }

  function selectBranch(name: string): void {
    onselect(name);
    closeSelector();
  }

  function handleFocusOut(event: FocusEvent): void {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && fieldEl?.contains(nextTarget)) {
      return;
    }
    closeSelector();
  }

  function toggleInlineControl(): void {
    oninlinetoggle?.();
  }

  function preserveMouseFocus(node: HTMLElement, enabled: boolean) {
    function handleMouseDown(event: MouseEvent): void {
      if (!enabled) return;
      event.preventDefault();
    }

    node.addEventListener('mousedown', handleMouseDown);

    return {
      update(nextEnabled: boolean): void {
        enabled = nextEnabled;
      },
      destroy(): void {
        node.removeEventListener('mousedown', handleMouseDown);
      },
    };
  }
</script>

<div bind:this={fieldEl} onfocusout={handleFocusOut}>
  <span class="block text-xs text-muted mb-1.5">{label}</span>
  <button
    type="button"
    {disabled}
    class="flex w-full items-center justify-between gap-3 rounded-md border border-edge bg-surface px-2.5 py-1.5 text-left text-[13px] text-primary outline-none transition-colors hover:bg-hover focus:border-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-surface"
    aria-label={label}
    aria-expanded={disabled ? undefined : selectorOpen}
    onclick={toggleSelector}
  >
    <span class={selected ? 'font-mono' : 'text-muted/50'}>
      {selected || placeholder}
    </span>
    {#if !disabled}
      <span class="text-[11px] text-muted" aria-hidden="true">{selectorOpen ? '▴' : '▾'}</span>
    {/if}
  </button>
  {#if selectorOpen && !disabled}
    <div class="mt-2 rounded-lg border border-edge bg-surface">
      <div class="border-b border-edge p-2">
        <input
          bind:this={searchEl}
          type="text"
          class="w-full rounded-md border border-edge bg-surface px-2.5 py-1.5 text-[12px] text-primary placeholder:text-muted/50 outline-none focus:border-accent"
          aria-label={`Buscar em ${label}`}
          placeholder="Buscar branches…"
          bind:value={searchQuery}
          onkeydown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (filteredBranches[0]) {
                selectBranch(filteredBranches[0].name);
              }
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              closeSelector();
            }
          }}
        />
      </div>
      <div
        use:preserveMouseFocus={!!oninlinetoggle}
        class="border-b border-edge px-3 py-2 text-[11px] text-muted flex items-center justify-between gap-3"
      >
        <div class="min-w-0 flex items-center gap-2">
          {#if loading && filteredBranches.length === 0}
            <span>Carregando…</span>
          {:else if error && filteredBranches.length === 0}
            <span>Falha ao carregar</span>
          {:else}
            <span>
              {filteredBranches.length !== branches.length
                ? `${filteredBranches.length}/${branches.length}`
                : branches.length}
              {' '}disponíveis
            </span>
          {/if}
          {#if loading && filteredBranches.length > 0}
            <span class="shrink-0 text-[10px] text-warning">Atualizando…</span>
          {:else if error && filteredBranches.length > 0}
            <span class="shrink-0 text-[10px] text-danger">Falha ao atualizar</span>
          {/if}
        </div>
        {#if inlineToggleLabel && oninlinetoggle}
          <div class="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              class="text-[10px] text-muted hover:text-primary transition-colors"
              onmousedown={(event) => event.preventDefault()}
              onclick={toggleInlineControl}
            >
              {inlineToggleLabel}
            </button>
            <Toggle
              checked={inlineToggleChecked}
              size="sm"
              preventMouseFocus={true}
              aria-label={inlineToggleAriaLabel ?? inlineToggleLabel}
              ontoggle={toggleInlineControl}
            />
          </div>
        {/if}
      </div>
      {#if loading && filteredBranches.length === 0}
        <p class="px-3 py-2 text-xs text-muted">Carregando branches…</p>
      {:else if error && filteredBranches.length === 0}
        <p class="px-3 py-2 text-xs text-muted">Falha ao carregar as branches: {error}</p>
      {:else if filteredBranches.length === 0}
        <p class="px-3 py-2 text-xs text-muted">Nenhuma branch corresponde</p>
      {:else}
        <ul class="max-h-48 overflow-y-auto py-1">
          {#each filteredBranches as branch (branch.name)}
            <li>
              <button
                type="button"
                class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[12px] transition-colors hover:bg-hover
                  {selected === branch.name ? 'bg-accent/10' : ''}"
                onmousedown={(e) => e.preventDefault()}
                onclick={() => selectBranch(branch.name)}
              >
                <span class="font-mono text-primary">{branch.name}</span>
                {#if selected === branch.name}
                  <span class="text-[10px] text-accent">Selecionada</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
