<script lang="ts">
  import CursorButton from './CursorButton.svelte';

  /** PORT of `frontend/src/lib/SidebarRepoRow.svelte` @ d8c9d5f (24 lines). */

  let {
    label,
    cursorUrl,
    onpull,
  }: {
    label: string;
    cursorUrl: string;
    onpull: () => void;
  } = $props();
</script>

<div class="shrink-0 border-t border-edge px-3 py-2 flex items-center gap-2">
  <span class="text-[11px] text-muted font-medium truncate">{label}</span>
  <CursorButton url={cursorUrl} />
  <button
    type="button"
    class="shrink-0 text-[9px] px-1.5 py-0.5 rounded border border-edge text-muted font-medium cursor-pointer hover:bg-hover hover:text-primary"
    title="Atualizar a partir do remoto"
    onclick={onpull}
  >Atualizar</button>
</div>
