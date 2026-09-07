<script lang="ts">
  import { formatAskUserQuestionAnswer } from './ask-user-question';
  import type { AskUserQuestionInput } from './types';

  /**
   * PORT of `frontend/src/lib/AskUserQuestionCard.svelte` @ d8c9d5f (141 lines).
   *
   * Human-in-the-loop, already built (§48.1 marks it the priority port and
   * phase 9 consumes it). `autoSend` is the interaction rule: a single
   * single-select question answers on one tap, anything else needs an explicit
   * submit, because a stray tap on a multi-select would otherwise send a
   * half-formed answer the agent then acts on.
   *
   * `text-white` is replaced by `text-accent-text` throughout (ADR-19 /
   * contrast table).
   */

  interface Props {
    input: AskUserQuestionInput;
    disabled: boolean;
    onSubmit: (text: string) => void;
  }

  const { input, disabled, onSubmit }: Props = $props();

  const autoSend = $derived(
    input.questions.length === 1 && input.questions[0]?.multiSelect !== true,
  );

  let selections = $state<Record<number, string[]>>({});
  let customText = $state<Record<number, string>>({});

  function setSelection(qIndex: number, next: string[]): void {
    selections = { ...selections, [qIndex]: next };
  }

  function setCustom(qIndex: number, value: string): void {
    customText = { ...customText, [qIndex]: value };
  }

  function isSelected(qIndex: number, label: string): boolean {
    return (selections[qIndex] ?? []).includes(label);
  }

  function buildAnswers(): Array<{ header: string; values: string[] }> {
    return input.questions.map((question, index) => {
      const custom = customText[index]?.trim() ?? '';
      const values = [...(selections[index] ?? [])];
      if (custom.length > 0) values.push(custom);
      return { header: question.header, values };
    });
  }

  const canSubmit = $derived(
    !disabled && buildAnswers().some((answer) => answer.values.length > 0),
  );

  function submitSingle(header: string, value: string): void {
    onSubmit(formatAskUserQuestionAnswer([{ header, values: [value] }]));
  }

  function submitAll(): void {
    if (disabled) return;
    const text = formatAskUserQuestionAnswer(buildAnswers());
    if (text.length === 0) return;
    onSubmit(text);
  }

  function toggleOption(qIndex: number, label: string): void {
    if (disabled) return;
    const question = input.questions[qIndex];
    if (!question) return;
    if (autoSend) {
      submitSingle(question.header, label);
      return;
    }
    const current = selections[qIndex] ?? [];
    if (question.multiSelect) {
      setSelection(
        qIndex,
        current.includes(label) ? current.filter((value) => value !== label) : [...current, label],
      );
    } else {
      setSelection(qIndex, current.includes(label) ? [] : [label]);
    }
  }

  function handleCustomKeydown(event: KeyboardEvent, qIndex: number): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (disabled) return;
    const custom = customText[qIndex]?.trim() ?? '';
    if (autoSend) {
      const question = input.questions[qIndex];
      if (!question || custom.length === 0) return;
      submitSingle(question.header, custom);
      return;
    }
    if (canSubmit) submitAll();
  }
</script>

<div
  class="self-start w-full max-w-[94%] min-w-0 rounded-md border border-accent/40 bg-surface text-xs text-primary"
>
  <div class="border-b border-edge px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-muted">
    Pergunta
  </div>

  <div class="flex flex-col gap-4 px-3 py-3">
    {#each input.questions as question, qIndex (`${question.header}:${qIndex}`)}
      <div class="flex min-w-0 flex-col gap-2">
        <div class="text-[10px] uppercase tracking-[0.12em] text-muted">{question.header}</div>
        <div class="text-sm text-primary">{question.question}</div>
        <div class="flex flex-wrap gap-2">
          {#each question.options as option (option.label)}
            <button
              type="button"
              class={`min-w-0 max-w-full rounded-md border px-3 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                isSelected(qIndex, option.label)
                  ? 'border-accent bg-accent text-accent-text'
                  : 'border-edge bg-surface text-primary enabled:hover:bg-hover'
              }`}
              {disabled}
              onclick={() => toggleOption(qIndex, option.label)}
            >
              <span class="block break-words font-medium">{option.label}</span>
              {#if option.description}
                <span
                  class={`mt-0.5 block break-words text-[10px] ${
                    isSelected(qIndex, option.label) ? 'text-accent-text/80' : 'text-muted'
                  }`}
                >
                  {option.description}
                </span>
              {/if}
            </button>
          {/each}
        </div>
        <input
          type="text"
          aria-label={`Resposta livre para: ${question.header}`}
          class="w-full rounded-md border border-edge bg-surface px-3 py-1.5 text-xs text-primary outline-none transition placeholder:text-muted/70 focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          placeholder="Resposta livre…"
          value={customText[qIndex] ?? ''}
          oninput={(event) => setCustom(qIndex, event.currentTarget.value)}
          onkeydown={(event) => handleCustomKeydown(event, qIndex)}
          {disabled}
        />
      </div>
    {/each}
  </div>

  {#if !autoSend}
    <div class="flex justify-end border-t border-edge px-3 py-2">
      <button
        type="button"
        class="rounded-md border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-accent-text transition enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
        onclick={submitAll}
        disabled={!canSubmit}
      >
        Enviar resposta
      </button>
    </div>
  {/if}
</div>
