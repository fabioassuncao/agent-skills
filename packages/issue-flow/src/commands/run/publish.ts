import type { SessionPublisher } from '../../core/session-state.js';
import { isoNow } from '../../core/state-manager.js';
import { isVerbose } from '../../core/verbose.js';
import type { Issue } from '../../issues/types.js';
import { formatPhaseLine, loadPhaseTiming, snapshotTimingFields } from '../../telemetry/timing.js';
import type { UserStory } from '../../types.js';
import { printInfo } from '../../ui/logger.js';

/**
 * Numeric form of an identifier, or `null` when the origin uses a non-numeric
 * one. Published as-is in session.json: a local id like 'auth-refactor' has no
 * number, and reporting it as 0 would claim an Issue that does not exist.
 */
export function toIssueNumber(id: string): number | null {
  const parsed = Number.parseInt(id, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function publishInstrumentedPhaseEnd(
  publisher: SessionPublisher,
  phase: string,
  issueNumber: string,
  success: boolean,
  error?: string,
): Promise<void> {
  const at = isoNow();
  const startedAt = publisher.snapshot().phases.find((entry) => entry.name === phase)?.startedAt;
  const wallMs =
    startedAt === null || startedAt === undefined
      ? null
      : Math.max(0, Date.parse(at) - Date.parse(startedAt));
  const timing = await loadPhaseTiming(phase, wallMs);
  publisher.publish({
    type: 'phase:end',
    at,
    phase,
    success,
    ...(error === undefined ? {} : { error }),
    ...snapshotTimingFields(timing),
  });
  if (isVerbose()) {
    printInfo(
      formatPhaseLine({
        issueNumber: toIssueNumber(issueNumber) ?? issueNumber,
        phase,
        iteration: timing.iteration,
        wallMs,
        cliDurationMs: timing.cliDurationMs,
        harnessStartupMs: timing.harnessStartupMs,
        ttftMs: timing.ttftMs,
        numTurns: timing.numTurns,
        outputTokens: timing.outputTokens,
      }),
    );
  }
}

/**
 * Seed the snapshot with the stories a `tasks.json` already holds on disk, so
 * the monitor shows the plan instead of "no user story yet" until the first
 * execute iteration republishes them.
 *
 * Must be called **after** `session:start`, which resets the snapshot through
 * `createInitialSnapshot()`. An empty plan publishes nothing: the event would
 * bump the publisher's version without adding any content.
 *
 * Returns whether anything was published.
 */
export function publishStorySeed(
  publisher: SessionPublisher,
  stories: readonly UserStory[],
  at: string,
): boolean {
  if (stories.length === 0) return false;
  publisher.publish({ type: 'stories:update', at, stories: [...stories] });
  return true;
}

/**
 * Publish the Issue's structural data (title, description, labels, state) so
 * the panel shows what is being implemented without a detour through GitHub.
 *
 * Same window as the story seed: right after `session:start`, which resets the
 * snapshot. The data comes from the `ResolvedIssue` the run already holds — no
 * extra provider call — and the description goes out whole, untruncated.
 */
export function publishIssueDetails(publisher: SessionPublisher, issue: Issue, at: string): void {
  publisher.publish({
    type: 'issue:update',
    at,
    number: issue.number,
    // Left undefined (rather than null) when the origin has no remote, so the
    // reducer keeps whatever URL session:start already published.
    url: issue.remoteRef ?? undefined,
    title: issue.title,
    description: issue.body,
    labels: issue.labels,
    state: issue.state,
  });
}
