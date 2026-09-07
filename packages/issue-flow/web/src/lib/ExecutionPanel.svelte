<script lang="ts">
  import type { Snippet } from 'svelte';
  import ContextBlock from './ContextBlock.svelte';
  import ExecutionAlerts from './ExecutionAlerts.svelte';
  import ExecutionDrawer, { type DrawerSelection } from './ExecutionDrawer.svelte';
  import ExecutionHeader from './ExecutionHeader.svelte';
  import ExecutionTabs, { type TabDefinition } from './ExecutionTabs.svelte';
  import HistoryList from './HistoryList.svelte';
  import KanbanBoard from './KanbanBoard.svelte';
  import NowBlock from './NowBlock.svelte';
  import OutputBlock from './OutputBlock.svelte';
  import ProgressBlock from './ProgressBlock.svelte';
  import ReviewBlock from './ReviewBlock.svelte';
  import VerificationVerdictCard from './VerificationVerdictCard.svelte';
  import WorkspaceBlock from './WorkspaceBlock.svelte';
  import type { HistoryFilter, JournalEntryView, LogFilter } from './executions';
  import { formatClock } from './format';
  import type { ExecutionSnapshot } from './snapshot';
  import type { EffectiveConfigResponse, PrEntry, WorktreeInfo } from './types';

  /**
   * The main panel — **one** panel, for both of §49's modes.
   *
   * PORT of `#view-detail` (the header, the alert card, the tabs and the four
   * blocks), consolidated in phase 8D into §50.5's navigation. The rule that
   * keeps this from becoming two interfaces is stated once, here, and every
   * decision below follows from it:
   *
   * > A Task **contains** its sessions, worktrees, terminal, services and
   * > PR/CI. It does not point at another area. A free session is the same
   * > screen without the workflow tabs. The components are the same in both.
   *
   * So the panel does **not** branch on "which list did the selection come
   * from". It branches on one thing — whether the selection has an execution
   * snapshot behind it — and that single question is what makes the promotion
   * of §49.2 free: a free session linked to an issue starts having a snapshot,
   * so the workflow tabs appear, in place, with no new component and no event
   * (I4).
   *
   * **The panels are all rendered**, not switched, so an inactive tab is never
   * stale and the drawer stays current while the Kanban is hidden. The terminal
   * is the one exception and it is deliberate: `display: none` gives xterm a
   * zero-size container, and a terminal that measured itself at zero columns is
   * worse than one that reattaches — and reattaching is the path the port
   * already hardened (`lastOffset` on the attach frame).
   *
   * `[hidden]` needs `display: none` stated explicitly — the panel's own
   * `display: grid` would otherwise win over the attribute.
   */

  let {
    snapshot = null,
    worktree = null,
    worktrees = [],
    now,
    events = [],
    diagnostics = [],
    config = null,
    monitorVersion = null,
    canEditPreferences = false,
    hasPullRequestSync = false,
    refreshSeconds,
    activeTab,
    logFilter,
    historyFilter,
    drawer = null,
    canDiff = false,
    terminal = null,
    chat = null,
    onrefreshchange,
    ontabchange,
    onlogfilterchange,
    onhistoryfilterchange,
    onopendrawer,
    onclosedrawer,
    onopensettings,
    onopendiff = null,
    onselectworktree = null,
    onopencomments = null,
    onback = null,
  }: {
    snapshot?: ExecutionSnapshot | null;
    worktree?: WorktreeInfo | null;
    worktrees?: readonly WorktreeInfo[];
    now: number;
    events?: readonly JournalEntryView[];
    diagnostics?: readonly Record<string, unknown>[];
    config?: EffectiveConfigResponse | null;
    monitorVersion?: string | null;
    canEditPreferences?: boolean;
    hasPullRequestSync?: boolean;
    refreshSeconds: number;
    activeTab: string;
    logFilter: LogFilter;
    historyFilter: HistoryFilter;
    drawer?: DrawerSelection | null;
    canDiff?: boolean;
    terminal?: Snippet | null;
    chat?: Snippet | null;
    onrefreshchange: (seconds: number) => void;
    ontabchange: (id: string) => void;
    onlogfilterchange: (filter: LogFilter) => void;
    onhistoryfilterchange: (filter: HistoryFilter) => void;
    onopendrawer: (selection: DrawerSelection) => void;
    onclosedrawer: () => void;
    onopensettings: () => void;
    onopendiff?: (() => void) | null;
    onselectworktree?: ((branch: string) => void) | null;
    onopencomments?: ((pr: PrEntry) => void) | null;
    onback?: (() => void) | null;
  } = $props();

  /**
   * The tab set of §50.5.
   *
   * Two lists, one component set. The workflow half exists only when there is a
   * workflow to show; `terminal` and `sessions` are in **both**, with the same
   * ids and the same panels, because they are the same thing seen from either
   * mode. The free-session labels differ because one row and N rows are not the
   * same sentence, not because the component is different.
   */
  let tabs = $derived.by(() => {
    const list: TabDefinition[] = [];
    const terminalTabs: TabDefinition[] = [];
    if (terminal !== null) terminalTabs.push({ id: 'terminal', label: 'Terminal' });
    if (chat !== null) terminalTabs.push({ id: 'chat', label: 'Chat' });

    if (snapshot === null) {
      // A free session, in §50.5's order: the terminal first, because that is
      // what opening a session was for. The first tab is also the fallback, so
      // the order is the default landing too.
      return [
        ...terminalTabs,
        { id: 'sessions', label: 'Worktree e serviços' },
      ];
    }

    list.push({ id: 'execution', label: 'Visão geral' });
    list.push({ id: 'stories', label: 'Stories' });
    list.push({ id: 'sessions', label: 'Sessões e worktrees' });
    list.push(...terminalTabs);
    list.push({ id: 'verification', label: 'Verificação' });
    list.push({ id: 'review', label: 'Review' });
    list.push({ id: 'output', label: 'Saída' });
    list.push({ id: 'history', label: 'Histórico' });
    return list;
  });

  /**
   * Which tab is really on screen.
   *
   * The shell owns `activeTab` across selections, and the two tab sets do not
   * hold the same ids — a person on "Histórico" who clicks a free session would
   * otherwise land on no panel at all. Falling back to the first tab is the only
   * answer that always shows something; the choice survives whenever it can.
   */
  let current = $derived(
    tabs.some((tab) => tab.id === activeTab) ? activeTab : (tabs[0]?.id ?? 'sessions'),
  );

  let meta = $derived.by(() => {
    const parts: string[] = [];
    if (snapshot?.sessionId) parts.push(`execução ${snapshot.sessionId}`);
    if (snapshot?.updatedAt) parts.push(`atualizado ${formatClock(snapshot.updatedAt)}`);
    parts.push('somente leitura');
    return parts.join(' · ');
  });

  let workspaceRows = $derived(
    worktrees.length > 0 ? worktrees : worktree === null ? [] : [worktree],
  );
  let pullRequests = $derived(worktree?.prs ?? []);
