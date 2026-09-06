<script lang="ts">
  import type { ExecutionSnapshot } from './snapshot';
  import { VERIFICATION_LABELS, VERIFICATION_TONE } from './vocabulary';

  /**
   * The acceptance-contract verdict (U21).
   *
   * **`unverified` is a first-class verdict, never an absence dressed up as a
   * pass.** It means a contract ran and could not conclude — the run may have
   * finished, the tests may have printed nothing useful, the evidence may be
   * missing — and painting that green is the failure this component exists to
   * prevent. It gets the `warn` role, next to `passed`'s `ok` and `failed`'s
   * `error`, and it says so in words.
   *
   * `verification === null` is the **different** statement that no contract has
   * run at all. That is also not a pass, and it is also not a failure: it is
   * "not verified yet", and it is rendered as its own line rather than folded
   * into `unverified`, which would claim a contract ran.
   */

  let { verification }: { verification: ExecutionSnapshot['verification'] } = $props();

  let verdict = $derived(verification?.verdict ?? null);
  let tone = $derived(verdict === null ? null : VERIFICATION_TONE[verdict]);
</script>

<div class="if-part">
  <h3>Verificação</h3>
  {#if verification === null}
    <p class="if-empty">Nenhum contrato de aceitação foi executado nesta execução.</p>
  {:else if verdict === null}
    <p class="if-verdict if-verdict-warn">
      <strong>veredito não reconhecido</strong> — este painel não sabe interpretar o resultado
      registrado. Ele não é tratado como aprovação.
    </p>
  {:else}
    <p class="if-verdict if-verdict-{tone}">
      <strong>{VERIFICATION_LABELS[verdict]}</strong>
      {#if verdict === 'unverified'}
        — o contrato rodou e não conseguiu concluir. Isto não é uma aprovação.
      {/if}
    </p>
    <dl class="if-grid">
      <dt>Nível</dt>
      <dd>{verification.level ?? '—'}</dd>
      <dt>Independência</dt>
      <dd>{verification.independence ?? '—'}</dd>
    </dl>
  {/if}
</div>

<style>
  .if-verdict {
    margin: 0;
    padding: var(--space-8);
    border-radius: var(--radius-small);
    font-size: var(--font-size-md);
    overflow-wrap: anywhere;
  }

  .if-verdict-ok {
    background: var(--state-ok-surface);
    color: var(--state-ok);
  }

  .if-verdict-warn {
    background: var(--state-warn-surface);
    color: var(--state-warn);
  }

  .if-verdict-error {
    background: var(--state-error-surface);
    color: var(--state-error);
  }
</style>
