<script lang="ts">
  import AgentEditorDialog from './AgentEditorDialog.svelte';
  import BaseDialog from './BaseDialog.svelte';
  import Btn from './Btn.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import PreferenceForms from './PreferenceForms.svelte';
  import Toggle from './Toggle.svelte';
  import {
    CAPABILITY,
    api,
    canCall,
    createAgent,
    deleteAgent,
    fetchAgents,
    hasCapability,
    updateAgent,
    validateAgent,
  } from './api';
  import { THEMES, type ThemeKey } from './themes';
  import type { AgentDetails, AgentSummary, UpsertCustomAgentRequest } from './types';
  import { SSH_STORAGE_KEY, applyTheme, errorMessage, readStored, writeStored } from './utils';

  /**
   * ADAPT of `frontend/src/lib/SettingsDialog.svelte` @ d8c9d5f (394 lines).
   *
   * Structure and behaviour are the upstream's; three things changed:
   *
   * - **Theme is the panel's three options** (Sistema/Claro/Escuro) over one
   *   measured palette, not the upstream's five hard-coded palettes — see
   *   `themes.ts` for why.
   * - **The Linear section is gone** (ADR-14).
   * - **Every write is capability-gated.** The rule the current panel already
   *   enforces: a control that mutates configuration appears only when
   *   `/api/health.capabilities` announces it, never inferred from a version,
   *   and the writes themselves are refused off loopback (ADR-10).
   *
   * §50.3 merges the panel's "Configuração efetiva" into this dialog: the two
   * preference forms live here (`PreferenceForms`), so the product has one
   * settings surface rather than two. What stays in the "Contexto" block is the
   * *reading* of the effective configuration, which describes the execution on
   * screen rather than a preference anybody can change.
   */

  interface AgentEditorState {
    mode: 'create' | 'edit';
    agentId?: string;
    title: string;
    initialValue: {
      label: string;
      startCommand: string;
      resumeCommand: string;
    };
  }

  let {
    currentTheme,
    useWebChatUi,
    autoRemoveOnMerge,
    onthemechange,
    onwebchatuichange,
    onautoremovechange,
    onagentschange,
    onsave,
    onclose,
  }: {
    currentTheme: ThemeKey;
    useWebChatUi: boolean;
    autoRemoveOnMerge: boolean;
    onthemechange: (key: ThemeKey) => void;
    onwebchatuichange: (enabled: boolean) => void;
    onautoremovechange: (enabled: boolean) => void;
    onagentschange: (agents: AgentSummary[]) => void;
    onsave: (sshHost: string) => void;
    onclose: () => void;
  } = $props();

  let sshHost = $state(readStored(SSH_STORAGE_KEY) ?? '');

  let pendingAutoRemove = $state<boolean | null>(null);
  let autoRemove = $derived(pendingAutoRemove ?? autoRemoveOnMerge);
  let autoRemoveSaving = $state(false);

  let agents = $state<AgentDetails[]>([]);
  let customAgents = $derived(agents.filter((agent) => agent.kind === 'custom'));
  let agentsLoading = $state(true);
  let agentsError = $state<string | null>(null);
  let agentsUnavailable = $state(false);
  let agentsLoaded = false;
  let editor = $state<AgentEditorState | null>(null);
  let deleteCandidate = $state<AgentDetails | null>(null);
  let deletingAgentId = $state<string | null>(null);

  const canManageAgents = canCall('fetchAgents');
  const canToggleAutoRemove = canCall('setAutoRemoveOnMerge');
  const worktreesAvailable = hasCapability(CAPABILITY.worktrees);

  async function loadAgentList(): Promise<void> {
    if (!canManageAgents) {
      agentsUnavailable = true;
      agentsLoading = false;
      return;
    }
    agentsLoading = true;
    agentsError = null;

    try {
      agents = await fetchAgents();
    } catch (err) {
      agentsError = errorMessage(err);
    } finally {
      agentsLoading = false;
    }
  }

  function syncAgentSummaries(): void {
    if (!canCall('fetchConfig')) return;
    api
      .fetchConfig()
      .then((config) => {
        onagentschange(config.agents);
      })
      .catch(() => {});
  }

  $effect(() => {
    if (agentsLoaded) return;
    agentsLoaded = true;
    void loadAgentList();
  });

  function handleAutoRemoveToggle(enabled: boolean) {
    pendingAutoRemove = enabled;
    autoRemoveSaving = true;
    api
      .setAutoRemoveOnMerge({ body: { enabled } })
      .then((result) => {
        onautoremovechange(result.enabled);
      })
      .catch(() => {})
      .finally(() => {
        pendingAutoRemove = null;
        autoRemoveSaving = false;
      });
  }

  function handleSave() {
    const trimmed = sshHost.trim();
    writeStored(SSH_STORAGE_KEY, trimmed ? trimmed : null);
    onsave(trimmed);
  }

  function selectTheme(key: ThemeKey) {
    applyTheme(key);
    onthemechange(key);
  }

  function openCreateAgentEditor(): void {
    editor = {
      mode: 'create',
      title: 'Adicionar agente personalizado',
      initialValue: {
        label: '',
        startCommand: '',
        resumeCommand: '',
      },
    };
  }

  function openEditAgentEditor(agent: AgentDetails): void {
    editor = {
      mode: 'edit',
      agentId: agent.id,
      title: `Editar ${agent.label}`,
      initialValue: {
        label: agent.label,
        startCommand: agent.startCommand ?? '',
        resumeCommand: agent.resumeCommand ?? '',
      },
    };
  }

  function openDuplicateAgentEditor(agent: AgentDetails): void {
    editor = {
      mode: 'create',
      title: `Duplicar ${agent.label}`,
      initialValue: {
        label: `${agent.label} (cópia)`,
        startCommand: agent.startCommand ?? '',
        resumeCommand: agent.resumeCommand ?? '',
      },
    };
  }

  async function handleSaveAgent(input: UpsertCustomAgentRequest): Promise<void> {
    if (!editor) return;

    if (editor.mode === 'edit' && editor.agentId) {
      await updateAgent(editor.agentId, input);
    } else {
      await createAgent(input);
    }

    await loadAgentList();
    syncAgentSummaries();
    editor = null;
  }

  function handleValidateAgent(input: UpsertCustomAgentRequest) {
    return validateAgent(input);
  }

  async function handleDeleteAgent(): Promise<void> {
    if (!deleteCandidate) return;
    deletingAgentId = deleteCandidate.id;

    try {
      await deleteAgent(deleteCandidate.id);
      await loadAgentList();
      syncAgentSummaries();
      deleteCandidate = null;
    } finally {
      deletingAgentId = null;
    }
  }