</script>

<div class="if-surface">
  <ExecutionHeader
    {snapshot}
    {worktree}
    {monitorVersion}
    {now}
    {refreshSeconds}
    {onrefreshchange}
    {onback}
  />

  {#if snapshot}
    <ExecutionAlerts {snapshot} {now} />
  {/if}

  <ExecutionTabs tabs={tabs} active={current} onselect={ontabchange} />

  {#if snapshot}
    <div
      class="if-panel if-two-column"
      id="panel-execution"
      role="tabpanel"
      aria-labelledby="tab-execution"
      tabindex="0"
      hidden={current !== 'execution'}
    >
      <NowBlock {snapshot} {now} />
      <ContextBlock
        {snapshot}
        {config}
        {monitorVersion}
        {canEditPreferences}
        {onopensettings}
        onopenphase={(phase) => onopendrawer({ kind: 'phase', id: phase })}
      />
      <ProgressBlock
        {snapshot}
        {now}
        part="phases"
        onopenphase={(name) => onopendrawer({ kind: 'phase', id: name })}
        onopenstory={(id) => onopendrawer({ kind: 'story', id })}
      />
    </div>

    <!--
      Stories: the list and the board, together. They were two tabs because the
      old panel had three; §50.5 makes them one subject, and a story opens the
      same drawer from either.
    -->
    <div
      class="if-panel"
      id="panel-stories"
      role="tabpanel"
      aria-labelledby="tab-stories"
      tabindex="0"
      hidden={current !== 'stories'}
    >
      <ProgressBlock
        {snapshot}
        {now}
        part="stories"
        onopenphase={(name) => onopendrawer({ kind: 'phase', id: name })}
        onopenstory={(id) => onopendrawer({ kind: 'story', id })}
      />
      <section class="if-card">
        <KanbanBoard
          stories={snapshot.stories}
          onopenstory={(id) => onopendrawer({ kind: 'story', id })}
        />
      </section>
    </div>
  {/if}

  <!--
    I1 for a Task, and the workspace of a free session — the same block, given
    N rows or one. Selecting a row here is what takes you from a story to the
    terminal of the agent running it (I2): the row carries the branch, and the
    shell's selection is what the terminal is keyed by.
  -->
  <div
    class="if-panel"
    id="panel-sessions"
    role="tabpanel"
    aria-labelledby="tab-sessions"
    tabindex="0"
    hidden={current !== 'sessions'}
  >
    <WorkspaceBlock
      worktrees={workspaceRows}
      title={snapshot === null ? 'Worktree e serviços' : 'Sessões e worktrees'}
      selected={worktree?.branch ?? null}
      emptyMessage={snapshot === null
        ? 'Esta sessão ainda não tem um worktree registrado.'
        : 'Nenhuma sessão aberta para esta execução.'}
      onselect={onselectworktree}
      onopenterminal={onselectworktree === null
        ? null
        : (branch) => {
            onselectworktree?.(branch);
            ontabchange('terminal');
          }}
    />
  </div>

  {#if terminal}
    <div
      class="if-panel if-panel-terminal"
      id="panel-terminal"
      role="tabpanel"
      aria-labelledby="tab-terminal"
      tabindex="0"
      hidden={current !== 'terminal'}
    >
      {#if current === 'terminal'}
        {@render terminal()}
      {/if}
    </div>
  {/if}

  {#if chat}
    <div
      class="if-panel if-panel-terminal"
      id="panel-chat"
      role="tabpanel"
      aria-labelledby="tab-chat"
      tabindex="0"
      hidden={current !== 'chat'}
    >
      {#if current === 'chat'}
        {@render chat()}
      {/if}
    </div>
  {/if}

  {#if snapshot}
    <div
      class="if-panel"
      id="panel-verification"
      role="tabpanel"
      aria-labelledby="tab-verification"
      tabindex="0"
      hidden={current !== 'verification'}
    >
      <section class="if-card">
        <h2>Verificação</h2>
        <VerificationVerdictCard verification={snapshot.verification} />
      </section>
    </div>

    <div
      class="if-panel"
      id="panel-review"
      role="tabpanel"
      aria-labelledby="tab-review"
      tabindex="0"
      hidden={current !== 'review'}
    >
      <ReviewBlock {snapshot} {pullRequests} {hasPullRequestSync} {onopencomments} />
    </div>

    <div
      class="if-panel"
      id="panel-output"
      role="tabpanel"
      aria-labelledby="tab-output"
      tabindex="0"
      hidden={current !== 'output'}
    >
      <OutputBlock
        {snapshot}
        {logFilter}
        {onlogfilterchange}
        ondiff={canDiff ? onopendiff : null}
      />
    </div>

    <div
      class="if-panel"
      id="panel-history"
      role="tabpanel"
      aria-labelledby="tab-history"
      tabindex="0"
      hidden={current !== 'history'}
    >
      <HistoryList entries={events} filter={historyFilter} onfilterchange={onhistoryfilterchange} />
    </div>
  {/if}

  <p class="if-muted if-meta">{meta}</p>
</div>

{#if drawer && snapshot}
  <ExecutionDrawer {snapshot} selection={drawer} {diagnostics} onclose={onclosedrawer} />
{/if}

<style>
  .if-panel {
    display: grid;
    gap: var(--space-16);
    align-items: start;
    min-width: 0;
  }

  /* `display: grid` above would beat the attribute without this. */
  .if-panel[hidden] {
    display: none !important;
  }

  /*
    The terminal fills what is left instead of sitting in the block flow: xterm
    measures its container, and a container sized by its contents would measure
    an empty one.
  */
  .if-panel-terminal {
    display: flex;
    flex-direction: column;
    min-height: 60vh;
  }

  .if-meta {
    margin: 0;
    font-size: var(--font-size-sm);
  }
</style>
