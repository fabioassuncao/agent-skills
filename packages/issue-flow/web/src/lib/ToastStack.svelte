<script lang="ts">
  import type { ToastItem, ToastTone } from './types';

  /**
   * PORT of `frontend/src/lib/ToastStack.svelte` @ d8c9d5f (86 lines).
   *
   * Toasts and the panel's `#alerts` region coexist with distinct jobs
   * (§50.3): a toast is feedback about an action the user just took and it
   * disappears; `#alerts` is persistent state of the execution and it does not.
   * Neither replaces the other.
   */

  let {
    toasts,
    ondismiss,
    onselect,
  }: {
    toasts: ToastItem[];
    ondismiss: (id: string) => void;
    onselect?: (id: string) => void;
  } = $props();

  function iconForTone(tone: ToastTone): string {
    if (tone === 'success') return '✓';
    if (tone === 'error') return '✗';
    return '☑';
  }

  function toneClass(tone: ToastTone): string {
    if (tone === 'success') return 'text-success';
    if (tone === 'error') return 'text-danger';
    return 'text-accent';
  }
</script>

{#if toasts.length > 0}
  <div class="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
    {#each toasts as toast (toast.id)}
      {#snippet body(item: ToastItem)}
        <span class="shrink-0 text-base {toneClass(item.tone)}">{iconForTone(item.tone)}</span>
        <span class="flex flex-col gap-0.5 min-w-0">
          <span class="text-sm text-primary whitespace-normal break-words">{item.message}</span>
          {#if item.detail}
            <span class="text-xs text-accent whitespace-normal break-all">{item.detail}</span>
          {/if}
        </span>
      {/snippet}
      <div class="toast w-fit max-w-[min(48ch,calc(100vw-2rem))]" role="alert">
        {#if onselect && toast.source === 'notification'}
          <button
            type="button"
            class="min-w-0 flex items-start gap-2 text-left bg-transparent border-none text-inherit cursor-pointer p-0"
            onclick={() => onselect(toast.id)}
          >
            {@render body(toast)}
          </button>
        {:else}
          <div class="min-w-0 flex items-start gap-2 text-inherit">
            {@render body(toast)}
          </div>
        {/if}
        <button
          type="button"
          aria-label="Dispensar aviso"
          class="shrink-0 w-6 h-6 flex items-center justify-center text-muted hover:text-primary cursor-pointer bg-transparent border-none text-sm"
          onclick={() => ondismiss(toast.id)}
        >&times;</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast {
    display: flex;
    align-items: flex-start;
    gap: var(--space-8);
    padding: var(--space-12);
    border-radius: var(--radius-medium);
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: 0 4px 12px var(--overlay);
    animation: slide-in 0.2s ease-out;
  }

  @keyframes slide-in {
    from {
      opacity: 0;
      transform: translateX(1rem);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
</style>