</script>

<BaseDialog {onclose} wide>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      handleSave();
    }}
  >
    <h2 class="text-base mb-4">Configurações</h2>

    <div class="mb-5">
      <span class="block text-xs text-muted mb-2">Tema</span>
      <div class="grid grid-cols-3 gap-2" role="group" aria-label="Tema">
        {#each THEMES as theme (theme.key)}
          <button
            type="button"
            aria-pressed={currentTheme === theme.key}
            class="flex items-center justify-center gap-2 px-3 py-2 rounded-md border cursor-pointer text-[13px] transition-colors {currentTheme ===
            theme.key
              ? 'border-accent bg-active text-primary'
              : 'border-edge bg-surface text-muted hover:bg-hover hover:text-primary'}"
            onclick={() => selectTheme(theme.key)}
          >
            {theme.label}
          </button>
        {/each}
      </div>
      <p class="mt-1.5 text-[11px] text-muted">
        "Sistema" acompanha a preferência do sistema operacional em tempo real.
      </p>
    </div>

    <div class="mb-5">
      <span class="block text-xs text-muted mb-2">Interface</span>
      <div
        class="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-edge bg-surface"
      >
        <div>
          <span class="text-[13px] text-primary">Usar o chat na página</span>
          <p class="text-[11px] text-muted mt-0.5">
            Mostra a conversa estruturada do agente no lugar do terminal, para os agentes que a
            suportam.
          </p>
        </div>

        <Toggle
          checked={useWebChatUi}
          ontoggle={onwebchatuichange}
          aria-label="Usar o chat na página"
        />
      </div>
    </div>

    <PreferenceForms />

    <div class="mb-5">
      <span class="block text-xs text-muted mb-2">Agentes</span>
      <div class="rounded-lg border border-edge bg-surface p-3">
        <div class="mb-3 flex items-center justify-between gap-2">
          <div>
            <p class="text-[13px] text-primary">Agentes personalizados</p>
            <p class="mt-0.5 text-[11px] text-muted">
              Agentes de terminal que o issue-flow pode iniciar a partir do painel.
            </p>
          </div>
          {#if canManageAgents}
            <Btn type="button" variant="cta" onclick={openCreateAgentEditor}>Adicionar</Btn>
          {/if}
        </div>

        {#if agentsUnavailable}
          <p class="text-[12px] text-muted">
            Este monitor não gerencia agentes personalizados.
          </p>
        {:else if agentsLoading}
          <p class="text-[12px] text-muted">Carregando agentes…</p>
        {:else if agentsError}
          <p class="text-[12px] text-danger" role="alert">{agentsError}</p>
        {:else if customAgents.length === 0}
          <p class="text-[12px] text-muted">Nenhum agente personalizado configurado</p>
        {:else}
          <div class="space-y-2">
            {#each customAgents as agent (agent.id)}
              <div class="rounded-lg border border-edge bg-surface px-3 py-2.5">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="text-[13px] text-primary">{agent.label}</span>
                    </div>
                    <p class="mt-1 text-[11px] text-muted font-mono break-all">
                      {agent.startCommand}
                    </p>
                    {#if agent.resumeCommand}
                      <p class="mt-1 text-[11px] text-muted font-mono break-all">
                        Retomada: {agent.resumeCommand}
                      </p>
                    {/if}
                  </div>

                  <div class="flex shrink-0 gap-2 text-[11px]">
                    <button
                      type="button"
                      class="text-accent hover:underline"
                      onclick={() => openEditAgentEditor(agent)}
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      class="text-accent hover:underline"
                      onclick={() => openDuplicateAgentEditor(agent)}
                    >
                      Duplicar
                    </button>
                    <button
                      type="button"
                      class="text-danger hover:underline disabled:opacity-60"
                      disabled={deletingAgentId === agent.id}
                      onclick={() => (deleteCandidate = agent)}
                    >
                      Excluir
                    </button>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    {#if canToggleAutoRemove}
      <div class="mb-5">
        <span class="block text-xs text-muted mb-2">GitHub</span>
        <div
          class="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-edge bg-surface"
        >
          <div>
            <span class="text-[13px] text-primary">Remover ao integrar</span>
            <p class="text-[11px] text-muted mt-0.5">
              Remove o worktree automaticamente quando o pull request dele é integrado no GitHub.
            </p>
          </div>

          <Toggle
            checked={autoRemove}
            disabled={autoRemoveSaving}
            ontoggle={handleAutoRemoveToggle}
            aria-label="Remover worktrees ao integrar o pull request"
          />
        </div>
      </div>
    {/if}

    {#if !worktreesAvailable}
      <p class="mb-5 rounded-md border border-edge bg-surface px-3 py-2 text-[11px] text-muted">
        Este monitor está acompanhando execuções. As opções de worktree, sessão e agente aparecem
        quando o servidor as anuncia.
      </p>
    {/if}

    <div class="mb-4">
      <label class="block text-xs text-muted mb-1.5" for="ssh-host">
        Host SSH <span class="opacity-60">(para "Abrir no Cursor")</span>
      </label>
      <input
        id="ssh-host"
        type="text"
        class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent"
        placeholder="ex.: devbox ou 10.0.0.5"
        bind:value={sshHost}
      />
      <p class="text-[11px] text-muted mt-1.5">
        Precisa corresponder a uma entrada do seu <code class="text-accent">~/.ssh/config</code>.
        Deixe vazio no modo local.
      </p>
    </div>
    <div class="flex justify-end gap-2">
      <Btn type="button" onclick={onclose}>Cancelar</Btn>
      <Btn type="submit" variant="cta">Salvar</Btn>
    </div>
  </form>
</BaseDialog>

{#if editor}
  <AgentEditorDialog
    title={editor.title}
    initialValue={editor.initialValue}
    onsave={handleSaveAgent}
    onvalidate={handleValidateAgent}
    onclose={() => (editor = null)}
  />
{/if}

{#if deleteCandidate}
  <ConfirmDialog
    message={`Excluir o agente "${deleteCandidate.label}"?`}
    confirmLabel="Excluir"
    onconfirm={() => {
      void handleDeleteAgent();
    }}
    oncancel={() => {
      deleteCandidate = null;
    }}
  />
{/if}
