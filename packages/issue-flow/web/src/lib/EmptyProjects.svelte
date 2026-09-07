<script lang="ts">
  import { onMount } from 'svelte';
  import { setUpProject } from './api';
  import type { ProjectInitPhase } from './types';
  import { applyTheme, errorMessage, loadSavedTheme, projectInitPhaseLabel } from './utils';

  /**
   * ADAPT of `frontend/src/lib/EmptyProjects.svelte` @ d8c9d5f (77 lines).
   *
   * The copy points at `issue-flow project add` (§48.1) rather than at a
   * `.webmux.yaml` scaffold, and the form stays: an install with an empty
   * registry has to be able to add its first project from the browser, not only
   * from a terminal it may not have open.
   */

  let path = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let phase = $state<ProjectInitPhase | null>(null);

  onMount(() => {
    applyTheme(loadSavedTheme());
  });

  async function add(): Promise<void> {
    const target = path.trim();
    if (!target || busy) return;
    busy = true;
    error = null;
    phase = null;
    try {
      const { prefix } = await setUpProject(target, (next) => {
        phase = next;
      });
      window.location.assign(`/${prefix}/`);
    } catch (err) {
      error = errorMessage(err);
      busy = false;
      phase = null;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void add();
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-bg text-primary p-6">
  <div class="w-full max-w-md">
    <h1 class="text-lg font-semibold mb-2">Nenhum projeto ainda</h1>
    <p class="text-sm text-muted mb-4">
      Um servidor atende todos os projetos. Informe o caminho de um repositório git abaixo e o
      issue-flow o prepara: cria as convenções que faltam e analisa o repositório para
      preenchê-las. Pela linha de comando, o equivalente é
      <code class="text-primary">issue-flow project add</code>.
    </p>
    <div class="flex gap-2">
      <input
        type="text"
        bind:value={path}
        onkeydown={onKeydown}
        aria-label="Caminho do repositório git"
        placeholder="Caminho de um repositório git"
        disabled={busy}
        class="flex-1 min-w-0 px-3 py-2 text-sm rounded border border-edge bg-surface text-primary placeholder:text-muted disabled:opacity-50"
      />
      <button
        type="button"
        class="shrink-0 px-3 py-2 text-sm rounded border border-edge text-primary hover:bg-hover disabled:opacity-50"
        disabled={busy || path.trim() === ''}
        onclick={add}
      >
        Adicionar
      </button>
    </div>
    {#if busy && phase}
      <div class="mt-3 flex items-center gap-2 text-sm text-muted">
        <span class="spinner"></span>
        {projectInitPhaseLabel(phase)}…
      </div>
    {/if}
    {#if error}
      <div class="mt-2 text-sm text-danger break-words" role="alert">{error}</div>
    {/if}
  </div>
</div>
