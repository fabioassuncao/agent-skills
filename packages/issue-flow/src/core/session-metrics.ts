import { type ClaudeUsage, hasUsageData, sumUsage } from './metrics.js';
import { getSessionPublisher } from './session-publisher.js';
import { isoNow } from './state-manager.js';

/**
 * Publication helper for the single-invocation phases (analyze, generate, prd,
 * plan, review, pr, pr-review).
 *
 * Each of them owns its own `runHeadless` call, so the metrics are published
 * from inside the command rather than from the `instrumentedRunners` wrapper in
 * run.ts: the wrapper only sees `() => Promise<void>` and never touches the
 * HeadlessResult. Publishing here also covers standalone invocations
 * (`issue-flow prd 42`), which never go through the pipeline wrapper at all.
 */

/** Whole seconds elapsed since a `Date.now()` mark, never negative. */
export function elapsedSecondsSince(startedAtMs: number): number {
  return Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));
}

/**
 * Process-owned totals, accumulated alongside every published event.
 *
 * The session snapshot now stays populated without `--web` (`MemoryPublisher`),
 * but the end-of-run summary box still reads these process-owned counters so a
 * standalone phase command (no publisher installed) does not print zeros.
 *
 * Only phase- and iteration-scoped usage is recorded. Story metrics are a
 * rateio of an iteration already counted here — adding them would double the
 * totals, the same rule the reducer follows.
 */
interface UsageAccumulator {
  all: ClaudeUsage;
  byPhase: Map<string, ClaudeUsage>;
  byAgent: Map<string, ClaudeUsage>;
}

function createAccumulator(): UsageAccumulator {
  return { all: {}, byPhase: new Map(), byAgent: new Map() };
}

/**
 * Stack of active accumulators, innermost last.
 *
 * The bottom entry is the process total and always exists. A multi-issue run
 * pushes one accumulator per issue (and one for the whole queue) so the terminal
 * summary of issue B never inherits what issue A spent — the leak `core/CLAUDE.md`
 * warned about when it stated that the module-level counters were safe "only
 * under the current one-issue-per-process model".
 *
 * Every publication feeds **all** active accumulators, so a scope is a view of
 * the same events rather than a redirection of them.
 */
const scopes: UsageAccumulator[] = [createAccumulator()];

/** Innermost active scope: what `run` and the engine report right now. */
function current(): UsageAccumulator {
  return scopes[scopes.length - 1] as UsageAccumulator;
}

function recordRunUsage(phase: string, usage: ClaudeUsage, providerId?: string): void {
  for (const scope of scopes) {
    scope.all = sumUsage(scope.all, usage);
    scope.byPhase.set(phase, sumUsage(scope.byPhase.get(phase), usage));
    const agent = providerId ?? 'claude';
    scope.byAgent.set(agent, sumUsage(scope.byAgent.get(agent), usage));
  }
}

/** Everything the innermost active scope has spent, across all phases. */
export function getRunUsageTotals(): ClaudeUsage {
  return { ...current().all };
}

/** What a single phase has spent so far. Empty when the phase reported nothing. */
export function getPhaseUsageTotals(phase: string): ClaudeUsage {
  return { ...(current().byPhase.get(phase) ?? {}) };
}

/** A usage scope opened by {@link beginUsageScope}. */
export interface UsageScope {
  /** Everything published while this scope was open. */
  totals(): ClaudeUsage;
  /** What one phase published while this scope was open. */
  phaseTotals(phase: string): ClaudeUsage;
  /** Close the scope. Idempotent, and safe to call out of order. */
  end(): ClaudeUsage;
}

/**
 * Open a nested usage scope, for a run that processes several issues in one
 * process.
 *
 * The scope accumulates only what is published while it is open, which is what
 * lets a queue report a per-issue cost and a consolidated total from the same
 * stream of events. Closing it never discards anything: the outer scopes were
 * fed in parallel.
 */
