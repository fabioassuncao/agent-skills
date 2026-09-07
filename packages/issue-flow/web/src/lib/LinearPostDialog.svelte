<script lang="ts">
  import BaseDialog from './BaseDialog.svelte';
  import Btn from './Btn.svelte';
  import type { PostWorktreeToLinearRequest } from './types';

  let {
    branch,
    onsubmit,
    onclose,
  }: {
    branch: string;
    onsubmit: (target: PostWorktreeToLinearRequest['target']) => Promise<void> | void;
    onclose: () => void;
  } = $props();
  let teamKey = $state('');
  let title = $state('');
  let loading = $state(false);
  let error = $state('');
  let normalizedTeam = $derived(teamKey.trim().toUpperCase());
  let valid = $derived(/^[A-Z][A-Z0-9]*$/.test(normalizedTeam));

  async function submit(): Promise<void> {
    if (!valid || loading) return;
    loading = true;
    error = '';
    try {
      await onsubmit({
        kind: 'team',
        teamKey: normalizedTeam,
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      onclose();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }
</script>

<BaseDialog {onclose}>
  <form onsubmit={(event) => { event.preventDefault(); void submit(); }}>
    <h2 class="text-base mb-2">Enviar conversa ao Linear</h2>
    <p class="text-[12px] text-muted mb-4">
      Cria um ticket para <span class="font-mono">{branch}</span> e inclui a conversa da sessão.
    </p>
    <div class="mb-3">
      <label class="block text-xs text-muted mb-1.5" for="linear-team">Chave do time</label>
      <input id="linear-team" class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] font-mono uppercase" placeholder="ENG" bind:value={teamKey} autocomplete="off" />
      {#if normalizedTeam && !valid}<p class="mt-1 text-[11px] text-danger">Use uma chave como ENG.</p>{/if}
    </div>
    <div class="mb-3">
      <label class="block text-xs text-muted mb-1.5" for="linear-title">Título <span class="opacity-60">(opcional)</span></label>
      <input id="linear-title" class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px]" placeholder={`Sessão issue-flow: ${branch}`} bind:value={title} />
    </div>
    {#if error}<p class="text-[12px] text-danger mb-3 whitespace-pre-wrap" role="alert">{error}</p>{/if}
    <div class="flex justify-end gap-2 mt-5">
      <Btn type="button" onclick={onclose} disabled={loading}>Cancelar</Btn>
      <Btn type="submit" variant="cta" disabled={loading || !valid}>{loading ? 'Enviando…' : 'Enviar'}</Btn>
    </div>
  </form>
</BaseDialog>
