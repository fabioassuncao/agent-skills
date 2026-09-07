<script lang="ts">
  import type { EffectiveConfigResponse } from './types';
  import type { ExecutionSnapshot } from './snapshot';
  import { record } from './snapshot';
  import { configSourceLabel } from './vocabulary';

  /**
   * "Contexto" — the second of the four blocks (U7).
   *
   * PORT of `renderIssueSummary`, `renderRepository` and `renderConfiguration`.
   * The whole block runs one step down in size (`--font-size-md`): it is
   * reference, not state — what you read when "Estado agora" was not enough.
   *
   * **§50.3 merge.** The *reading* of the effective configuration stays here,
   * because it describes this execution. The *writing* — the two preference
   * forms — moved into `SettingsDialog`, which is the one settings surface in
   * the product; this block links to it instead of growing a second one. The
   * link only exists when `/api/health` announced the capability, which is also
   * the only thing that decides whether the forms exist at all (ADR-10, U8).
   */

  let {
    snapshot,
    config = null,
    monitorVersion = null,
    canEditPreferences = false,
    onopensettings,
    onopenphase,
  }: {
    snapshot: ExecutionSnapshot;
    config?: EffectiveConfigResponse | null;
    monitorVersion?: string | null;
    canEditPreferences?: boolean;
    onopensettings: () => void;
    onopenphase: (phase: string) => void;
  } = $props();

  let issueState = $derived(snapshot.issue.state);

  let runVersion = $derived(snapshot.environment?.cliVersion ?? null);

  let runtimeLine = $derived.by(() => {
    const bits = [runVersion === null ? 'versão não registrada' : `v${runVersion}`];
    if (snapshot.environment?.node) bits.push(snapshot.environment.node);
    if (snapshot.environment?.platform) bits.push(snapshot.environment.platform);
    return bits.join(' · ');
  });

  // The run and the monitor are different processes and may be different
  // versions. This is the only place the two appear side by side, so the
  // divergence is said here or nowhere.
  let versionsDiverge = $derived(
    runVersion !== null && monitorVersion !== null && runVersion !== monitorVersion,
  );

  let routing = $derived.by(() => {
    const value = record(config?.routing);
    const mode = typeof value.mode === 'string' ? value.mode : null;
    const profile = typeof value.profile === 'string' ? value.profile : null;
    const policy = typeof value.policy === 'string' ? value.policy : null;
    return mode === null ? null : { mode, profile, policy };
  });
</script>

