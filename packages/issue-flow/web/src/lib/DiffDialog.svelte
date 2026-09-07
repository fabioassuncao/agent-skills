<script lang="ts">
  import 'diff2html/bundles/css/diff2html.min.css';
  import { html as diff2html } from 'diff2html';
  import { ColorSchemeType } from 'diff2html/lib/types';
  import { api } from './api';
  import BaseDialog from './BaseDialog.svelte';
  import Btn from './Btn.svelte';
  import CursorButton from './CursorButton.svelte';
  import type { DiffDialogProps, UnpushedCommit } from './types';
  import { errorMessage } from './utils';

  /**
   * PORT of `frontend/src/lib/DiffDialog.svelte` @ d8c9d5f (228 lines).
   *
   * `diff2html` renders the diff; §50.3 makes this the one diff surface, so the
   * commit list the panel shows in its "Saída" block opens here rather than
   * growing a second renderer.
   *
   * One adaptation: the upstream hard-codes `ColorSchemeType.DARK` because it
   * only has dark themes. Here the scheme follows the resolved theme, or the
   * diff is dark-on-light in the light theme and unreadable.
   *
   * `initialTabSet` picks the first tab that actually has content, once: doing
   * it on every render would yank the user back to "diff" the moment a refresh
   * finds an uncommitted change.
   */

  let { branch, cursorUrl = null, onclose }: DiffDialogProps = $props();

  let uncommitted = $state('');
  let uncommittedTruncated = $state(false);
  let gitStatus = $state('');
  let unpushedCommits = $state<UnpushedCommit[]>([]);
  let loading = $state(true);
  let error = $state('');

  $effect(() => {
    loading = true;
    error = '';
    api
      .fetchWorktreeDiff({ params: { name: branch } })
      .then((res) => {
        uncommitted = res.uncommitted;
        uncommittedTruncated = res.uncommittedTruncated;
        gitStatus = res.gitStatus;
        unpushedCommits = res.unpushedCommits;
      })
      .catch((err: unknown) => {
        error = errorMessage(err);
      })
      .finally(() => {
        loading = false;
      });
  });

  function resolvedColorScheme(): ColorSchemeType {
    if (typeof document === 'undefined') return ColorSchemeType.LIGHT;
    const forced = document.documentElement.getAttribute('data-theme');
    if (forced !== null && forced !== 'light') return ColorSchemeType.DARK;
    if (forced === 'light') return ColorSchemeType.LIGHT;
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? ColorSchemeType.DARK
      : ColorSchemeType.LIGHT;
  }

  let diffOpts = $derived({
    outputFormat: 'line-by-line' as const,
    colorScheme: resolvedColorScheme(),
    drawFileList: false,
  });

  let renderedUncommitted = $derived(uncommitted ? diff2html(uncommitted, diffOpts) : '');
  let gitStatusLineCount = $derived(
    gitStatus ? gitStatus.split('\n').filter((line) => line.length > 0).length : 0,
  );
  let hasContent = $derived(!!uncommitted || gitStatusLineCount > 0 || unpushedCommits.length > 0);

  type DiffTab = 'diff' | 'status' | 'unpushed';
  let activeTab = $state<DiffTab>('diff');

  let initialTabSet = false;
  $effect(() => {
    if (!loading && !error && !initialTabSet) {
      initialTabSet = true;
      activeTab = uncommitted ? 'diff' : gitStatusLineCount > 0 ? 'status' : 'unpushed';
    }
  });
</script>

