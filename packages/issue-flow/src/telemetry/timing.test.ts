import { describe, expect, it } from 'vitest';
import { formatPhaseLine, summarizePhaseTiming } from './timing.js';
import type { ExecutionRecord } from './types.js';

function record(overrides: Partial<ExecutionRecord>): ExecutionRecord {
  return {
    id: 'e1',
    sessionId: 's1',
    purpose: 'execute',
    attempt: 1,
    trigger: 'initial',
    triggerReason: null,
    agent: {
      harness: 'claude-code',
      provider: 'anthropic',
      model: { requested: null, resolved: null, source: 'unavailable' },
      providerSessionId: null,
    },
    startedAt: '2026-08-30T00:00:00.000Z',
    finishedAt: '2026-08-30T00:09:01.000Z',
    durationMs: 541_000,
    cliDurationMs: 498_000,
    harnessStartupMs: 3600,
    ttftMs: 2100,
    numTurns: 37,
    usage: { source: 'provider', outputTokens: 34_160 },
    cost: { status: 'unknown', reason: 'not_reported' },
    status: 'completed',
    failure: null,
    ...overrides,
  };
}

describe('summarizePhaseTiming', () => {
  it('separates harness wall from orchestration leftover', () => {
    const timing = summarizePhaseTiming([record({})], 'execute', 550_000);
    expect(timing.harnessExecutionMs).toBe(541_000);
    expect(timing.orchestrationOverheadMs).toBe(9000);
    expect(timing.harnessStartupMs).toBe(3600);
    expect(timing.ttftMs).toBe(2100);
    expect(timing.attemptCount).toBe(1);
    expect(timing.retryDurationMs).toBeNull();
    expect(timing.cliDurationMs).toBe(498_000);
    expect(timing.numTurns).toBe(37);
    expect(timing.outputTokens).toBe(34_160);
  });

  it('records attemptCount and retryDuration without zero-filling absences', () => {
    const timing = summarizePhaseTiming(
      [
        record({ id: 'a', attempt: 1, durationMs: 10_000 }),
        record({
          id: 'b',
          attempt: 2,
          trigger: 'retry',
          durationMs: 4000,
          cliDurationMs: null,
          harnessStartupMs: null,
          ttftMs: null,
          numTurns: null,
          usage: { source: 'provider' },
        }),
      ],
      'execute',
      20_000,
    );
    expect(timing.attemptCount).toBe(2);
    expect(timing.retryDurationMs).toBe(4000);
    expect(timing.harnessExecutionMs).toBe(14_000);
    expect(timing.orchestrationOverheadMs).toBe(6000);
  });

  it('leaves overhead unreported when the phase wall is unknown', () => {
    const timing = summarizePhaseTiming([record({})], 'execute');
    expect(timing.harnessExecutionMs).toBe(541_000);
    expect(timing.orchestrationOverheadMs).toBeNull();
  });

  it('does not invent timing for a phase with no invocations', () => {
    expect(summarizePhaseTiming([], 'execute', 1000)).toEqual(
      summarizePhaseTiming([record({})], 'init', 1000),
    );
    expect(summarizePhaseTiming([], 'execute').harnessExecutionMs).toBeNull();
    expect(summarizePhaseTiming([], 'execute').attemptCount).toBeNull();
  });
});

describe('formatPhaseLine', () => {
  it('matches the documented one-line shape', () => {
    expect(
      formatPhaseLine({
        issueNumber: 63,
        phase: 'execute',
        iteration: 3,
        wallMs: 541_000,
        cliDurationMs: 498_000,
        harnessStartupMs: 3600,
        ttftMs: 2100,
        numTurns: 37,
        outputTokens: 34_160,
      }),
    ).toBe(
      'task=63 phase=execute iter=3 wall=541s cli=498s startup=3.6s ttft=2.1s turns=37 out=34160',
    );
  });

  it('prints a dash for fields the harness did not report', () => {
    expect(
      formatPhaseLine({
        issueNumber: 63,
        phase: 'prd',
        wallMs: 304_000,
        cliDurationMs: null,
        harnessStartupMs: null,
        ttftMs: null,
        numTurns: null,
        outputTokens: 26_424,
      }),
    ).toBe('task=63 phase=prd iter=- wall=304s cli=- startup=- ttft=- turns=- out=26424');
  });
});
