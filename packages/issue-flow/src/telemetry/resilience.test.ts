import { mkdtemp, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import type { TaskPlan } from '../types.js';
import { reconcileInterruptedExecutions } from './reconcile.js';
import { beginExecution, bindTelemetry, endExecution, resetTelemetryState } from './recorder.js';
import type { ExecutionRecord } from './types.js';
import { DEFAULT_TELEMETRY_CONFIG } from './types.js';

function basePlan(): TaskPlan {
  return {
    project: 'test',
    issueNumber: 1,
    issueUrl: '',
    branchName: 'feat/1-test',
    description: 't',
    issueStatus: 'in_progress',
    completedAt: null,
    lastAttemptAt: null,
    lastError: null,
    correctionCycle: 0,
    maxCorrectionCycles: 3,
    lastReviewFindings: null,
    pipeline: {
      prdCompleted: true,
      jsonCompleted: true,
      executionCompleted: false,
      reviewCompleted: false,
      prCreated: false,
    },
    userStories: [
      {
        id: 'US-001',
        title: 'Story',
        description: '',
        acceptanceCriteria: [],
        priority: 1,
        passes: false,
        notes: '',
      },
    ],
  };
}

function running(owner: ExecutionRecord['owner']): ExecutionRecord {
  return {
    id: 'exec-1',
    sessionId: null,
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
    startedAt: '2026-08-30T00:00:00Z',
    finishedAt: null,
    durationMs: null,
    usage: null,
    cost: { status: 'unknown', reason: 'not_reported' },
    status: 'running',
    failure: null,
    owner,
  };
}

describe('telemetry resilience', () => {
  let tasksPath: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'telemetry-resilience-'));
    tasksPath = join(dir, 'tasks.json');
    await writeFile(tasksPath, JSON.stringify(basePlan(), null, 2));
    resetTelemetryState();
  });

  afterEach(() => {
    resetTelemetryState();
  });

  it('turns a dead-pid running record into interrupted', () => {
    const plan = {
      ...basePlan(),
      executions: [running({ pid: 999_999_991, host: hostname() })],
    };
    const next = reconcileInterruptedExecutions(plan);
    expect(next.executions?.[0]?.status).toBe('interrupted');
    expect(next.executions?.[0]?.finishedAt).toBeTruthy();
  });

  it('leaves a live-pid running record alone', () => {
    const plan = {
      ...basePlan(),
      executions: [running({ pid: process.pid, host: hostname() })],
    };
    expect(reconcileInterruptedExecutions(plan).executions?.[0]?.status).toBe('running');
  });

  it('preserves passes written by the agent between begin and end', async () => {
    bindTelemetry({ tasksPath, config: DEFAULT_TELEMETRY_CONFIG });
    const id = await beginExecution({ purpose: 'execute', harness: 'claude-code' });
    const mid = await loadTaskPlan(tasksPath);
    mid.userStories[0]!.passes = true;
    await saveTaskPlan(tasksPath, mid);
    await endExecution({ id: id!, usage: { inputTokens: 3 } });
    const done = await loadTaskPlan(tasksPath);
    expect(done.userStories[0]?.passes).toBe(true);
    expect(done.executions?.[0]?.status).toBe('completed');
  });
});
