<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  /** PORT of `frontend/src/lib/LinkBtn.svelte` @ d8c9d5f (19 lines). */

  let {
    children,
    ...rest
  }: HTMLButtonAttributes & {
    children: Snippet;
  } = $props();
</script>

<button
  type="button"
  class="text-[11px] text-accent cursor-pointer bg-transparent border-none p-0 hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
  {...rest}
>
  {@render children()}
</button>
