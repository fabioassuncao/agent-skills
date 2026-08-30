import {
  createInitialSnapshot,
  reduceSessionEvent,
  type SessionEvent,
} from '../core/session-state.js';
import { sessionSnapshotSchema } from '../schemas.js';
import { summarizePhaseTiming } from '../telemetry/timing.js';
import type { ExecutionRecord } from '../telemetry/types.js';
import { CORPUS } from './corpus.js';
import { p50, p95 } from './stats.js';

export { p50, p95 };

/** Derived from the #79 investigation: orchestration must stay a rounding error. */
export const SYNTHETIC_BUDGETS = {
  /** p95 of reducing a short scripted run, in milliseconds. */
  reduceP95Ms: 50,
  /** p95 of parsing a snapshot through the lockstep schema. */
  parseP95Ms: 20,
} as const;

export interface SyntheticResult {
  task: string;
  mode: 'synthetic';
  harness: 'mocked';
  model: 'none';
  effort: 'none';
  verification: string;
  strategy: string;
  taskDurationMs: number;
  harnessExecutionDurationMs: number;
  orchestrationOverheadMs: number;
  timeToFirstOutputMs: number | null;
  attemptCount: number;
  retryDurationMs: number;
  verdict: 'unverified';
}

function scriptedEvents(): SessionEvent[] {
  return [
    {
      type: 'session:start',
      at: '2026-08-30T03:00:00.000Z',
      sessionId: 'bench',
      issueNumber: 79,
      phases: ['prd', 'execute'],
    },
    { type: 'phase:start', at: '2026-08-30T03:00:01.000Z', phase: 'prd' },
    {
      type: 'phase:end',
      at: '2026-08-30T03:00:02.000Z',
      phase: 'prd',
      success: true,
      harnessExecutionMs: 800,
      orchestrationOverheadMs: 200,
    },
    { type: 'phase:start', at: '2026-08-30T03:00:02.000Z', phase: 'execute' },
    {
      type: 'phase:end',
      at: '2026-08-30T03:00:03.000Z',
      phase: 'execute',
      success: true,
      harnessExecutionMs: 900,
      orchestrationOverheadMs: 100,
      attemptCount: 1,
    },
    { type: 'session:end', at: '2026-08-30T03:00:03.000Z', status: 'completed' },
  ];
}

export function reduceScriptedRun(): ReturnType<typeof reduceSessionEvent> {
  let snap = createInitialSnapshot();
  for (const event of scriptedEvents()) {
    snap = reduceSessionEvent(snap, event);
  }
  return snap;
}

export function timeReduce(repeats = 20): number[] {
  const samples: number[] = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    reduceScriptedRun();
    samples.push(performance.now() - start);
  }
  return samples;
}

export function timeParse(repeats = 20): number[] {
  const snap = reduceScriptedRun();
  const samples: number[] = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    sessionSnapshotSchema.parse(snap);
    samples.push(performance.now() - start);
  }
  return samples;
}

function mockedRecord(durationMs: number): ExecutionRecord {
  return {
    id: 'synthetic',
    sessionId: 'bench',
    purpose: 'execute',
    attempt: 1,
    trigger: 'initial',
    triggerReason: null,
    agent: {
      harness: 'mocked',
      provider: null,
      model: { requested: null, resolved: null, source: 'unavailable' },
      providerSessionId: null,
    },
    startedAt: '2026-08-30T03:00:00.000Z',
    finishedAt: '2026-08-30T03:00:01.000Z',
    durationMs,
    cliDurationMs: Math.max(0, durationMs - 5),
    harnessStartupMs: 5,
    ttftMs: null,
    usage: { source: 'unavailable' },
    cost: { status: 'unknown', reason: 'not_reported' },
    status: 'completed',
    failure: null,
  };
}

/** Orchestration-only measurement: the harness is a number, not a process. */
export function runSyntheticCorpus(): SyntheticResult[] {
  return CORPUS.map((task) => {
    const harnessMs = 1000;
    const orchestrateStart = performance.now();
    const snap = reduceScriptedRun();
    sessionSnapshotSchema.parse(snap);
    const orchestrationMs = performance.now() - orchestrateStart;
    const timing = summarizePhaseTiming(
      [mockedRecord(harnessMs)],
      'execute',
      harnessMs + orchestrationMs,
    );
    return {
      task: task.id,
      mode: 'synthetic',
      harness: 'mocked',
      model: 'none',
      effort: 'none',
      verification: task.verification,
      strategy: task.strategy,
      taskDurationMs: harnessMs + orchestrationMs,
      harnessExecutionDurationMs: timing.harnessExecutionMs ?? harnessMs,
      orchestrationOverheadMs: timing.orchestrationOverheadMs ?? orchestrationMs,
      timeToFirstOutputMs: timing.ttftMs,
      attemptCount: timing.attemptCount ?? 1,
      retryDurationMs: timing.retryDurationMs ?? 0, // no retries in the mocked record
      verdict: 'unverified',
    };
  });
}
