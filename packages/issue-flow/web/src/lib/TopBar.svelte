<script lang="ts">
  import Btn from './Btn.svelte';
  import LinearBadge from './LinearBadge.svelte';
  import NotificationItem from './NotificationItem.svelte';
  import RepoGroup from './RepoGroup.svelte';
  import type { AppNotification, LinkedRepoInfo, PrEntry, WorktreeInfo } from './types';
  import { makeCursorUrl } from './utils';

  /**
   * PORT of `frontend/src/lib/TopBar.svelte` @ d8c9d5f (407 lines).
   *
   * The header carries the identity of what is selected, not the product name —
   * the same rule the current panel already applies to its `h1`: the most
   * visible line on the screen is for what is happening.
   *
   * `truncateWorktreeName` is applied in JS rather than by CSS ellipsis because
   * the value is also the `title`: truncating in CSS would leave the tooltip
   * showing the same clipped string.
   */

  let {
    name,
    worktree,
    sshHost,
    linkedRepos = [],
    isMobile = false,
    notificationHistory = [],
    unreadCount = 0,
    ontogglesidebar,
    onclose,
    onarchive,
    onmerge,
    onremove,
    oneditlabel,
    onsettings,
    onCiClick,
    onReviewsClick,
    ondirtyclick,
    onbellopen,
    onnotificationselect,
    onlinearclick,
    archiving = false,
  }: {
    name: string | null;
    worktree: WorktreeInfo | undefined;
    sshHost: string;
    linkedRepos?: LinkedRepoInfo[];
    isMobile?: boolean;
    notificationHistory?: AppNotification[];
    unreadCount?: number;
    ontogglesidebar?: () => void;
    onclose: () => void;
    onarchive: () => void;
    onmerge: () => void;
    onremove: () => void;
    oneditlabel?: () => void;
    onsettings: () => void;
    onCiClick: (pr: PrEntry) => void;
    onReviewsClick: (pr: PrEntry) => void;
    ondirtyclick?: () => void;
    onbellopen?: () => void;
    onnotificationselect?: (branch: string) => void;
    onlinearclick?: (issue: NonNullable<WorktreeInfo['linearIssue']>) => void;
    archiving?: boolean;
  } = $props();

  let bellOpen = $state(false);
  let moreOpen = $state(false);

  function toggleBell(): void {
    bellOpen = !bellOpen;
    if (bellOpen) onbellopen?.();
  }

  function handleClickOutside(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (!target.closest('.bell-container')) {
      bellOpen = false;
    }
    if (!target.closest('.more-container')) {
      moreOpen = false;
    }
  }

  function truncateWorktreeName(value: string | null, maxLength: number): string | null {
    if (!value || value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 3)}...`;
  }

  let cursorUrl = $derived(makeCursorUrl(worktree?.dir, sshHost));
  let headerName = $derived(worktree?.label ?? name);
  let displayName = $derived(truncateWorktreeName(headerName, 30));
  let displayBranch = $derived(worktree?.label ? truncateWorktreeName(name, 44) : null);

  // Split PRs into the main repository and each linked one.
  let mainPrs = $derived(
    (worktree?.prs ?? []).filter(
      (pr) => !pr.repo || !linkedRepos.some((lr) => lr.alias === pr.repo),
    ),
  );

  let linkedRepoGroups = $derived(
    linkedRepos
      .map((lr) => ({
        alias: lr.alias,
        dir: lr.dir,
        cursorUrl: makeCursorUrl(lr.dir && name ? `${lr.dir}/${name}` : null, sshHost),
        prs: (worktree?.prs ?? []).filter((pr) => pr.repo === lr.alias),
      }))
      .filter((g) => g.prs.length > 0 || g.cursorUrl),
  );

  let hasMoreContent = $derived(mainPrs.length > 0 || linkedRepoGroups.length > 0);
</script>

<div class="bg-topbar border-b border-edge">
  <div class="flex items-stretch min-h-12">
    <!-- Left and middle: rows of repository groups -->
    <div class="flex-1 min-w-0 flex flex-col justify-center px-4 py-2.5 gap-1.5">
      <!-- Main row: name, worktree-level badges, main repository PR badges -->
      <div class="topbar-main-row flex items-start gap-3 min-w-0">
        <div class="topbar-main-meta flex items-center gap-3 min-w-0">
          {#if isMobile && ontogglesidebar}
            <button
              type="button"
              class="p-1 -ml-1 cursor-pointer bg-transparent border-none text-muted hover:text-primary"
              onclick={ontogglesidebar}
              title="Mostrar ou ocultar a barra lateral"
              aria-label="Mostrar ou ocultar a barra lateral"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
          {/if}
          <span class="min-w-0 flex flex-col leading-tight">
            <span class="flex items-center gap-1.5 min-w-0">
              <span class="min-w-0 text-sm font-semibold truncate" title={headerName ?? undefined}
                >{displayName ?? 'Selecione um worktree'}</span
              >
              {#if worktree && oneditlabel}
                <button
                  type="button"
                  class="shrink-0 p-0.5 rounded text-muted hover:text-primary hover:bg-hover"
                  title="Editar o rótulo do workspace"
                  aria-label="Editar o rótulo do workspace"
                  onclick={oneditlabel}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              {/if}
              {#if worktree?.linearIssue}
                <button
                  type="button"
                  class="shrink-0 bg-transparent border-none p-0 cursor-pointer"
                  aria-label={`Ver ${worktree.linearIssue.identifier} no Linear`}
                  onclick={() => onlinearclick?.(worktree.linearIssue as NonNullable<WorktreeInfo['linearIssue']>)}
                >
                  <LinearBadge issue={worktree.linearIssue} />
                </button>
              {/if}
            </span>
            {#if displayBranch}
              <span class="text-[10px] text-muted truncate" title={name ?? undefined}
                >{displayBranch}</span
              >
            {/if}
          </span>
          {#if worktree?.archived}
            <span class="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-edge text-muted"
              >Arquivado</span
            >
          {/if}
          {#if worktree?.dirty || worktree?.unpushed}
            <button
              type="button"
              class="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-warning/40 text-warning bg-transparent cursor-pointer hover:bg-warning/10"
              onclick={ondirtyclick}
              >{worktree.dirty ? 'com mudanças' : 'não enviado'}</button
            >
          {/if}
        </div>
        {#if !isMobile}
          <div class="topbar-main-prs min-w-0 flex-1">
            <RepoGroup
              prs={mainPrs}
              services={worktree?.services ?? []}
              {cursorUrl}
              {onCiClick}
              {onReviewsClick}
            />
          </div>
        {/if}
      </div>

      <!-- Linked repository rows (desktop only) -->
      {#if !isMobile}
        {#each linkedRepoGroups as group (group.alias)}
          <RepoGroup
            label={group.alias}
            prs={group.prs}
            cursorUrl={group.cursorUrl}
            {onCiClick}
            {onReviewsClick}
          />
        {/each}
      {/if}
    </div>

    <!-- Right: actions, pinned and vertically centred -->
    <div class="shrink-0 flex gap-2 items-center px-4">
      {#if worktree}
        {#if worktree.mux === '✓'}
          <Btn variant="default" onclick={onclose} title="Fechar a janela do worktree"
            >{isMobile ? 'F' : 'Fechar'}</Btn
          >
        {/if}
        <Btn
          variant="accent-outline"
          onclick={onarchive}
          disabled={archiving || worktree.creating}
          title={worktree.archived ? 'Restaurar worktree arquivado' : 'Arquivar worktree'}
        >
          {isMobile
            ? worktree.archived
              ? 'Re'
              : 'A'
            : worktree.archived
              ? 'Restaurar'
              : 'Arquivar'}
        </Btn>
        <Btn variant="accent-outline" onclick={onmerge} title="Integrar o worktree"
          >{isMobile ? 'I' : 'Integrar'}</Btn
        >
        <Btn variant="danger-outline" onclick={onremove} title="Remover o worktree"
          >{isMobile ? 'R' : 'Remover'}</Btn
        >
      {/if}

      {#if isMobile && worktree && hasMoreContent}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="more-container relative" onkeydown={() => {}}>
          <button
            type="button"
            class="p-1.5 rounded-md cursor-pointer bg-transparent border border-transparent text-muted hover:text-primary hover:border-edge"
            title="Mais informações"
            aria-label="Mais informações"
            aria-expanded={moreOpen}
            onclick={() => {
              moreOpen = !moreOpen;
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="5" r="1" />
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="19" r="1" />
            </svg>
          </button>

          {#if moreOpen}
            <div class="more-dropdown">
              <div class="flex flex-col gap-2 p-3">
                <RepoGroup prs={mainPrs} {onCiClick} {onReviewsClick} />
                {#each linkedRepoGroups as group (group.alias)}
                  <RepoGroup
                    label={group.alias}
                    prs={group.prs}
                    {onCiClick}
                    {onReviewsClick}
                  />
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="bell-container relative ml-3" onkeydown={() => {}}>
        <button
          type="button"
          class="relative p-1.5 rounded-md cursor-pointer bg-transparent border border-transparent text-muted hover:text-primary hover:border-edge"
          title="Notificações"
          aria-label="Notificações"
          aria-expanded={bellOpen}
          onclick={toggleBell}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          {#if unreadCount > 0}
            <span
              class="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-accent text-accent-text text-[10px] flex items-center justify-center leading-none"
              >{unreadCount > 9 ? '9+' : unreadCount}</span
            >
          {/if}
        </button>

        {#if bellOpen}
          <div class="bell-dropdown">
            <div class="text-xs font-semibold text-muted px-3 py-2 border-b border-edge">
              Notificações
            </div>
            {#if notificationHistory.length === 0}
              <div class="px-3 py-4 text-xs text-muted text-center">Nenhuma notificação ainda</div>
            {:else}
              <ul class="list-none max-h-64 overflow-y-auto">
                {#each notificationHistory as n (n.id)}
                  <li>
                    <button
                      type="button"
                      class="w-full px-3 py-2 text-left bg-transparent border-none text-inherit cursor-pointer hover:bg-hover flex items-center gap-2"
                      onclick={() => {
                        onnotificationselect?.(n.branch);
                        bellOpen = false;
                      }}
                    >
                      <NotificationItem notification={n} showTimestamp />
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>

      <button
        type="button"
        class="p-1.5 rounded-md cursor-pointer bg-transparent border border-transparent text-muted hover:text-primary hover:border-edge"
        title="Configurações"
        aria-label="Configurações"
        onclick={onsettings}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
          />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </div>
  </div>
</div>

<svelte:window onclick={handleClickOutside} />

<style>
  .more-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: var(--space-4);
    width: max-content;
    max-width: 80vw;
    border-radius: var(--radius-medium);
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: 0 4px 12px var(--overlay);
    z-index: 50;
  }

  .bell-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: var(--space-4);
    width: 18rem;
    border-radius: var(--radius-medium);
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: 0 4px 12px var(--overlay);
    z-index: 50;
  }
</style>
