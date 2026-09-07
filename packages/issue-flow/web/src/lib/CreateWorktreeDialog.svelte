<script lang="ts">
  import BaseDialog from './BaseDialog.svelte';
  import BranchSelector from './BranchSelector.svelte';
  import Btn from './Btn.svelte';
  import StartupEnvFields from './StartupEnvFields.svelte';
  import Toggle from './Toggle.svelte';
  import type {
    AgentId,
    AgentSummary,
    AvailableBranch,
    BuiltInAgentId,
    CreateWorktreeRequest,
    ProfileConfig,
    WorktreeCreateMode,
  } from './types';
  import { readStored, writeStored } from './utils';

  /**
   * ADAPT of `frontend/src/lib/CreateWorktreeDialog.svelte` @ d8c9d5f (529 lines).
   *
   * Everything about creating a worktree is the upstream's — new or existing
   * branch, base branch, profile, one or several agents, prompt, startup env,
   * and the remembered defaults. Linear pickup lives in `LinearPanel`/the
   * headless auto-create loop instead of adding a second ticket selector here;
   * the Issue Flow addition of §48.3 is an **optional** issue to link.
   *
   * Optional is the whole point (ADR-16 / ADR-17): a free session opens with no
   * issue, no plan and no workflow, in one click. Nothing here may become
   * required, and `canSubmit` must never depend on `issueRef`.
   */

  let {
    profiles = [],
    agents = [],
    defaultProfileName = '',
    defaultAgentId = 'claude',
    autoNameEnabled = false,
    initialBranch = '',
    initialPrompt = '',
    initialIssueRef = '',
    availableBranches = [],
    availableBranchesLoading = false,
    availableBranchesError = null,
    baseBranches = [],
    baseBranchesLoading = false,
    baseBranchesError = null,
    lockedBaseBranch = null,
    includeRemoteBranches = $bindable(false),
    startupEnvs = {},
    oncreate,
    oncancel,
  }: {
    profiles: ProfileConfig[];
    agents?: AgentSummary[];
    defaultProfileName?: string;
    defaultAgentId?: BuiltInAgentId;
    autoNameEnabled?: boolean;
    initialBranch?: string;
    initialPrompt?: string;
    initialIssueRef?: string;
    availableBranches?: AvailableBranch[];
    availableBranchesLoading?: boolean;
    availableBranchesError?: string | null;
    baseBranches?: AvailableBranch[];
    baseBranchesLoading?: boolean;
    baseBranchesError?: string | null;
    lockedBaseBranch?: string | null;
    includeRemoteBranches: boolean;
    startupEnvs?: Record<string, string | boolean>;
    oncreate: (request: CreateWorktreeRequest) => void;
    oncancel: () => void;
  } = $props();

  const STORAGE_KEY = 'issue-flow:default-profile';
  const AGENT_STORAGE_KEY = 'issue-flow:default-agents';
  const MULTI_AGENT_STORAGE_KEY = 'issue-flow:default-multi-agents';
  const ENV_STORAGE_KEY = 'issue-flow:default-envs';
  const savedProfile = readStored(STORAGE_KEY);
  const savedEnvs = readStored(ENV_STORAGE_KEY);

  function sameAgentIds(left: AgentId[], right: AgentId[]): boolean {
    return left.length === right.length && left.every((id, index) => id === right[index]);
  }

  function loadSavedMultiAgentMode(): boolean {
    return readStored(MULTI_AGENT_STORAGE_KEY) === 'true';
  }

  function loadSavedAgentIds(): AgentId[] {
    const saved = readStored(AGENT_STORAGE_KEY);
    if (!saved) return [];

    try {
      const parsed = JSON.parse(saved) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (entry): entry is AgentId => typeof entry === 'string' && entry.trim().length > 0,
        );
      }
    } catch {
      // An older single-value entry: keep it rather than discarding the choice.
      if (saved.trim().length > 0) return [saved.trim()];
    }

    return saved.trim().length > 0 ? [saved.trim()] : [];
  }

  function loadSavedEnvs(): Record<string, string | boolean> {
    if (!savedEnvs) return { ...startupEnvs };
    try {
      const parsed = JSON.parse(savedEnvs) as Record<string, string | boolean>;
      // Only keys the project still declares: a stale key would be sent as an
      // override for a variable nothing reads.
      const filtered = Object.fromEntries(
        Object.entries(parsed).filter(([key]) => key in startupEnvs),
      );
      return { ...startupEnvs, ...filtered };
    } catch {
      return { ...startupEnvs };
    }
  }

  function focus(node: HTMLElement) {
    node.focus();
  }

  const savedAgentIds = loadSavedAgentIds();
  const savedMultiAgentMode = loadSavedMultiAgentMode();
  let availableAgentOptions = $derived(agents);
  let fallbackProfile = $derived(defaultProfileName || profiles[0]?.name || 'default');
  let fallbackAgentId = $derived(
    availableAgentOptions.some((agent) => agent.id === defaultAgentId)
      ? defaultAgentId
      : (availableAgentOptions[0]?.id ?? ''),
  );
  let mode = $state<WorktreeCreateMode>('new');
  // svelte-ignore state_referenced_locally
  let newBranchName = $state(initialBranch);
  // svelte-ignore state_referenced_locally
  let prompt = $state(initialPrompt);
  // svelte-ignore state_referenced_locally
  let issueRef = $state(initialIssueRef);
  let selectedExistingBranch = $state('');
  // svelte-ignore state_referenced_locally
  let selectedBaseBranch = $state(lockedBaseBranch ?? '');
  let multiAgentMode = $state(savedMultiAgentMode);
  let selectedAgentIds = $state<AgentId[]>(savedAgentIds);
  let profile = $state('');
  const hasSavedDefaults =
    savedProfile != null ||
    readStored(AGENT_STORAGE_KEY) != null ||
    readStored(MULTI_AGENT_STORAGE_KEY) != null ||
    savedEnvs != null;
  let saveDefault = $state(hasSavedDefaults);
  // svelte-ignore state_referenced_locally
  let envValues = $state<Record<string, string | boolean>>(loadSavedEnvs());

  $effect(() => {
    if (profile === '' && savedProfile) profile = savedProfile;
  });

  let selectedAgents = $derived(
    availableAgentOptions.filter((agent) => selectedAgentIds.includes(agent.id)),
  );
  let creatingMultipleAgents = $derived(multiAgentMode && selectedAgentIds.length > 1);
  let branchPreview = $derived(
    mode === 'new' && creatingMultipleAgents && newBranchName.trim().length > 0
      ? selectedAgentIds.map((agentId) => `${agentId}-${newBranchName.trim()}`)
      : [],
  );
  let canSubmit = $derived(
    selectedAgentIds.length > 0 && (mode === 'new' || selectedExistingBranch.length > 0),
  );

  $effect(() => {
    if (!profiles.some((p) => p.name === profile)) {
      profile = fallbackProfile;
    }
  });

  $effect(() => {
    const validAgentIds = new Set(availableAgentOptions.map((agent) => agent.id));
    const filteredIds = selectedAgentIds.filter((agentId) => validAgentIds.has(agentId));
    const nextSelectedAgentIds =
      filteredIds.length > 0
        ? filteredIds
        : validAgentIds.has(fallbackAgentId)
          ? [fallbackAgentId]
          : availableAgentOptions[0]
            ? [availableAgentOptions[0].id]
            : [];
    const normalizedAgentIds = multiAgentMode
      ? nextSelectedAgentIds
      : nextSelectedAgentIds.slice(0, 1);

    if (!sameAgentIds(selectedAgentIds, normalizedAgentIds)) {
      selectedAgentIds = normalizedAgentIds;
    }
  });

  $effect(() => {
    // One worktree per agent means one branch per agent, so an existing branch
    // cannot be reused for more than one of them.
    if (creatingMultipleAgents && mode === 'existing') {
      mode = 'new';
      selectedExistingBranch = '';
    }
  });

  function setMultiAgentMode(enabled: boolean): void {
    multiAgentMode = enabled;
    if (!enabled) {
      selectedAgentIds = selectedAgentIds.slice(0, 1);
    }
  }

  function toggleAgent(agentId: AgentId): void {
    if (!multiAgentMode) {
      selectedAgentIds = [agentId];
      return;
    }

    if (selectedAgentIds.includes(agentId)) {
      if (selectedAgentIds.length === 1) return;
      selectedAgentIds = selectedAgentIds.filter((id) => id !== agentId);
      return;
    }

    selectedAgentIds = [...selectedAgentIds, agentId];
  }

  function selectExistingBranch(name: string): void {
    selectedExistingBranch = name;
  }

  function openExistingBranchSelector(): void {
    mode = 'existing';
    if (!selectedExistingBranch && initialBranch.trim().length > 0) {
      selectedExistingBranch = initialBranch.trim();
    }
  }

  function switchToNewBranchMode(): void {
    mode = 'new';
  }
