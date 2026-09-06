<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * PORT of `frontend/src/lib/BaseDialog.svelte` @ d8c9d5f (46 lines).
   *
   * `pressStartedOnBackdrop` is the detail worth keeping: a click closes the
   * dialog only when the press *started* on the backdrop. Without it, selecting
   * text inside the dialog and releasing outside it closes the dialog and
   * throws away whatever the user was doing.
   */

  let {
    onclose,
    wide = false,
    maxWidth = '',
    className = '',
    children,
  }: {
    onclose: () => void;
    wide?: boolean;
    maxWidth?: string;
    className?: string;
    children: Snippet;
  } = $props();

  let dialogEl: HTMLDialogElement;
  let pressStartedOnBackdrop = false;

  $effect(() => {
    dialogEl?.showModal();
  });
</script>

<dialog
  bind:this={dialogEl}
  {onclose}
  onmousedown={(e: MouseEvent) => {
    pressStartedOnBackdrop = e.target === dialogEl;
  }}
  onclick={(e: MouseEvent) => {
    if (e.target === dialogEl && pressStartedOnBackdrop) dialogEl.close();
    pressStartedOnBackdrop = false;
  }}
  class="bg-surface text-primary border border-edge rounded-xl w-[90%] {maxWidth
    ? ''
    : wide
      ? 'max-w-[560px]'
      : 'max-w-[380px]'} {className}"
  style:max-width={maxWidth || undefined}
>
  <div class="p-6">
    {@render children()}
  </div>
</dialog>
