import { ghBounded } from './client.js';
import type { CiCheck, CiStatus, GhCheckEntry } from './types.js';

/**
 * CI check rollup — summarising, deduping and typing `statusCheckRollup`, plus
 * reading the failed-step log of a GitHub Actions run.
 *
 * Ported from WebMux `backend/src/services/pr-service.ts` @ d8c9d5f (the check
 * helpers) and `backend/src/server.ts:1769` (`gh run view --log-failed`). The
 * Issue Flow had no CI reading at all, so this is `PORT`, not `MERGE`: the
 * dedupe rule and the cancelled-run handling below are the whole reason the
 * upstream dashboard does not report a re-triggered PR as permanently failed.
 */

/** Group key for an entry: check-run name, or external status context. */
function checkEntryKey(check: GhCheckEntry): string {
  return check.__typename === 'StatusContext' ? `status:${check.context}` : `check:${check.name}`;
}

/** Parse an ISO timestamp to epoch ms, 0 when absent or invalid. */
function toEpoch(timestamp: string | null | undefined): number {
  const value = timestamp ? new Date(timestamp).getTime() : Number.NaN;
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Recency of an entry (epoch ms) for latest-wins dedupe. For a check run, use
 * the later of startedAt/completedAt: GitHub reports completedAt as a zero
 * sentinel ("0001-01-01T00:00:00Z") while still running, so a live run would
 * otherwise sort as ancient and lose to an older completed run.
 */
function checkEntryTime(check: GhCheckEntry): number {
  if (check.__typename === 'StatusContext') return toEpoch(check.createdAt);
  return Math.max(toEpoch(check.startedAt), toEpoch(check.completedAt));
}

/** A CANCELLED check-run is a superseded/aborted run, not a failing verdict. */
function isCancelled(check: GhCheckEntry): boolean {
  return check.__typename === 'CheckRun' && check.conclusion === 'CANCELLED';
}

/**
 * Collapse the rollup to the most recent entry per check name / status context.
 * Re-triggering a workflow leaves the prior run in the rollup under the same
 * name; keeping only the latest lets the fresh result win instead of a stale
 * run masking it. Latest wins by completion time, falling back to array order
 * (GitHub returns oldest-first) on ties.
 */
export function dedupeLatestChecks(checks: readonly GhCheckEntry[]): GhCheckEntry[] {
  const latest = new Map<string, GhCheckEntry>();
  for (const check of checks) {
    const key = checkEntryKey(check);
    const previous = latest.get(key);
    if (!previous || checkEntryTime(check) >= checkEntryTime(previous)) {
      latest.set(key, check);
    }
  }
  return [...latest.values()];
}

/**
 * Summarize CI check status from a `statusCheckRollup` array.
 *
 * CANCELLED runs are dropped: a review workflow cancelled when a re-run
 * re-triggers it (concurrency cancel-in-progress) reports CANCELLED, which must
 * not mask the latest run — otherwise the Pull Request stays "failed" forever.
 * The dedupe above is what makes a same-name re-run's fresh result win over the
 * superseded one.
 */
export function summarizeChecks(checks: readonly GhCheckEntry[] | null): CiStatus {
  if (!checks || checks.length === 0) return 'none';
  const relevant = dedupeLatestChecks(checks).filter((check) => !isCancelled(check));
  if (relevant.length === 0) return 'none';

  const allDone = relevant.every((check) =>
    check.__typename === 'StatusContext'
      ? check.state !== 'PENDING' && check.state !== 'EXPECTED'
      : check.status === 'COMPLETED',
  );
  if (!allDone) return 'pending';

  const allPass = relevant.every((check) => {
    if (check.__typename === 'StatusContext') return check.state === 'SUCCESS';
    return (
      check.conclusion === 'SUCCESS' ||
      check.conclusion === 'NEUTRAL' ||
      check.conclusion === 'SKIPPED'
    );
  });
  return allPass ? 'success' : 'failed';
}

/** Parse a GitHub Actions run id from a details URL. Returns null when absent. */
export function parseRunId(detailsUrl: string | null): number | null {
  if (!detailsUrl) return null;
  const match = detailsUrl.match(/\/actions\/runs\/(\d+)/);
  return match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
}

/** Derive a typed check status from the GH conclusion / status fields. */
export function deriveCheckStatus(check: GhCheckEntry): CiCheck['status'] {
  if (check.__typename === 'StatusContext') {
    const state = check.state;
    if (state === 'SUCCESS') return 'success';
    if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
    return 'failed';
  }
  if (check.status !== 'COMPLETED') return 'pending';
  const conclusion = check.conclusion;
  if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL') return 'success';
  // CANCELLED = superseded (a run re-triggered by a review command); not a failure.
  if (conclusion === 'SKIPPED' || conclusion === 'CANCELLED') return 'skipped';
  return 'failed';
}

/** Map raw GH check entries to the typed `CiCheck` array. */
export function mapChecks(checks: readonly GhCheckEntry[] | null): CiCheck[] {
  if (!checks || checks.length === 0) return [];
  return dedupeLatestChecks(checks).map((check) => {
    const name = check.__typename === 'StatusContext' ? check.context : check.name;
    const url = check.__typename === 'StatusContext' ? check.targetUrl : check.detailsUrl;
    return { name, status: deriveCheckStatus(check), url, runId: parseRunId(url) };
  });
}

/** Outcome of reading a failed run's log. Never throws. */
export type FailedRunLog = { ok: true; log: string } | { ok: false; error: string };

export interface FetchFailedRunLogOptions {
  /** `owner/repo` of a linked repository; omitted reads the current one. */
  repo?: string;
  cwd?: string;
}

/**
 * Read the failed steps of a GitHub Actions run (`gh run view <id>
 * --log-failed`).
 *
 * The Issue Flow had no equivalent: a failing check surfaced as a status with
 * no way to see why. Returns a Result rather than throwing, because a log that
 * cannot be read is information for the caller, never a reason to fail a phase.
 */
export async function fetchFailedRunLog(
  runId: number,
  options: FetchFailedRunLogOptions = {},
): Promise<FailedRunLog> {
  const args = ['run', 'view', String(runId), '--log-failed'];
  if (options.repo !== undefined) args.push('--repo', options.repo);

  const result = await ghBounded(args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim();
    return {
      ok: false,
      error: `gh run view failed for run ${runId}: ${reason || 'unknown error'}`,
    };
  }
  return { ok: true, log: result.stdout };
}
