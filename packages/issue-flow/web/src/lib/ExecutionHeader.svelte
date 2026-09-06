<script lang="ts">
  import AgentStatusIcon, { executionStatusToAgentStatus } from './AgentStatusIcon.svelte';
  import RefreshSelect from './RefreshSelect.svelte';
  import { formatAgo, formatDuration, parseIso } from './format';
  import type { ExecutionSnapshot } from './snapshot';
  import type { WorktreeInfo } from './types';
  import { AGENT_LIFECYCLE_LABELS } from './vocabulary';

  /**
   * The execution's header (U2).
   *
   * PORT of `renderHeader`/`renderAgentLifecycle`/`renderTimers` from
   * `web/public/app.js`, with the status badge replaced by `AgentStatusIcon`
   * (§50.3 — one status component, the panel's closed vocabulary).
   *
   * Two rules carried over verbatim:
   *
   * - **The heading is the execution, never the brand.** The product identifies
   *   itself in the document `<title>`; the most visible line on screen is for
   *   what is happening. `#N` links to the issue, the title follows it, and the
   *   issue title appears exactly once.
   * - **The side must be able to shrink.** The timers are wide, and pinned at
   *   `flex: 0 0 auto` they blow past 360px. The heading itself is inline flow,
   *   not flex, or a long title pushes `#N` onto a line of its own.
   *
   * §50.5 adds one state rather than a second header: `snapshot` may be `null`,
   * which is a **free session** — a live agent in a worktree with no run behind
   * it (§49.2, ADR-16). The same header then names the session and its branch
   * and drops the timers, because there is no execution to time. A separate
   * "session header" would have been the second interface growing back.
   */

  let {
    snapshot = null,
    worktree = null,
    monitorVersion = null,
    now,
    refreshSeconds,
    onrefreshchange,
    onback = null,
  }: {
    snapshot?: ExecutionSnapshot | null;
    worktree?: WorktreeInfo | null;
    monitorVersion?: string | null;
    now: number;
    refreshSeconds: number;
    onrefreshchange: (seconds: number) => void;
    onback?: (() => void) | null;
  } = $props();

  let hasIssue = $derived(snapshot !== null && snapshot.issue.number !== null);

  let headline = $derived(
    snapshot === null
      ? (worktree?.label ?? worktree?.branch ?? 'Sessão')
      : (snapshot.issue.title ?? (hasIssue ? 'Sem título' : 'Execução sem issue vinculada')),
  );

  let branchLine = $derived.by(() => {
    if (snapshot === null) {
      const branch = worktree?.branch ?? '';
      const agent = worktree?.agentLabel ?? worktree?.agentName ?? null;
      return agent === null ? branch : `${branch} · ${agent}`;
    }
    const branch = snapshot.git.branch;
    if (branch === null) return '';
    const base = snapshot.git.baseBranch;
    const mode =
      snapshot.git.branchCreated === false
        ? 'branch atual · não criada pelo Issue Flow'
        : snapshot.git.branchCreated === true
          ? 'criada pelo Issue Flow'
          : 'origem da branch não informada';
    return `${base === null ? branch : `${branch} ← ${base}`} · ${mode}`;
  });

  // The clock runs off `now`, which the shell ticks every second: waiting for
  // the next refresh to move the elapsed time is what made the old panel feel
  // frozen during a long phase.
  let elapsed = $derived.by(() => {
    if (snapshot === null) return worktree?.elapsed ?? '—';
    const startMs = parseIso(snapshot.startedAt);
    if (startMs === null) return '—';
    const endMs = parseIso(snapshot.endedAt);
    const end = snapshot.status === 'running' || endMs === null ? now : endMs;
    return formatDuration((end - startMs) / 1000);
  });

  let estimate = $derived(
    snapshot !== null &&
      snapshot.status === 'running' &&
      snapshot.estimatedRemainingSeconds !== null
      ? `~${formatDuration(snapshot.estimatedRemainingSeconds)} restantes (estimativa)`
      : null,
  );

  let awaitingInput = $derived(snapshot?.agent.lifecycle === 'awaiting-input');
  let escalated = $derived(snapshot !== null && snapshot.agent.awaitingInputEscalatedAt !== null);
  let heldBy = $derived(snapshot?.agent.humanHold ?? null);

  /**
   * The status the pill shows.
   *
   * A free session has no execution status, so it borrows the one the sidebar
   * already computes for its row — one status vocabulary, applied to whichever
   * of the two the header is naming (ADR-20).
   */
  let pillStatus = $derived(
    snapshot === null
      ? worktree?.agent === undefined
        ? 'idle'
        : worktree.agent
      : executionStatusToAgentStatus(snapshot.status),
  );