<BaseDialog {onclose} wide maxWidth="90vw" className="diff-dialog">
  <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
    <h2 class="text-base">
      Mudanças &mdash; <span class="font-mono text-sm">{branch}</span>
    </h2>
    {#if cursorUrl}
      <CursorButton url={cursorUrl} />
    {/if}
  </div>

  {#if loading}
    <div class="text-sm text-muted py-8 text-center">Carregando o diff…</div>
  {:else if error}
    <div class="text-sm text-danger py-8 text-center" role="alert">{error}</div>
  {:else if !hasContent}
    <div class="text-sm text-muted py-8 text-center">Nenhuma mudança</div>
  {:else}
    <div class="flex gap-1 mb-3">
      <button
        type="button"
        class="tab-btn"
        class:active={activeTab === 'diff'}
        disabled={!uncommitted}
        onclick={() => (activeTab = 'diff')}>Diff atual</button
      >
      <button
        type="button"
        class="tab-btn"
        class:active={activeTab === 'status'}
        disabled={gitStatusLineCount === 0}
        onclick={() => (activeTab = 'status')}>Estado do git ({gitStatusLineCount})</button
      >
      <button
        type="button"
        class="tab-btn"
        class:active={activeTab === 'unpushed'}
        disabled={unpushedCommits.length === 0}
        onclick={() => (activeTab = 'unpushed')}
        >Commits não enviados ({unpushedCommits.length})</button
      >
    </div>

    {#if activeTab === 'diff' && uncommitted}
      <div
        class="diff-container overflow-auto max-h-[60vh] md:max-h-[70vh] rounded-md border border-edge"
      >
        {#if uncommittedTruncated}
          <div class="text-[11px] text-warning px-3 py-1">Truncado (passou de 200 KB)</div>
        {/if}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html renderedUncommitted}
      </div>
    {:else if activeTab === 'status' && gitStatusLineCount > 0}
      <div class="overflow-auto max-h-[60vh] md:max-h-[70vh] rounded-md border border-edge">
        <div class="px-3 py-2 text-[11px] text-muted border-b border-edge bg-surface font-mono">
          git status --short
        </div>
        <pre class="git-status-output">{gitStatus}</pre>
      </div>
    {:else if activeTab === 'unpushed' && unpushedCommits.length > 0}
      <ul
        class="commit-list overflow-auto max-h-[60vh] md:max-h-[70vh] rounded-md border border-edge list-none m-0 p-0"
      >
        {#each unpushedCommits as commit (commit.hash)}
          <li class="flex items-baseline gap-2 px-3 py-1.5 border-b border-edge last:border-b-0">
            <code class="text-[11px] text-accent shrink-0">{commit.hash}</code>
            <span class="text-[12px] text-primary">{commit.message}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  <div class="flex justify-end mt-4">
    <Btn type="button" onclick={onclose}>Fechar</Btn>
  </div>
</BaseDialog>

<style>
  @media (max-width: 768px) {
    :global(.diff-dialog) {
      max-width: 100vw !important;
      width: 100% !important;
      height: 100dvh;
      max-height: 100dvh;
      margin: 0;
      border-radius: 0 !important;
      font-size: var(--font-size-xs);
    }
  }

  .tab-btn {
    padding: var(--space-4) var(--space-12);
    font-size: var(--font-size-xs);
    border-radius: var(--radius-small);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .tab-btn:hover {
    color: var(--text);
    background: var(--surface-sunken);
  }
  .tab-btn.active {
    background: var(--surface);
    color: var(--text);
    border-color: var(--accent);
  }
  .tab-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tab-btn:disabled:hover {
    color: var(--text-muted);
    background: transparent;
  }

  .diff-container {
    font-size: var(--font-size-sm);
  }

  .git-status-output {
    margin: 0;
    padding: var(--space-12);
    font-size: var(--font-size-sm);
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
      monospace;
  }

  .diff-container :global(.d2h-wrapper) {
    background: transparent;
  }
  .diff-container :global(.d2h-file-header) {
    background: var(--surface);
    border-color: var(--border);
    color: var(--text);
  }
  .diff-container :global(.d2h-file-name) {
    color: var(--text);
  }
  .diff-container :global(.d2h-code-linenumber),
  .diff-container :global(.d2h-code-line) {
    color: var(--text);
    font-size: var(--font-size-xs);
  }
  .diff-container :global(.d2h-code-line-ctn) {
    color: var(--text);
  }
  .diff-container :global(td.d2h-code-linenumber) {
    border-color: var(--border);
    position: static;
  }

  @media (max-width: 768px) {
    .diff-container {
      max-height: calc(100dvh - 8rem) !important;
    }
    .diff-container :global(.d2h-code-line),
    .diff-container :global(.d2h-code-linenumber) {
      padding: 0 var(--space-4);
    }
  }
</style>
