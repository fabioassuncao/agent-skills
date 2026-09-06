<script lang="ts">
  import { formatAgo, formatClock, formatTotals } from './format';
  import type { ExecutionSnapshot } from './snapshot';

  /**
   * "Estado agora" — the first of the four blocks (U6).
   *
   * PORT of `renderProgress`, `renderNow`, `renderResilience` and
   * `renderNextSteps`. First in the order on purpose: it is the only block with
   * a **layout requirement** — it has to be readable without scrolling at
   * 1440×900 *with the errors card open*. Before adding a line here, measure
   * (`getBoundingClientRect().bottom <= innerHeight`).
   *
   * "Próximos passos" is one line, not a list, and its label comes from the
   * markup: the steps are few and short, and a card of its own for three words
   * is how twelve equal-weight cards happen.
   */

  let { snapshot, now }: { snapshot: ExecutionSnapshot; now: number } = $props();

  let counters = $derived.by(() => {
    const p = snapshot.progress;
    const phases = `Fases ${p.phasesCompleted ?? 0}/${p.phasesTotal ?? 0}`;
    const stories = `Stories ${p.storiesCompleted ?? 0}/${p.storiesTotal ?? 0}`;
    const totals = formatTotals(snapshot.metrics);
    const base = `${phases} · ${stories}`;
    return totals ? `${base} · ${totals}` : base;
  });

  let idleMessage = $derived(
    snapshot.status === 'completed'
      ? 'Execução concluída.'
      : snapshot.status === 'failed'
        ? 'Execução falhou. Veja os erros acima.'
        : 'Nenhuma execução em andamento.',
  );

  let nextSteps = $derived(
    snapshot.nextSteps.length > 0
      ? snapshot.nextSteps.join(' · ')
      : snapshot.status === 'completed'
        ? 'Pipeline concluído.'
        : 'Nenhum passo pendente.',
  );
</script>

<section class="if-card">
  <h2>Estado agora</h2>

  <div aria-live="polite" class="if-progress">
    <div class="if-progress-row">
      <progress max="100" value={snapshot.progress.percent} aria-label="Progresso da execução"
      ></progress>
      <span class="if-progress-percent">{snapshot.progress.percent}%</span>
    </div>
    <p class="if-muted if-counters">{counters}</p>
  </div>

  <div class="if-columns">
    <div class="if-part">
      <h3>Executando agora</h3>
      <div aria-live="polite">
        {#if snapshot.status !== 'running'}
          <p class="if-empty">{idleMessage}</p>
        {:else}
          <dl class="if-grid">
            <dt>Fase</dt>
            <dd>
              {#if snapshot.currentPhase}
                <span class="if-live" aria-hidden="true"></span>
                {snapshot.currentPhase}
              {:else}
                —
              {/if}
            </dd>
            {#if snapshot.currentActivity}
              {#if snapshot.currentActivity.story}
                <dt>User story</dt>
                <dd>{snapshot.currentActivity.story}</dd>
              {/if}
              {#if snapshot.currentActivity.tool}
                <dt>Ferramenta</dt>
                <dd>{snapshot.currentActivity.tool}</dd>
              {/if}
              {#if snapshot.currentActivity.detail}
                <dt>Detalhe</dt>
                <dd>{snapshot.currentActivity.detail}</dd>
              {/if}
              <dt>Há quanto tempo</dt>
              <dd>{formatAgo(snapshot.currentActivity.since, now) || '—'}</dd>
            {/if}
          </dl>
        {/if}
      </div>
    </div>

    <div class="if-part">
      <h3>Resiliência</h3>
      <div aria-live="polite">
        <dl class="if-grid">
          <dt>Tentativa</dt>
          <dd>
            {snapshot.resilience.attempt !== null && snapshot.resilience.attempt > 0
              ? String(snapshot.resilience.attempt)
              : '—'}
          </dd>
          <dt>Provider</dt>
          <dd>{snapshot.resilience.provider ?? '—'}</dd>
          <dt>Modelo</dt>
          <dd>{snapshot.resilience.model ?? '—'}</dd>
          <dt>Última falha</dt>
          <dd>{snapshot.resilience.lastFailureKind ?? '—'}</dd>
          <dt>Cooldown</dt>
          <dd>
            {snapshot.resilience.cooldownUntil
              ? formatClock(snapshot.resilience.cooldownUntil)
              : '—'}
          </dd>
          <dt>Última atividade</dt>
          <dd>
            {snapshot.resilience.lastActivityAt
              ? `${formatClock(snapshot.resilience.lastActivityAt)} (${formatAgo(
                  snapshot.resilience.lastActivityAt,
                  now,
                )})`
              : '—'}
          </dd>
        </dl>
      </div>
    </div>
  </div>

  <p class="if-next-steps">
    <span class="if-muted">Próximos passos:</span>
    <span>{nextSteps}</span>
  </p>
</section>

<style>
  .if-progress {
    display: grid;
    gap: var(--space-4);
  }

  .if-progress-row {
    display: flex;
    align-items: center;
    gap: var(--space-8);
  }

  progress {
    flex: 1 1 auto;
    min-width: 0;
    height: var(--space-8);
    border-radius: var(--radius-pill);
  }

  .if-progress-percent {
    font-variant-numeric: tabular-nums;
    font-size: var(--font-size-md);
  }

  .if-counters {
    margin: 0;
    font-size: var(--font-size-sm);
  }

  .if-next-steps {
    margin: 0;
    font-size: var(--font-size-md);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