export function beginUsageScope(): UsageScope {
  const accumulator = createAccumulator();
  scopes.push(accumulator);
  let open = true;

  return {
    totals: () => ({ ...accumulator.all }),
    phaseTotals: (phase: string) => ({ ...(accumulator.byPhase.get(phase) ?? {}) }),
    end: () => {
      if (open) {
        const index = scopes.indexOf(accumulator);
        // Never pop the process total, even if a caller double-ends a scope.
        if (index > 0) scopes.splice(index, 1);
        open = false;
      }
      return { ...accumulator.all };
    },
  };
}

/** Test seam: the counters are module state and must be cleared between runs. */
export function resetRunUsageTotals(): void {
  scopes.splice(0, scopes.length, createAccumulator());
}

/**
 * Publish one `metrics:update` event of scope `phase` for a headless
 * invocation.
 *
 * A no-op when the CLI reported no usage at all: an event with every field
 * undefined would bump the snapshot version without adding information, and the
 * reducer would leave every counter at null anyway.
 *
 * A command with more than one invocation (the retrying phases, or `review`
 * inside a correction cycle) calls this once per invocation — the reducer's
 * summing is what turns them into the phase total.
 *
 * Never throws and never returns a value: publishing metrics must not be able
 * to change a command's exit code.
 */
export function publishPhaseMetrics(
  phase: string,
  usage: ClaudeUsage | null | undefined,
  startedAtMs?: number,
  providerId?: string,
): void {
  if (usage == null || !hasUsageData(usage)) return;

  recordRunUsage(phase, usage, providerId);

  getSessionPublisher().publish({
    type: 'metrics:update',
    at: isoNow(),
    scope: 'phase',
    phase,
    ...usage,
    // Informational only: a phase's durationSeconds keeps coming exclusively
    // from phase:start/phase:end, so the reducer ignores this for scope 'phase'.
    durationSeconds: startedAtMs === undefined ? undefined : elapsedSecondsSince(startedAtMs),
  });
}

/** The execute loop is the only producer of iteration- and story-scoped metrics. */
export const EXECUTE_PHASE = 'execute';

/**
 * Publish one `metrics:update` event of scope `iteration` for a pass of the
 * execute loop.
 *
 * Lands on the `execute` phase and on the issue-wide aggregate, exactly like a
 * phase-scoped event: an iteration *is* a slice of the execute phase. Failed
 * iterations (transient or fatal) publish too — those tokens were spent.
 *
 * A no-op when the CLI reported no usage. Never throws.
 */
export function publishIterationMetrics(
  iteration: number,
  usage: ClaudeUsage | null | undefined,
  durationSeconds?: number,
  providerId?: string,
): void {
  if (usage == null || !hasUsageData(usage)) return;

  recordRunUsage(EXECUTE_PHASE, usage, providerId);

  getSessionPublisher().publish({
    type: 'metrics:update',
    at: isoNow(),
    scope: 'iteration',
    phase: EXECUTE_PHASE,
    iteration,
    ...usage,
    // Informational only: the reducer keeps a phase's durationSeconds coming
    // exclusively from phase:start/phase:end.
    durationSeconds,
  });
}

/**
 * Publish one `metrics:update` event of scope `story`.
 *
 * The values are the rateio of the iteration that completed the story, so the
 * reducer deliberately keeps them off the phase and the aggregate — the
 * iteration event of the same cycle already counted them there.
 *
 * A no-op when there is neither usage nor a duration to report. Never throws.
 */
export function publishStoryMetrics(
  storyId: string,
  usage: ClaudeUsage | null | undefined,
  durationSeconds?: number,
): void {
  if (!hasUsageData(usage) && durationSeconds === undefined) return;

  getSessionPublisher().publish({
    type: 'metrics:update',
    at: isoNow(),
    scope: 'story',
    storyId,
    ...(usage ?? {}),
    durationSeconds,
  });
}
