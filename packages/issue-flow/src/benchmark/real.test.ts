import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { CostRecord, ExecutionRecord } from '../telemetry/types.js';
import { type RepeatOutcome, runRealCorpus, summarizeCell } from './real.js';

function record(id: string, cost: CostRecord): ExecutionRecord {
  return {
    id,
    sessionId: 'bench',
    purpose: 'execute',
    attempt: 1,
    trigger: 'initial',
    triggerReason: null,
    agent: {
      harness: 'mocked',
      provider: 'claude',
      providerSessionId: null,
      model: { requested: null, resolved: null, source: 'unavailable' },
    },
    startedAt: '2026-08-30T00:00:00.000Z',
    finishedAt: '2026-08-30T00:00:01.000Z',
    durationMs: 1000,
    usage: { source: 'unavailable' },
    cost,
    status: 'completed',
    failure: null,
  };
}

function outcome(overrides: Partial<RepeatOutcome> = {}): RepeatOutcome {
  return {
    records: [record('exec-1', { status: 'reported', amount: 1.5, currency: 'USD' })],
    verdict: 'passed',
    taskDurationMs: 1200,
    harnessExecutionMs: 1000,
    orchestrationOverheadMs: 200,
    attemptCount: 1,
    cost: { status: 'reported', amount: 1.5, currency: 'USD' },
    ...overrides,
  };
}

const tupleBase = {
  harness: 'claude',
  harnessVersion: '2.1.251',
  model: 'sonnet',
  modelVersion: null,
  effort: 'default',
  verification: 'existing-tests',
  strategy: 'pipeline' as const,
  settingSourcesPinned: true,
};

describe('runRealCorpus', () => {
  it('emits p50 and p95 with n declared and never treats unknown cost as zero', async () => {
    const durations = [100, 200, 300];
    let i = 0;
    const campaign = await runRealCorpus({
      tasks: ['trivial'],
      arms: ['baseline'],
      repeats: 3,
      tupleBase,
      runner: async () => {
        const taskDurationMs = durations[i] ?? 0;
        i += 1;
        return outcome({
          taskDurationMs,
          verdict: i === 2 ? 'unverified' : 'passed',
          cost: { status: 'unknown', reason: 'not_reported' },
        });
      },
    });
    const cell = campaign.cells[0];
    expect(cell?.repeats).toHaveLength(3);
    expect(cell?.repeats[1]?.timeToAcceptedResultMs).toBeNull();
    expect(cell?.repeats[0]?.timeToAcceptedResultMs).toBe(100);
    const summary = summarizeCell(cell!);
    expect(summary.n).toBe(3);
    expect(summary.taskDurationMs.p50).toBe(200);
    expect(summary.taskDurationMs.p95).toBe(300);
    expect(summary.cost.reportedP50).toBeNull();
    expect(summary.cost.unknownRepeats).toBe(3);
    expect(summary.verdicts.passed).toBe(2);
    expect(summary.verdicts.unverified).toBe(1);
  });

  it('interleaves arms instead of running them in blocks', async () => {
    const seen: string[] = [];
    await runRealCorpus({
      tasks: ['trivial'],
      arms: ['baseline', 'strict-mcp'],
      repeats: 2,
      tupleBase,
      runner: async ({ arm, fixture }) => {
        seen.push(`${arm}:${fixture.seed}`);
        return outcome();
      },
    });
    expect(seen).toEqual(['baseline:0', 'strict-mcp:0', 'baseline:1', 'strict-mcp:1']);
  });

  it('disposes every fixture so nothing survives the campaign', async () => {
    const roots: string[] = [];
    await runRealCorpus({
      tasks: ['trivial'],
      arms: ['baseline'],
      repeats: 2,
      tupleBase,
      runner: async ({ fixture }) => {
        roots.push(fixture.root);
        return outcome();
      },
    });
    expect(roots).toHaveLength(2);
    await expect(access(roots[0] ?? '')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(roots[1] ?? '')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('marks a row invalid when fallback-model was passed', async () => {
    const campaign = await runRealCorpus({
      tasks: ['trivial'],
      arms: ['baseline'],
      repeats: 1,
      tupleBase: { ...tupleBase, fallbackModelPassed: true },
      runner: async () => outcome(),
    });
    expect(campaign.cells[0]?.repeats[0]?.invalid).toBe(true);
    expect(campaign.cells[0]?.tuple.fallbackModelPassed).toBe(true);
  });

  it('stops on a cost ceiling with a partial report, never a silent truncate', async () => {
    const campaign = await runRealCorpus({
      tasks: ['trivial'],
      arms: ['baseline'],
      repeats: 5,
      maxCostUsd: 2,
      tupleBase,
      runner: async () => outcome({ cost: { status: 'reported', amount: 1.5, currency: 'USD' } }),
    });
    expect(campaign.stop.reason).toBe('max_cost');
    expect(campaign.stop).toMatchObject({ partial: true });
    expect(campaign.cells[0]?.repeats.length).toBeGreaterThan(0);
    expect(campaign.cells[0]?.repeats.length).toBeLessThan(5);
  });

  it('correlates each repeat to ExecutionRecord ids', async () => {
    const campaign = await runRealCorpus({
      tasks: ['analysis'],
      arms: ['baseline'],
      repeats: 1,
      tupleBase,
      runner: async () =>
        outcome({
          records: [record('abc', { status: 'unknown', reason: 'not_reported' })],
          verdict: 'unverified',
          cost: { status: 'unknown', reason: 'not_reported' },
        }),
    });
    expect(campaign.cells[0]?.repeats[0]?.executionIds).toEqual(['abc']);
    expect(campaign.cells[0]?.repeats[0]?.timeToAcceptedResultMs).toBeNull();
    expect(campaign.cells[0]?.tuple.harnessVersion).toBe('2.1.251');
  });
});
