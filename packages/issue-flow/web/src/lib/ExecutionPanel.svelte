<script lang="ts">
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
  import type { HistoryFilter, JournalEntryView, LogFilter } from './executions';
  import { formatClock } from './format';
  import type { ExecutionSnapshot } from './snapshot';
  import type { EffectiveConfigResponse } from './types';

  /**
   * One execution, in full.
   *
   * PORT of `#view-detail`: the header, the alert card, the three tabs and the
   * four blocks of the "Execução" tab, in the order the question arrives —
   * what is happening now, about what, how far it got, and what came out.
   *
   * **The three panels are always rendered.** Not switched: rendered. An
   * inactive tab must never be stale, and the drawer only stays current across
   * refreshes because it is rehydrated on every update rather than frozen when
   * it opened.
   *
   * `[hidden]` needs `display: none` stated explicitly — the panel's own
   * `display: grid` would otherwise win over the attribute.
   */

  const TABS: readonly TabDefinition[] = [
    { id: 'execution', label: 'Execução' },
    { id: 'kanban', label: 'Kanban' },
    { id: 'history', label: 'Histórico' },
  ];

  let {
    snapshot,
    now,
    events,
    diagnostics,
    config = null,
    monitorVersion = null,
    canEditPreferences = false,
    refreshSeconds,
    activeTab,
    logFilter,
    historyFilter,
    drawer,
    canDiff = false,
    onrefreshchange,
    ontabchange,
    onlogfilterchange,
    onhistoryfilterchange,
    onopendrawer,
    onclosedrawer,
    onopensettings,
    onopendiff = null,
    onback = null,
  }: {
    snapshot: ExecutionSnapshot;
    now: number;
    events: readonly JournalEntryView[];
    diagnostics: readonly Record<string, unknown>[];
    config?: EffectiveConfigResponse | null;
    monitorVersion?: string | null;
    canEditPreferences?: boolean;
    refreshSeconds: number;
    activeTab: string;
    logFilter: LogFilter;
    historyFilter: HistoryFilter;
    drawer: DrawerSelection | null;
    canDiff?: boolean;
    onrefreshchange: (seconds: number) => void;
    ontabchange: (id: string) => void;
    onlogfilterchange: (filter: LogFilter) => void;
    onhistoryfilterchange: (filter: HistoryFilter) => void;
    onopendrawer: (selection: DrawerSelection) => void;
    onclosedrawer: () => void;
    onopensettings: () => void;
    onopendiff?: (() => void) | null;
    onback?: (() => void) | null;
  } = $props();

  let meta = $derived.by(() => {
    const parts: string[] = [];
    if (snapshot.sessionId) parts.push(`execução ${snapshot.sessionId}`);
    if (snapshot.updatedAt) parts.push(`atualizado ${formatClock(snapshot.updatedAt)}`);
    parts.push('somente leitura');
    return parts.join(' · ');
  });
</script>

<div class="if-surface">
  <ExecutionHeader
    {snapshot}
    {monitorVersion}
    {now}
    {refreshSeconds}
    {onrefreshchange}
    {onback}
  />

  <ExecutionAlerts {snapshot} {now} />

  <ExecutionTabs tabs={TABS} active={activeTab} onselect={ontabchange} />

  <div
    class="if-panel if-two-column"
    id="panel-execution"
    role="tabpanel"
    aria-labelledby="tab-execution"
    tabindex="0"
    hidden={activeTab !== 'execution'}
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
      onopenphase={(name) => onopendrawer({ kind: 'phase', id: name })}
      onopenstory={(id) => onopendrawer({ kind: 'story', id })}
    />
    <OutputBlock
      {snapshot}
      {logFilter}
      {onlogfilterchange}
      ondiff={canDiff ? onopendiff : null}
    />
  </div>

  <div
    class="if-panel"
    id="panel-kanban"
    role="tabpanel"
    aria-labelledby="tab-kanban"
    tabindex="0"
    hidden={activeTab !== 'kanban'}
  >
    <section class="if-card">
      <KanbanBoard
        stories={snapshot.stories}
        onopenstory={(id) => onopendrawer({ kind: 'story', id })}
      />
    </section>
  </div>

  <div
    class="if-panel"
    id="panel-history"
    role="tabpanel"
    aria-labelledby="tab-history"
    tabindex="0"
    hidden={activeTab !== 'history'}
  >
    <HistoryList entries={events} filter={historyFilter} onfilterchange={onhistoryfilterchange} />
  </div>

  <p class="if-muted if-meta">{meta}</p>
</div>

{#if drawer}
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

  .if-meta {
    margin: 0;
    font-size: var(--font-size-sm);
  }
</style>
