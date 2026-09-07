import type { AgentLifecycle } from '../agents/hooks/contract.js';

/**
 * When an autonomous run is over, and what happens then.
 *
 * Ported from WebMux's `backend/src/services/oneshot-watcher-service.ts`
 * @ d8c9d5f (159 LOC) as part of the convergence §17 asks for: `issue-flow run`
 * absorbs the three things `webmux oneshot` had and it did not — a free prompt
 * as an entry, the agent's own end-of-work signals as *additional* evidence of
 * completion, and an optional close of what the run left open — **without**
 * becoming a second command with fewer guarantees.
 *
 * Three things are kept from the upstream exactly as they are, because each of
 * them is there for a case that is easy to miss:
 *
 * 1. **The grace window.** `idle` is transient — an agent between two tool
 *    calls is idle — so an idle reading only counts once it has held for
 *    {@link IDLE_GRACE_MS}. A terminal signal does not wait.
 * 2. **The cold-start guard.** "No event at all" is *also* what a run looks
 *    like a second after it started, before the first hook fires. Upstream
 *    treats its equivalent (`closed`) like `idle` rather than like `stopped`
 *    for exactly this reason: firing on it would close a session that had not
 *    begun. A run that is genuinely over stays silent past the grace; a cold
 *    start resolves to `running` well before it.
 * 3. **The re-read before closing.** Whatever runs between deciding and
 *    closing takes time, and a person taking over during that window must
 *    abort the close. Upstream's window was an implicit Linear round-trip;
 *    the restored Linear integration keeps posting explicit and outside run
 *    completion. The window here is the run's own finalization — the
 *    closure of the issue, the summary — and the race is the same one.
 *
 * The disarm is not reimplemented: a `human:hold` **is** the "the human took
 * over, stand down" of §32, and `core/human-hold.ts` already owns it. This
 * module only asks.
 */

/**
 * How long a run has to look finished before it is treated as finished.
 *
 * The upstream number, unchanged. It is a compromise between closing a session
 * a person was about to use and leaving a finished one open for minutes.
 */
export const IDLE_GRACE_MS = 15_000;

/** What the pipeline itself decided, when it has decided. */
export type RunPipelineOutcome = 'completed' | 'failed';

/** One run this pass is responsible for. */
export interface RunCompletionTarget {
  runId: string;
  /** Issue the run is about. Used only to name the run in a log line. */
  issueId: string | null;
  /**
   * Verdict of the pipeline, or `null` while it is still going.
   *
   * This is the Issue Flow half of §17's convergence and it stays
   * authoritative: the agent's own signals never shorten a pipeline, never
   * skip `review` and never turn an unverified run into a finished one.
   */
  pipelineOutcome: RunPipelineOutcome | null;
  /**
   * Last lifecycle the agent's own hooks reported, or `null` when none has
   * arrived. `null` is the cold start, and it waits out the grace.
   */
  lifecycle: AgentLifecycle | null;
  /** Whether a `pr_opened` event was seen for this run. */
  hasPr: boolean;
}

export interface RunCompletionDeps {
  targets: readonly RunCompletionTarget[];
  /**
   * Whether the run is still autonomous.
   *
   * False once a person took over (`human:hold`) — the disarm of §32 — or once
   * a previous pass already settled it. Read twice: before deciding and again
   * immediately before closing.
   */
  isArmed: (runId: string) => Promise<boolean>;
  /** Close what the run left open. Only called when `autoClose` is on. */
  closeRun: (runId: string) => Promise<void>;
  /** Stand the run down so a later pass does not settle it twice. */
  disarm: (runId: string) => Promise<void>;
  /** `--auto-close`, or the project's `run.autoClose`. */
  autoClose: boolean;
  /** Override for tests. Defaults to {@link IDLE_GRACE_MS}. */
  idleGraceMs?: number;
  /** Override for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Diagnostics sink. Silent by default. */
  log?: (message: string) => void;
}

interface WatchState {
  idleSinceMs: number | null;
  inFlight: boolean;
}

const states = new Map<string, WatchState>();

function getState(runId: string): WatchState {
  let state = states.get(runId);
  if (state === undefined) {
    state = { idleSinceMs: null, inFlight: false };
    states.set(runId, state);
  }
  return state;
}

/** Test/reset helper — clears the per-run idle timer state. */
export function resetRunCompletionState(): void {
  states.clear();
}

function describe(target: RunCompletionTarget): string {
  return target.issueId === null ? `run ${target.runId}` : `issue #${target.issueId}`;
}

