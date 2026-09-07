<script lang="ts">
  import BaseDialog from './BaseDialog.svelte';
  import Btn from './Btn.svelte';
  import type { UpsertCustomAgentRequest, ValidateCustomAgentResponse } from './types';
  import { errorMessage } from './utils';

  /**
   * PORT of `frontend/src/lib/AgentEditorDialog.svelte` @ d8c9d5f (163 lines).
   *
   * The one thing §45.2-L absorbs from the upstream's agent layer: a custom
   * agent declared as a start command and an optional resume command. Issue
   * Flow's own registry, capabilities, routing, health and failover stay
   * exactly as they are — this adds a provider, it does not replace the layer.
   *
   * The placeholders are substituted by the runtime as **argv**, never
   * interpolated into a shell string (ADR-04). The note under the list says so
   * in the UI, because someone reading `${PROMPT}` will otherwise assume shell
   * semantics and write quoting that then gets escaped literally.
   */

  let {
    title,
    initialValue,
    onsave,
    onvalidate,
    onclose,
  }: {
    title: string;
    initialValue: {
      label: string;
      startCommand: string;
      resumeCommand: string;
    };
    onsave: (value: UpsertCustomAgentRequest) => Promise<void>;
    onvalidate?: (value: UpsertCustomAgentRequest) => Promise<ValidateCustomAgentResponse>;
    onclose: () => void;
  } = $props();

  let label = $state('');
  let startCommand = $state('');
  let resumeCommand = $state('');
  let initialized = false;
  let saving = $state(false);
  let validating = $state(false);
  let error = $state<string | null>(null);
  let validation = $state<ValidateCustomAgentResponse | null>(null);
  let canSave = $derived(label.trim().length > 0 && startCommand.trim().length > 0);

  const PLACEHOLDERS = [
    '${PROMPT}',
    '${SYSTEM_PROMPT}',
    '${WORKTREE_PATH}',
    '${REPO_PATH}',
    '${BRANCH}',
    '${PROFILE}',
    '${PERMISSION}',
  ];

  $effect(() => {
    if (initialized) return;
    initialized = true;
    label = initialValue.label;
    startCommand = initialValue.startCommand;
    resumeCommand = initialValue.resumeCommand;
  });

  function buildRequest(): UpsertCustomAgentRequest {
    return {
      label: label.trim(),
      startCommand: startCommand.trim(),
      ...(resumeCommand.trim() ? { resumeCommand: resumeCommand.trim() } : {}),
    };
  }

  async function handleValidate(): Promise<void> {
    if (!canSave || saving || validating || !onvalidate) return;
    validating = true;
    error = null;

    try {
      validation = await onvalidate(buildRequest());
    } catch (err) {
      error = errorMessage(err);
      validation = null;
    } finally {
      validating = false;
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!canSave || saving) return;
    saving = true;
    error = null;

    try {
      await onsave(buildRequest());
    } catch (err) {
      error = errorMessage(err);
    } finally {
      saving = false;
    }
  }
</script>

<BaseDialog {onclose} wide>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void handleSubmit();
    }}
  >
    <h2 class="text-base mb-4">{title}</h2>

    <div class="mb-4">
      <label class="block text-xs text-muted mb-1.5" for="agent-label">Nome do agente</label>
      <input
        id="agent-label"
        type="text"
        class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent"
        placeholder="ex.: Gemini CLI"
        bind:value={label}
      />
    </div>

    <div class="mb-4">
      <label class="block text-xs text-muted mb-1.5" for="agent-start-command">
        Comando de início
      </label>
      <textarea
        id="agent-start-command"
        rows="4"
        class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent resize-y font-mono"
        placeholder={'ex.: pi --append-system-prompt "${SYSTEM_PROMPT}" "${PROMPT}"'}
        bind:value={startCommand}
      ></textarea>
    </div>

    <div class="mb-4">
      <label class="block text-xs text-muted mb-1.5" for="agent-resume-command">
        Comando de retomada <span class="opacity-60">(opcional)</span>
      </label>
      <input
        id="agent-resume-command"
        type="text"
        class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent font-mono"
        placeholder={'ex.: pi -c --append-system-prompt "${SYSTEM_PROMPT}"'}
        bind:value={resumeCommand}
      />
    </div>

    <div class="mb-5 rounded-lg border border-edge bg-surface p-3">
      <p class="text-[13px] text-primary">Variáveis disponíveis</p>
      <div class="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted font-mono">
        {#each PLACEHOLDERS as placeholder (placeholder)}
          <span class="rounded-full border border-edge px-1.5 py-0.5">{placeholder}</span>
        {/each}
      </div>
      <p class="mt-2 text-[11px] text-muted">
        Os placeholders viram referências a variáveis de ambiente. Os valores são expandidos com
        segurança como um único argumento e não entram no comando salvo.
      </p>
    </div>

    {#if validation}
      <div class="mb-4 rounded-lg border border-edge bg-surface p-3 text-[12px]">
        <p class="text-primary">
          Identificador do agente: <span class="font-mono">{validation.normalizedId}</span>
        </p>
        {#if validation.warnings.length > 0}
          <ul class="mt-2 space-y-1 text-muted">
            {#each validation.warnings as warning (warning)}
              <li>{warning}</li>
            {/each}
          </ul>
        {:else}
          <p class="mt-2 text-success">A configuração parece correta.</p>
        {/if}
      </div>
    {/if}

    {#if error}
      <p class="mb-4 text-[12px] text-danger" role="alert">{error}</p>
    {/if}

    <div class="flex justify-end gap-2">
      <Btn type="button" onclick={onclose}>Cancelar</Btn>
      {#if onvalidate}
        <Btn
          type="button"
          onclick={() => {
            void handleValidate();
          }}
          disabled={!canSave || validating || saving}
        >
          {validating ? 'Testando…' : 'Testar'}
        </Btn>
      {/if}
      <Btn type="submit" variant="cta" disabled={!canSave || saving}>
        {saving ? 'Salvando…' : 'Salvar'}
      </Btn>
    </div>
  </form>
</BaseDialog>
