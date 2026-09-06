<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { api } from './api';
  import BaseDialog from './BaseDialog.svelte';
  import Btn from './Btn.svelte';
  import LinkBtn from './LinkBtn.svelte';
  import { normalizeTextForPrompt } from './promptUtils';
  import { getToastController } from './toast-context';
  import type { PrComment, PrEntry } from './types';
  import { errorMessage, prLabel } from './utils';

  /**
   * PORT of `frontend/src/lib/CommentReviewDialog.svelte` @ d8c9d5f (166 lines).
   *
   * Review comments from the pull request, selected and handed to the agent as
   * a prompt. §50.2 pairs this with the independent reviewer's own findings in
   * one screen; this is the pull-request half of it, and phase 8C brings the
   * other.
   *
   * The comments are sorted newest-first for display but `originalIndex` is
   * what the selection set holds — sorting the selection with the display would
   * send the wrong comments the moment a refresh reorders them.
   *
   * `untrack` around the initial select-all is required: without it the effect
   * reads the set it just wrote and re-runs forever.
   */

  let {
    pr,
    branch,
    onclose,
    onsendsuccess,
  }: {
    pr: PrEntry;
    branch: string;
    onclose: () => void;
    onsendsuccess: () => void;
  } = $props();

  let sending = $state(false);
  let sendError = $state('');
  const toast = getToastController();

  const selected = new SvelteSet<number>();

  $effect(() => {
    const len = pr.comments.length;
    untrack(() => {
      selected.clear();
      for (let i = 0; i < len; i++) selected.add(i);
    });
  });

  let label = $derived(prLabel(pr));
  let sortedComments = $derived(
    pr.comments
      .map((comment, i) => ({ comment, originalIndex: i }))
      .sort((a, b) => b.comment.createdAt.localeCompare(a.comment.createdAt)),
  );
  let allSelected = $derived(selected.size === pr.comments.length);
  let noneSelected = $derived(selected.size === 0);

  function toggleAll(): void {
    if (allSelected) {
      selected.clear();
    } else {
      for (let i = 0; i < pr.comments.length; i++) selected.add(i);
    }
  }

  function toggleOne(index: number): void {
    if (selected.has(index)) {
      selected.delete(index);
    } else {
      selected.add(index);
    }
  }

  function formatComment(c: PrComment, idx: number): string {
    if (c.type === 'inline') {
      const loc = c.line ? `${c.path}:${c.line}` : c.path;
      const hunk = c.diffHunk ? `\n\`\`\`diff\n${c.diffHunk}\n\`\`\`\n` : '\n';
      return `[${idx}] @${c.author} (${c.createdAt.slice(0, 10)}) em ${loc}:${hunk}${c.body}`;
    }
    return `[${idx}] @${c.author} (${c.createdAt.slice(0, 10)}):\n${c.body}`;
  }

  async function handleSend(): Promise<void> {
    if (!branch || noneSelected) return;
    sending = true;
    sendError = '';
    const preamble = `${[
      'Revise estes comentários e elabore um plano para tratar os que considerar relevantes.',
      `PR: ${label}`,
      '',
      'Comentários:',
    ].join('\n')}\n`;
    const content = pr.comments
      .filter((_, i) => selected.has(i))
      .map((c, i) => formatComment(c, i + 1))
      .join('\n\n');
    try {
      await api.sendWorktreePrompt({
        params: { name: branch },
        body: {
          text: normalizeTextForPrompt(content, 20000),
          preamble,
        },
      });
      toast.success(
        `${selected.size} comentário${selected.size === 1 ? '' : 's'} enviado${
          selected.size === 1 ? '' : 's'
        } ao agente`,
      );
      onsendsuccess();
    } catch (err) {
      sendError = errorMessage(err);
    } finally {
      sending = false;
    }
  }
</script>

<BaseDialog {onclose} wide>
  <h2 class="text-base mb-4">Comentários do pull request &mdash; {label}</h2>

  <div class="flex items-center justify-between mb-3">
    <LinkBtn onclick={toggleAll}>
      {allSelected ? 'Desmarcar todos' : 'Marcar todos'}
    </LinkBtn>
    <span class="text-[11px] text-muted">
      {selected.size} de {pr.comments.length} selecionados
    </span>
  </div>

  <ul class="list-none p-0 m-0 flex flex-col gap-2 mb-4 max-h-[400px] overflow-y-auto">
    {#each sortedComments as { comment, originalIndex } (originalIndex)}
      <li class="rounded-md border border-edge bg-surface p-3">
        <label class="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={selected.has(originalIndex)}
            onchange={() => toggleOne(originalIndex)}
            class="mt-0.5 accent-accent"
          />
          <div class="flex-1 min-w-0">
            {#if comment.type === 'inline'}
              <div class="text-[10px] font-mono text-accent mb-1 truncate" title={comment.path}>
                {comment.path}{comment.line ? `:${comment.line}` : ''}
                {#if comment.isReply}
                  <span class="text-muted ml-1">(resposta)</span>
                {/if}
              </div>
            {/if}
            <div class="text-[12px] text-muted mb-1">
              <span class="font-medium text-primary">@{comment.author}</span>
              &middot; {comment.createdAt.slice(0, 10)}
              {#if comment.type === 'inline'}
                <span class="text-accent ml-1">revisão</span>
              {/if}
            </div>
            <pre class="text-[11px] font-mono whitespace-pre-wrap m-0 text-primary">{comment.body}</pre>
          </div>
        </label>
      </li>
    {/each}
  </ul>

  {#if sendError}
    <div class="text-[12px] text-danger mb-3" role="alert">{sendError}</div>
  {/if}

  <div class="flex justify-end gap-2">
    <Btn type="button" onclick={onclose}>Cancelar</Btn>
    <Btn variant="cta" small disabled={noneSelected || sending} onclick={handleSend}>
      {sending ? 'Enviando…' : `Enviar ${selected.size} ao agente`}
    </Btn>
  </div>
</BaseDialog>