</script>

<BaseDialog onclose={oncancel} className="md:max-w-[440px]">
  <form
    onsubmit={(e) => {
      e.preventDefault();
      if (!canSubmit) return;
      if (saveDefault) {
        writeStored(STORAGE_KEY, profile);
        writeStored(AGENT_STORAGE_KEY, JSON.stringify(selectedAgentIds));
        writeStored(MULTI_AGENT_STORAGE_KEY, String(multiAgentMode));
        writeStored(ENV_STORAGE_KEY, JSON.stringify(envValues));
      } else {
        writeStored(STORAGE_KEY, null);
        writeStored(AGENT_STORAGE_KEY, null);
        writeStored(MULTI_AGENT_STORAGE_KEY, null);
        writeStored(ENV_STORAGE_KEY, null);
      }
      const filteredEnvs: Record<string, string> = {};
      for (const [k, v] of Object.entries(envValues)) {
        if (typeof v === 'boolean') {
          if (v) filteredEnvs[k] = 'true';
        } else if (v) {
          filteredEnvs[k] = v;
        }
      }
      const trimmedPrompt = prompt.trim();
      const trimmedIssueRef = issueRef.trim();
      const branchName = mode === 'existing' ? selectedExistingBranch : newBranchName.trim();
      oncreate({
        mode,
        ...(branchName ? { branch: branchName } : {}),
        ...(mode === 'new' && selectedBaseBranch ? { baseBranch: selectedBaseBranch } : {}),
        profile,
        agents: [...selectedAgentIds],
        ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
        ...(trimmedIssueRef ? { issueRef: trimmedIssueRef } : {}),
        ...(Object.keys(filteredEnvs).length > 0 ? { envOverrides: filteredEnvs } : {}),
      });
    }}
  >
    <h2 class="text-base mb-4">
      {lockedBaseBranch !== null ? 'Novo worktree derivado' : 'Novo worktree'}
    </h2>
    <div class="mb-4">
      <label class="block text-xs text-muted mb-1.5" for="wt-prompt"
        >Prompt <span class="opacity-60">(opcional)</span></label
      >
      <textarea
        id="wt-prompt"
        rows="4"
        use:focus
        class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent resize-y"
        placeholder="Descreva a tarefa para o agente…"
        bind:value={prompt}
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      ></textarea>
    </div>
    <div class="mb-4">
      {#if mode === 'new'}
        <label class="block text-xs text-muted mb-1.5" for="wt-name"
          >Nome da branch <span class="opacity-60">(opcional)</span></label
        >
        <input
          id="wt-name"
          type="text"
          class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent"
          placeholder={autoNameEnabled
            ? 'gerado a partir do prompt se vazio'
            : 'gerado automaticamente se vazio'}
          bind:value={newBranchName}
        />
        {#if creatingMultipleAgents}
          <div class="mt-2 text-[11px] text-muted">
            <p>Uma branch com prefixo é criada para cada agente selecionado.</p>
            {#if branchPreview.length > 0}
              <ul class="mt-1 space-y-0.5 font-mono text-[11px] text-primary">
                {#each branchPreview as branch (branch)}
                  <li>{branch}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {:else}
          <button
            type="button"
            class="mt-2 text-[11px] text-accent hover:underline"
            onclick={openExistingBranchSelector}
          >
            Usar uma branch existente
          </button>
        {/if}
      {:else}
        <BranchSelector
          label="Branch existente"
          selected={selectedExistingBranch}
          branches={availableBranches}
          loading={availableBranchesLoading}
          error={availableBranchesError}
          placeholder="Selecione uma branch"
          initialOpen={true}
          inlineToggleLabel="incluir remotas"
          inlineToggleAriaLabel="Incluir branches remotas"
          inlineToggleChecked={includeRemoteBranches}
          oninlinetoggle={() => (includeRemoteBranches = !includeRemoteBranches)}
          onselect={selectExistingBranch}
        />
        <button
          type="button"
          class="mt-2 text-[11px] text-accent hover:underline"
          onclick={switchToNewBranchMode}
        >
          Criar uma branch nova
        </button>
        <p class="mt-2 text-[11px] text-muted">Remover este worktree também apaga a branch.</p>
      {/if}
    </div>
    {#if mode === 'new'}
      <div class="mb-4">
        <BranchSelector
          label="Branch base"
          selected={selectedBaseBranch}
          branches={baseBranches}
          loading={baseBranchesLoading}
          error={baseBranchesError}
          placeholder="Branch principal do projeto (padrão)"
          disabled={lockedBaseBranch !== null}
          onselect={(branch) => (selectedBaseBranch = branch)}
        />
        {#if lockedBaseBranch !== null}
          <p class="mt-2 text-[11px] text-muted">
            Criando um worktree derivado de <span class="font-mono">{lockedBaseBranch}</span>.
          </p>
        {:else if selectedBaseBranch}
          <button
            type="button"
            class="mt-2 text-[11px] text-accent hover:underline"
            onclick={() => (selectedBaseBranch = '')}
          >
            Usar a branch padrão do projeto
          </button>
        {/if}
      </div>
    {/if}
    <div class="mb-4">
      <label class="block text-xs text-muted mb-1.5" for="wt-issue-ref">
        Issue vinculada <span class="opacity-60">(opcional)</span>
      </label>
      <input
        id="wt-issue-ref"
        type="text"
        class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent"
        placeholder="ex.: 42"
        bind:value={issueRef}
      />
      <p class="mt-1 text-[11px] text-muted">
        Vazio abre uma sessão livre: sem issue, sem plano e sem workflow.
      </p>
    </div>
    <StartupEnvFields {startupEnvs} bind:envValues />
    <div class="mb-4">
      <div class="mb-2 flex items-center justify-between gap-2">
        <span class="text-xs text-muted"
          >{multiAgentMode
            ? `Agentes (${selectedAgentIds.length} selecionados)`
            : 'Agente'}</span
        >
        <label class="flex items-center gap-2 text-[11px] text-muted cursor-pointer">
          <span>Seleção múltipla</span>
          <Toggle
            size="sm"
            checked={multiAgentMode}
            ontoggle={setMultiAgentMode}
            aria-label="Permitir selecionar vários agentes"
          />
        </label>
      </div>
      {#if creatingMultipleAgents}
        <p class="mb-2 text-[11px] text-muted">Cria um worktree por agente.</p>
      {/if}
      {#if availableAgentOptions.length === 0}
        <p class="rounded-lg border border-edge bg-surface px-3 py-2 text-[12px] text-muted">
          Nenhum agente disponível.
        </p>
      {:else}
        <div class="grid gap-2 sm:grid-cols-2">
          {#each availableAgentOptions as agentOption (agentOption.id)}
            <label
              class="flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer text-[13px] transition-colors
                {selectedAgentIds.includes(agentOption.id)
                ? 'border-accent bg-accent/10'
                : 'border-edge hover:bg-hover'}"
            >
              <input
                type={multiAgentMode ? 'checkbox' : 'radio'}
                name={multiAgentMode ? undefined : 'agent'}
                checked={selectedAgentIds.includes(agentOption.id)}
                onchange={() => toggleAgent(agentOption.id)}
                class="mt-0.5 accent-accent"
              />
              <span class="min-w-0 flex-1 truncate text-primary">{agentOption.label}</span>
            </label>
          {/each}
        </div>
      {/if}
    </div>
    {#if profiles.length > 1}
      <div class="flex flex-col gap-2 mb-6">
        {#each profiles as p (p.name)}
          <label
            class="flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer text-[13px] transition-colors
              {profile === p.name ? 'border-accent bg-accent/10' : 'border-edge hover:bg-hover'}"
          >
            <input
              type="radio"
              name="profile"
              value={p.name}
              checked={profile === p.name}
              onchange={() => (profile = p.name)}
              class="accent-accent"
            />
            {p.name}
          </label>
        {/each}
      </div>
    {/if}
    <label class="flex items-center gap-2 mb-4 text-[13px] text-muted cursor-pointer">
      <input type="checkbox" bind:checked={saveDefault} class="accent-accent" />
      Salvar como padrão
    </label>
    <div class="flex justify-end gap-2">
      <Btn type="button" onclick={oncancel}>Cancelar</Btn>
      <Btn type="submit" variant="cta" disabled={!canSubmit}>Criar</Btn>
    </div>
  </form>
</BaseDialog>