</script>

<header class="if-card if-header">
  <div class="if-header-main">
    {#if onback}
      <button type="button" class="if-back" onclick={onback}>← Todas as execuções</button>
    {/if}
    <h1>
      {#if hasIssue && snapshot}
        {#if snapshot.issue.url}
          <a class="if-issue-link" href={snapshot.issue.url} target="_blank" rel="noopener"
            >#{snapshot.issue.number}</a
          >
        {:else}
          <span class="if-issue-link">#{snapshot.issue.number}</span>
        {/if}
      {/if}
      <span>{headline}</span>
    </h1>
    <p class="if-header-meta">
      <span class="if-muted if-mono">{branchLine}</span>
      {#if monitorVersion}
        <span class="if-version" title="Versão do monitor que serve este painel"
          >v{monitorVersion}</span
        >
      {/if}
    </p>
  </div>

  <div class="if-header-side">
    {#if heldBy}
      <span class="if-badge if-badge-run" title="O watchdog está pausado enquanto alguém conduz"
        >em controle humano</span
      >
    {/if}
    {#if escalated && snapshot}
      <span
        class="if-badge if-badge-error"
        title={`Sem resposta ${formatAgo(snapshot.agent.awaitingInputEscalatedAt, now)}`}
        >ninguém respondeu</span
      >
    {:else if awaitingInput && snapshot}
      <span
        class="if-badge if-badge-warn"
        title={snapshot.agent.phase === null
          ? 'O agente pediu sua atenção'
          : `O agente pediu sua atenção durante a fase ${snapshot.agent.phase}`}
        >{AGENT_LIFECYCLE_LABELS['awaiting-input']}</span
      >
    {/if}
    <AgentStatusIcon pill status={pillStatus} />
    <div class="if-timers">
      <span title="Tempo decorrido">{elapsed}</span>
      {#if estimate}<span class="if-muted">{estimate}</span>{/if}
    </div>
    <RefreshSelect seconds={refreshSeconds} onchange={onrefreshchange} />
  </div>
</header>

<style>
  .if-header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--space-12);
  }

  .if-header-main {
    /* Grows, and is allowed to be the one that wraps first. */
    flex: 1 1 320px;
    min-width: 0;
    display: grid;
    gap: var(--space-4);
  }

  /*
    The side keeps the default `flex: 0 1 auto` deliberately: pinned at
    `0 0 auto` the timers overflow 360px, which is one of the three widths U20
    measures.
  */
  .if-header-side {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8);
    min-width: 0;
  }

  h1 {
    /* Inline flow, not flex: a long title must wrap around `#N`, not push it
       onto a line by itself. */
    margin: 0;
    font-size: var(--font-size-xl);
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  .if-issue-link {
    color: var(--accent);
    margin-right: var(--space-4);
  }

  .if-header-meta {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8);
    font-size: var(--font-size-sm);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .if-version {
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    padding: 0 var(--space-8);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .if-timers {
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-sm);
    min-width: 0;
  }

  .if-back {
    justify-self: start;
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .if-badge-run {
    background: var(--state-run-surface);
    color: var(--state-run);
  }

  .if-badge-warn {
    background: var(--state-warn-surface);
    color: var(--state-warn);
  }

  .if-badge-error {
    background: var(--state-error-surface);
    color: var(--state-error);
  }
</style>
