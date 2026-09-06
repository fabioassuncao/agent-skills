<script lang="ts">
  import Btn from './Btn.svelte';
  import {
    CAPABILITY,
    canCall,
    fetchEffectiveConfig,
    hasCapability,
    saveAgentPreference,
    saveRoutingPreference,
  } from './api';
  import { record } from './snapshot';
  import type { EffectiveConfigResponse, HarnessCatalogEntry } from './types';
  import { errorMessage } from './utils';

  /**
   * The two write forms, and the only two (U8).
   *
   * PORT of the `config-form` / `config-routing-form` halves of
   * `renderConfiguration`. §50.3 merges them into `SettingsDialog`, which is the
   * one settings surface in the product — the "Contexto" block keeps showing the
   * effective configuration of the execution (that is reference about this run)
   * and links here for the two things that are actually writable.
   *
   * The rules the current panel already enforces, carried over exactly:
   *
   * - **Execution state stays read-only.** These two routes save a *global
   *   preference for future executions* and nothing about the run on screen.
   *   Every response says so (`appliesTo: 'future executions'`).
   * - **Never infer permission from a version.** The forms exist only when
   *   `/api/health.capabilities` announces both writes, which the server does
   *   only on a loopback binding (ADR-10). A monitor reachable from the network
   *   shows the configuration and offers nothing to change.
   */

  const BUILTIN_PROVIDERS = ['claude', 'codex', 'cursor', 'antigravity', 'opencode'];
  const ROUTING_MODES = ['off', 'shadow', 'recommend', 'active'];
  const ROUTING_PROFILES = ['economy', 'balanced', 'quality', 'speed'];

  let { config = null }: { config?: EffectiveConfigResponse | null } = $props();

  const canWriteAgent = hasCapability(CAPABILITY.configAgentWrite) && canCall('writeAgentPreference');
  const canWriteRouting =
    hasCapability(CAPABILITY.configRoutingWrite) && canCall('writeRoutingPreference');

  // Seeded from the prop through an effect rather than at declaration: reading
  // a `$props()` value directly into `$state` captures only its first value,
  // and this dialog can be opened before the shell has fetched anything.
  let loaded = $state<EffectiveConfigResponse | null>(null);
  let loading = $state(true);

  $effect(() => {
    if (config !== null && loaded === null) {
      loaded = config;
      loading = false;
    }
  });

  // Loaded here as well as by the shell: the dialog can be opened from a
  // dashboard that never fetched a snapshot, and a form whose selects are empty
  // is worse than one that says it is loading.
  $effect(() => {
    if (loaded !== null || !loading) return;
    fetchEffectiveConfig(null)
      .then((response) => {
        loaded = response;
      })
      .catch(() => {})
      .finally(() => {
        loading = false;
      });
  });

  let catalog = $derived<HarnessCatalogEntry[]>(loaded?.catalog ?? []);

  let effective = $derived(record(loaded?.effective));

  let providers = $derived.by(() => {
    const usable = catalog
      .filter((entry) => {
        if (!entry.installed) return false;
        if (entry.state === 'unavailable') return false;
        if (entry.authentication === 'failed') return false;
        return entry.authenticated !== false || entry.state === 'conditional' || entry.state === 'ready';
      })
      .map((entry) => entry.provider);
    return usable.length > 0 ? usable : BUILTIN_PROVIDERS;
  });

  let defaultProvider = $state('');
  let defaultModel = $state('');
  let routingMode = $state('');
  let routingProfile = $state('');

  // Seeded once from what the server reported; after that the fields are the
  // user's, and a refresh must not yank a half-typed model name away.
  let seeded = false;
  $effect(() => {
    if (seeded || loaded === null) return;
    seeded = true;
    const provider = record(effective.defaultProvider);
    const model = record(effective.defaultModel);
    defaultProvider =
      typeof provider.value === 'string' && provider.value !== '' ? provider.value : 'claude';
    defaultModel = typeof model.value === 'string' ? model.value : '';
    const routing = record(loaded.routing);
    routingMode = typeof routing.mode === 'string' ? routing.mode : 'off';
    routingProfile = typeof routing.profile === 'string' ? routing.profile : 'balanced';
  });

  let agentFeedback = $state('');
  let agentSaving = $state(false);
  let routingFeedback = $state('');
  let routingSaving = $state(false);

  async function submitAgent(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    agentSaving = true;
    agentFeedback = 'salvando…';
    try {
      await saveAgentPreference({ provider: defaultProvider, model: defaultModel });
      agentFeedback = 'salvo para execuções futuras';
    } catch (err) {
      agentFeedback = errorMessage(err);
    } finally {
      agentSaving = false;
    }
  }

  async function saveRouting(body: Record<string, unknown>): Promise<void> {
    routingSaving = true;
    routingFeedback = 'salvando…';
    try {
      await saveRoutingPreference(body);
      routingFeedback = 'salvo para execuções futuras';
    } catch (err) {
      routingFeedback = errorMessage(err);
    } finally {
      routingSaving = false;
    }
  }
