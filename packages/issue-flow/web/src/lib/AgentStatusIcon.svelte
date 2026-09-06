<script module lang="ts">
  /**
   * Whether the icon renders a visible mark for this status — kept beside the
   * template below so callers can avoid laying out an empty slot. Mirrors the
   * `{#if}` branches in the icon snippet.
   */
  export function agentIconVisible(status: string, unread: boolean): boolean {
    return (
      status === 'working' ||
      status === 'waiting' ||
      status === 'error' ||
      (status === 'done' && unread)
    );
  }

  /**
   * The closed vocabulary of `web/AGENTS.md`, applied to agent state.
   *
   * §50.3 merges this component with the panel's status badge, and the merge
   * rule is that the icon is the upstream's and the words are the panel's:
   * one term per concept, no loose synonyms in a badge. `idle` has no visible
   * mark, so it only ever reaches the pill form.
   */
  export const AGENT_STATUS_LABELS: Record<string, string> = {
    working: 'executando',
    waiting: 'aguardando',
    done: 'concluído',
    error: 'falhou',
    idle: 'aguardando',
  };

  export function agentStatusLabel(status: string): string {
    return AGENT_STATUS_LABELS[status] ?? AGENT_STATUS_LABELS.idle;
  }

  /**
   * The other half of §50.3's merge: an *execution*'s status, expressed in this
   * component's states.
   *
   * The panel used to draw its own badge for `idle`/`running`/`completed`/
   * `failed`. It does not any more — there is one status component, and this is
   * how the execution vocabulary reaches it. An unknown status maps to `idle`,
   * which is how the closed vocabulary stays closed (ADR-20).
   */
  export function executionStatusToAgentStatus(status: string | null | undefined): string {
    switch (status) {
      case 'running':
        return 'working';
      case 'completed':
        return 'done';
      case 'failed':
        return 'error';
      default:
        return 'idle';
    }
  }
</script>

<script lang="ts">
  /** PORT of `frontend/src/lib/AgentStatusIcon.svelte` @ d8c9d5f (143 lines). */

  let {
    status,
    size = 10,
    pill = false,
    unread = false,
  }: { status: string; size?: number; pill?: boolean; unread?: boolean } = $props();

  /**
   * One role token per state, from the Issue Flow palette.
   *
   * `working` is the `run` role and `done` the `ok` role. The upstream painted
   * both green, which is the confusion the closed vocabulary exists to prevent:
   * something still running is not something that passed. The panel already had
   * a role for exactly this (`--state-run`) and the merge adopts it.
   */
  function pillClass(s: string): string {
    if (s === 'working') return 'bg-run-surface text-run';
    if (s === 'waiting') return 'bg-warning-surface text-warning';
    if (s === 'done') return 'bg-success-surface text-success';
    if (s === 'error') return 'bg-danger-surface text-danger';
    return 'bg-hover text-muted';
  }
</script>

{#snippet icon()}
  {#if status === 'working'}
    <svg
      class="text-run working-dots"
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      role="img"
      aria-label={agentStatusLabel(status)}
      ><circle cx="3" cy="12" r="2.5" /><circle cx="12" cy="12" r="2.5" /><circle
        cx="21"
        cy="12"
        r="2.5"
      /></svg
    >
  {:else if status === 'waiting'}
    <svg
      class="text-warning"
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      role="img"
      aria-label={agentStatusLabel(status)}
      ><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path
        d="M12 7v2"
      /><path d="M12 13h.01" /></svg
    >
  {:else if status === 'done'}
    {#if unread}
      <svg
        class="text-accent"
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        stroke="none"
        role="img"
        aria-label={agentStatusLabel(status)}
        ><circle cx="12" cy="12" r="6" /></svg
      >
    {/if}
  {:else if status === 'error'}
    <svg
      class="text-danger"
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
      role="img"
      aria-label={agentStatusLabel(status)}
      ><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg
    >
  {/if}
{/snippet}

<style>
  .working-dots circle {
    transform-box: fill-box;
    transform-origin: center;
    animation: dot-wave 1.1s ease-in-out infinite;
  }
  .working-dots circle:nth-child(1) {
    animation-delay: 0s;
  }
  .working-dots circle:nth-child(2) {
    animation-delay: 0.18s;
  }
  .working-dots circle:nth-child(3) {
    animation-delay: 0.36s;
  }
  @keyframes dot-wave {
    0%,
    70%,
    100% {
      opacity: 0.25;
      transform: scale(0.8);
    }
    35% {
      opacity: 1;
      transform: scale(1.15);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .working-dots circle {
      animation: none;
      opacity: 1;
      transform: none;
    }
  }
</style>

{#if pill}
  <span class="text-xs px-2 py-0.5 rounded-xl flex items-center gap-1 {pillClass(status)}">
    {@render icon()}
    {agentStatusLabel(status)}
  </span>
{:else}
  {@render icon()}
{/if}