/** Why the run is being treated as finished, for the log line. */
function completionReason(target: RunCompletionTarget): string {
  if (target.pipelineOutcome !== null) return `pipeline ${target.pipelineOutcome}`;
  if (target.lifecycle === 'stopped') return 'agent stopped';
  if (target.lifecycle === null) return 'agent never reported in';
  return target.hasPr ? 'agent idle after opening a PR' : 'agent idle without opening a PR';
}

/**
 * Settle one run.
 *
 * Ported from `processWorktree`. Never throws: a run whose close fails is
 * still disarmed, exactly as upstream does it, because leaving it armed would
 * have the next pass try the same failing close forever.
 */
export async function settleRun(
  target: RunCompletionTarget,
  deps: RunCompletionDeps,
): Promise<boolean> {
  const idleGrace = deps.idleGraceMs ?? IDLE_GRACE_MS;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((): void => {});

  if (!(await deps.isArmed(target.runId))) {
    // Disarmed (or never armed) — drop any tracked state and skip. A person is
    // in control of this run, and nothing automatic touches it.
    states.delete(target.runId);
    return false;
  }

  const state = getState(target.runId);
  if (state.inFlight) return false;

  // The pipeline's own verdict and an explicit `agent_stopped` are terminal:
  // neither can turn back into work in progress. `idle` and "nothing reported
  // yet" are ambiguous — the first is an agent between tool calls, the second
  // is also every run in its first seconds — so both wait out the grace.
  const isTerminal = target.pipelineOutcome !== null || target.lifecycle === 'stopped';
  const needsGrace = target.lifecycle === 'idle' || target.lifecycle === null;
  if (!isTerminal && !needsGrace) {
    state.idleSinceMs = null;
    return false;
  }
  if (state.idleSinceMs === null) state.idleSinceMs = now();
  const stable = isTerminal || now() - state.idleSinceMs >= idleGrace;
  if (!stable) return false;

  state.inFlight = true;
  try {
    log(`[run-completion] ${describe(target)}: ${completionReason(target)} — settling the run`);

    if (deps.autoClose) {
      // Re-read immediately before closing: finalizing the run takes time, and
      // a person taking over during that window must abort the close.
      if (!(await deps.isArmed(target.runId))) {
        log(`[run-completion] ${describe(target)}: a person took over — skipping the close`);
        return false;
      }
      try {
        await deps.closeRun(target.runId);
        log(`[run-completion] ${describe(target)}: closed the run's sessions`);
      } catch (error) {
        log(
          `[run-completion] ${describe(target)}: close failed — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Disarm even when the close failed, so nothing re-triggers on the next
    // pass. A person reopening the run by hand would disarm it anyway; the
    // explicit clear here removes the race.
    await deps.disarm(target.runId);
    return true;
  } finally {
    states.delete(target.runId);
  }
}

/**
 * One pass over every run this invocation is responsible for.
 *
 * Ported from `runOneshotWatch`. Deliberately **not** gated on anyone
 * watching: a headless run produces no dashboard traffic and is exactly the
 * case that needs settling.
 *
 * Returns how many runs were settled.
 */
export async function runCompletionPass(deps: RunCompletionDeps): Promise<number> {
  let settled = 0;
  for (const target of deps.targets) {
    if (await settleRun(target, deps)) settled += 1;
  }
  return settled;
}

/**
 * Read the agent's own end-of-work signals out of its lifecycle events.
 *
 * §17 absorbs `agent_stopped` and `pr_opened` as *additional* evidence that
 * the work is over. Additional is the operative word: they inform the close,
 * never the pipeline, because a run that ended its phases early on the
 * agent's own say-so would be a run nobody verified (§45.3).
 */
export function deriveRunSignals(events: readonly { type: string; lifecycle: string | null }[]): {
  lifecycle: AgentLifecycle | null;
  hasPr: boolean;
} {
  let lifecycle: AgentLifecycle | null = null;
  let hasPr = false;
  for (const event of events) {
    if (event.type === 'pr_opened') hasPr = true;
    if (event.type === 'agent_stopped') lifecycle = 'stopped';
    if (event.type === 'agent_status_changed' && isLifecycle(event.lifecycle)) {
      lifecycle = event.lifecycle;
    }
  }
  return { lifecycle, hasPr };
}

function isLifecycle(value: string | null): value is AgentLifecycle {
  return value === 'starting' || value === 'running' || value === 'idle' || value === 'stopped';
}