</script>

{#if canWriteAgent || canWriteRouting}
  <div class="mb-5">
    <span class="block text-xs text-muted mb-2">Execuções futuras</span>
    <div class="rounded-lg border border-edge bg-surface p-3 grid gap-3">
      <p class="text-[11px] text-muted m-0">
        O estado das execuções é somente leitura. Estas duas preferências valem para as
        <strong>próximas</strong> execuções e são gravadas na configuração global.
      </p>

      {#if canWriteAgent}
        <form class="grid gap-2" onsubmit={submitAgent}>
          <span class="text-[13px] text-primary">Harness padrão</span>
          <div class="flex flex-wrap items-center gap-2">
            <select
              aria-label="Harness padrão para execuções futuras"
              class="px-2 py-1 rounded-md border border-edge bg-surface text-primary text-[13px]"
              bind:value={defaultProvider}
            >
              {#each providers as provider (provider)}
                <option value={provider}>{provider}</option>
              {/each}
            </select>
            <input
              type="text"
              aria-label="Modelo padrão para execuções futuras"
              class="px-2 py-1 rounded-md border border-edge bg-surface text-primary text-[13px]"
              placeholder="modelo (vazio = default)"
              bind:value={defaultModel}
            />
            <Btn type="submit" variant="cta" disabled={agentSaving}>Salvar preferência global</Btn>
            <span class="text-[11px] text-muted" aria-live="polite">{agentFeedback}</span>
          </div>
        </form>
      {/if}

      {#if canWriteRouting}
        <form
          class="grid gap-2"
          onsubmit={(event) => {
            event.preventDefault();
            void saveRouting({ mode: routingMode, profile: routingProfile });
          }}
        >
          <span class="text-[13px] text-primary">Routing</span>
          <div class="flex flex-wrap items-center gap-2">
            <select
              aria-label="Modo de routing"
              class="px-2 py-1 rounded-md border border-edge bg-surface text-primary text-[13px]"
              bind:value={routingMode}
            >
              {#each ROUTING_MODES as mode (mode)}
                <option value={mode}>{mode}</option>
              {/each}
            </select>
            <select
              aria-label="Perfil de routing"
              class="px-2 py-1 rounded-md border border-edge bg-surface text-primary text-[13px]"
              bind:value={routingProfile}
            >
              {#each ROUTING_PROFILES as profile (profile)}
                <option value={profile}>{profile}</option>
              {/each}
            </select>
            <Btn type="submit" variant="cta" disabled={routingSaving}>Salvar routing</Btn>
            <Btn
              type="button"
              disabled={routingSaving}
              onclick={() => void saveRouting({ policy: 'recommended' })}
              >Aplicar política recomendada</Btn
            >
            <span class="text-[11px] text-muted" aria-live="polite">{routingFeedback}</span>
          </div>
        </form>
      {/if}
    </div>
  </div>
{/if}
