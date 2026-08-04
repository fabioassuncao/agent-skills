import { type ClaudeUsage, hasUsageData } from './metrics.js';
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
function elapsedSecondsSince(startedAtMs: number): number {
  return Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));
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
): void {
  if (usage == null || !hasUsageData(usage)) return;

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
