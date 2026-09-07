import { getPlanRepository, listStoredExecutions } from '../storage/db/repository.js';
import { getTelemetryContext } from './recorder.js';
import { EXECUTION_PURPOSES, type ExecutionPurpose, type ExecutionRecord } from './types.js';

export interface PhaseTiming {
  harnessExecutionMs: number | null;
  orchestrationOverheadMs: number | null;
  harnessStartupMs: number | null;
  ttftMs: number | null;
  attemptCount: number | null;
  retryDurationMs: number | null;
  cliDurationMs: number | null;
  apiDurationMs: number | null;
  numTurns: number | null;
  outputTokens: number | null;
  iteration: number | null;
}

const EMPTY_TIMING: PhaseTiming = {
  harnessExecutionMs: null,
  orchestrationOverheadMs: null,
  harnessStartupMs: null,
  ttftMs: null,
  attemptCount: null,
  retryDurationMs: null,
  cliDurationMs: null,
  apiDurationMs: null,
  numTurns: null,
  outputTokens: null,
  iteration: null,
};

function isPurpose(phase: string): phase is ExecutionPurpose {
  return (EXECUTION_PURPOSES as readonly string[]).includes(phase);
}

function sum(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === 'number');
  return known.length === 0 ? null : known.reduce((acc, value) => acc + value, 0);
}

function firstKnown(values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === 'number') return value;
  }
  return null;
}

/**
 * Distinguishes harness wall time from orchestration leftover.
 *
 * `harnessExecutionMs` is the sum of invocation `durationMs` (or cli + startup
 * when wall is missing). `orchestrationOverheadMs` is the phase wall minus that
 * sum — absent when either side was not reported, never zero-filled.
 */
export function summarizePhaseTiming(
  records: readonly ExecutionRecord[],
  phase: string,
  phaseWallMs?: number | null,
): PhaseTiming {
  if (!isPurpose(phase)) return { ...EMPTY_TIMING };

  const matched = records.filter((record) => record.purpose === phase);
  if (matched.length === 0) return { ...EMPTY_TIMING };

  const harnessExecutionMs = sum(
    matched.map((record) => {
      if (record.durationMs !== null && record.durationMs !== undefined) return record.durationMs;
      const cli = record.cliDurationMs;
      const startup = record.harnessStartupMs;
      if (cli == null && startup == null) return null;
      return (cli ?? 0) + (startup ?? 0);
    }),
  );

  const orchestrationOverheadMs =
    phaseWallMs !== null && phaseWallMs !== undefined && harnessExecutionMs !== null
      ? Math.max(0, phaseWallMs - harnessExecutionMs)
      : null;

  const retryDurationMs = sum(
    matched
      .filter(
        (record) =>
          record.trigger === 'retry' || record.trigger === 'fallback' || record.attempt > 1,
      )
      .map((record) => record.durationMs),
  );

  return {
    harnessExecutionMs,
    orchestrationOverheadMs,
    harnessStartupMs: sum(matched.map((record) => record.harnessStartupMs)),
    ttftMs: firstKnown(matched.map((record) => record.ttftMs)),
    attemptCount: matched.length,
    retryDurationMs,
    cliDurationMs: sum(matched.map((record) => record.cliDurationMs)),
    apiDurationMs: sum(matched.map((record) => record.apiDurationMs)),
    numTurns: sum(matched.map((record) => record.numTurns)),
    outputTokens: sum(matched.map((record) => record.usage?.outputTokens)),
    iteration: firstKnown(matched.map((record) => record.iteration)),
  };
}

export async function loadPhaseTiming(
  phase: string,
  phaseWallMs?: number | null,
): Promise<PhaseTiming> {
  const ctx = getTelemetryContext();
  if (ctx === null) return { ...EMPTY_TIMING };
  try {
    const repository = getPlanRepository(ctx.tasksPath);
    if (repository === undefined) return { ...EMPTY_TIMING };
    const records = await listStoredExecutions({
      projectId: repository.projectId,
      issueId: repository.issueId,
      databaseOptions: repository.databaseOptions,
    });
    return summarizePhaseTiming(records, phase, phaseWallMs);
  } catch {
    return { ...EMPTY_TIMING };
  }
}

function formatSeconds(ms: number | null): string {
  if (ms === null) return '-';
  const seconds = ms / 1000;
  if (seconds >= 10) return `${Math.round(seconds)}s`;
  if (seconds >= 1) return `${seconds.toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** One-line phase log: `task=63 phase=execute iter=3 wall=541s …`. */
export function formatPhaseLine(input: {
  issueNumber: number | string;
  phase: string;
  iteration?: number | null;
  wallMs: number | null;
  cliDurationMs: number | null;
  harnessStartupMs: number | null;
  ttftMs: number | null;
  numTurns: number | null;
  outputTokens: number | null;
}): string {
  const iter = input.iteration == null ? '-' : String(input.iteration);
  const turns = input.numTurns == null ? '-' : String(input.numTurns);
  const out = input.outputTokens == null ? '-' : String(input.outputTokens);
  return [
    `task=${input.issueNumber}`,
    `phase=${input.phase}`,
    `iter=${iter}`,
    `wall=${formatSeconds(input.wallMs)}`,
    `cli=${formatSeconds(input.cliDurationMs)}`,
    `startup=${formatSeconds(input.harnessStartupMs)}`,
    `ttft=${formatSeconds(input.ttftMs)}`,
    `turns=${turns}`,
    `out=${out}`,
  ].join(' ');
}

export function snapshotTimingFields(timing: PhaseTiming): {
  harnessExecutionMs: number | null;
  orchestrationOverheadMs: number | null;
  harnessStartupMs: number | null;
  ttftMs: number | null;
  attemptCount: number | null;
  retryDurationMs: number | null;
} {
  return {
    harnessExecutionMs: timing.harnessExecutionMs,
    orchestrationOverheadMs: timing.orchestrationOverheadMs,
    harnessStartupMs: timing.harnessStartupMs,
    ttftMs: timing.ttftMs,
    attemptCount: timing.attemptCount,
    retryDurationMs: timing.retryDurationMs,
  };
}