<section class="if-card if-context">
  <h2>Contexto</h2>

  <div class="if-columns">
    <div class="if-part">
      <h3>Issue</h3>
      <div class="if-issue">
        <span
          class="if-badge"
          class:if-state-open={issueState === 'open'}
          class:if-state-closed={issueState === 'closed'}
          class:if-state-unknown={issueState !== 'open' && issueState !== 'closed'}
          >{issueState ?? 'estado desconhecido'}</span
        >
        {#if snapshot.issue.labels.length > 0}
          <div class="if-badge-row">
            {#each snapshot.issue.labels as label (label)}
              <span class="if-badge if-label">{label}</span>
            {/each}
          </div>
        {/if}
        <p class="if-description">{snapshot.issue.description ?? 'Sem descrição.'}</p>
      </div>
    </div>

    <div class="if-part">
      <h3>Repositório</h3>
      <dl class="if-grid">
        <dt>Repositório</dt>
        <dd>{snapshot.repository.name ?? '—'}</dd>
        <dt>Branch</dt>
        <dd class="if-mono">{snapshot.repository.branch ?? '—'}</dd>
        <dt>Commit</dt>
        <dd class="if-mono">{snapshot.repository.headCommit ?? '—'}</dd>
        <dt>Diretório</dt>
        <dd class="if-mono" title={snapshot.repository.root ?? ''}>
          {snapshot.repository.root ?? '—'}
        </dd>
      </dl>
    </div>
  </div>

  <div class="if-part">
    <h3>
      Harnesses e configuração efetiva
      <span class="if-muted if-hint">versões, preferências futuras e overrides desta execução</span>
    </h3>

    <dl class="if-grid">
      <dt>Issue Flow (execução)</dt>
      <dd>{runtimeLine}</dd>
      <dt>Monitor (este painel)</dt>
      <dd>{monitorVersion === null ? '—' : `v${monitorVersion}`}</dd>
    </dl>

    {#if versionsDiverge}
      <p class="if-diverge">
        Este painel é servido por uma versão diferente da que executa o pipeline. Reinicie o
        monitor com <code>--restart-web</code> para ver a interface desta versão.
      </p>
    {/if}

    {#if snapshot.configuration === null}
      <p class="if-empty">Configuração não capturada nesta execução.</p>
    {:else}
      <dl class="if-grid">
        <dt>Harness padrão</dt>
        <dd>
          {snapshot.configuration.defaultProvider.value ?? '—'} · {configSourceLabel(
            snapshot.configuration.defaultProvider.source,
          )}
        </dd>
        <dt>Modelo padrão</dt>
        <dd>
          {snapshot.configuration.defaultModel.value ?? 'default do provider'} · {configSourceLabel(
            snapshot.configuration.defaultModel.source,
          )}
        </dd>
        <dt>Fallbacks</dt>
        <dd>{snapshot.configuration.fallbacks.join(' → ') || 'nenhum configurado'}</dd>
        <dt>Precedência</dt>
        <dd>{snapshot.configuration.precedence.join(' → ')}</dd>
        {#if routing}
          <dt>Routing</dt>
          <dd>{routing.mode}{routing.profile ? ` · perfil ${routing.profile}` : ''}</dd>
          <dt>Política</dt>
          <dd>
            {routing.policy === 'recommended' ? 'recomendada (opt-in)' : 'score adaptativo'}
          </dd>
        {/if}
      </dl>

      {#if snapshot.configuration.phases.length > 0}
        <div class="if-scroll-x">
          <div class="if-phase-grid">
            {#each snapshot.configuration.phases as phase (phase.phase)}
              <button
                type="button"
                class="if-phase-row"
                onclick={() => onopenphase(phase.phase)}
                title={`Abrir os detalhes da fase ${phase.phase}`}
              >
                <span class="if-mono">{phase.phase}</span>
                <span>{phase.provider.value ?? '—'}</span>
                <span>{phase.model.value ?? 'default do provider'}</span>
                <span class="if-muted"
                  >{configSourceLabel(phase.provider.source)} / {configSourceLabel(
                    phase.model.source,
                  )}</span
                >
              </button>
            {/each}
          </div>
        </div>
      {/if}
    {/if}

    <p class="if-write-note if-muted">
      O estado desta execução é somente leitura.
      {#if canEditPreferences}
        <button type="button" class="if-link" onclick={onopensettings}
          >Editar as preferências para execuções futuras</button
        >
      {:else}
        Este monitor não permite alterar preferências.
      {/if}
    </p>
  </div>
</section>

<style>
  /* Reference, not state: the whole block runs one step down. */
  .if-context {
    font-size: var(--font-size-md);
  }

  .if-issue {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .if-badge-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
  }

  .if-label {
    background: var(--surface-sunken);
    color: var(--text-muted);
    font-weight: 400;
  }

  .if-state-open {
    background: var(--state-ok-surface);
    color: var(--state-ok);
  }

  .if-state-closed {
    background: var(--state-merged-surface);
    color: var(--state-merged);
  }

  .if-state-unknown {
    background: var(--surface-sunken);
    color: var(--text-muted);
  }

  .if-description {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .if-hint {
    font-weight: 400;
    font-size: var(--font-size-xs);
    margin-left: var(--space-4);
  }

  .if-diverge {
    margin: 0;
    padding: var(--space-8);
    border-radius: var(--radius-small);
    background: var(--state-warn-surface);
    color: var(--state-warn);
  }

  /*
    The 1px gap is the divider: the grid's own background shows through it.
    One of the three documented exceptions to the closed spacing scale.
  */
  .if-phase-grid {
    display: grid;
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
    border-radius: var(--radius-small);
    overflow: hidden;
    min-width: 480px;
  }

  .if-phase-row {
    display: grid;
    grid-template-columns: 8rem 8rem 1fr 1fr;
    gap: var(--space-8);
    align-items: baseline;
    text-align: left;
    background: var(--surface);
    border: none;
    padding: var(--space-8);
    font: inherit;
    color: var(--text);
    cursor: pointer;
  }

  .if-phase-row:hover {
    background: var(--surface-sunken);
  }

  .if-write-note {
    margin: 0;
    font-size: var(--font-size-sm);
  }

  .if-link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
  }
</style>
