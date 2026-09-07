import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPlanRepository, listStoredExecutions } from '../storage/db/repository.js';
import type { TaskPlan } from '../types.js';
import {
  beginExecution,
  bindTelemetry,
  endExecution,
  resetTelemetryState,
  timingFromUsage,
} from './recorder.js';
import { DEFAULT_TELEMETRY_CONFIG } from './types.js';

function plan(): TaskPlan {
  return {
    project: 'test',
    issueNumber: 1,
    issueUrl: '',
    branchName: 'feat/1-test',
    noBranch: false,
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
    userStories: [],
  };
}

describe('timingFromUsage', () => {
  it('treats a missing duration as unreported, never zero', () => {
    expect(timingFromUsage(5000, { inputTokens: 1 })).toEqual({
      cliDurationMs: null,
      harnessStartupMs: null,
      apiDurationMs: null,
      ttftMs: null,
      numTurns: null,
    });
  });

  it('derives startup as wall minus the CLI envelope', () => {
    expect(timingFromUsage(5580, { cliDurationMs: 1948, ttftMs: 400 })).toEqual({
      cliDurationMs: 1948,
      harnessStartupMs: 3632,
      apiDurationMs: null,
      ttftMs: 400,
      numTurns: null,
    });
  });
});

describe('recorder', () => {
  let dir: string;
  let tasksPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'telemetry-recorder-'));
    tasksPath = join(dir, 'tasks.json');
    await writeFile(tasksPath, JSON.stringify(plan(), null, 2));
    resetTelemetryState();
  });

  afterEach(() => {
    resetTelemetryState();
  });

  async function loadRecords() {
    const repository = getPlanRepository(tasksPath);
    if (repository === undefined) return [];
    return listStoredExecutions({
      projectId: repository.projectId,
      issueId: repository.issueId,
      databaseOptions: repository.databaseOptions,
    });
  }

  it('persists startedAt before the invocation and finishedAt after', async () => {
    bindTelemetry({ tasksPath, config: DEFAULT_TELEMETRY_CONFIG });
    const id = await beginExecution({
      purpose: 'prd',
      harness: 'claude-code',
      provider: 'anthropic',
    });
    expect(id).toBeTruthy();
    const running = await loadRecords();
    expect(running).toHaveLength(1);
    expect(running[0]?.status).toBe('running');
    expect(running[0]?.startedAt).toMatch(/^\d{4}-/);
    expect(running[0]?.finishedAt).toBeNull();

    await endExecution({ id: id!, usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.12 } });
    const record = (await loadRecords())[0];
    expect(record?.status).toBe('completed');
    expect(record?.finishedAt).toMatch(/^\d{4}-/);
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
    expect(record?.cost).toEqual({ status: 'reported', amount: 0.12, currency: 'USD' });
    expect(record?.usage).toMatchObject({ inputTokens: 10, source: 'provider' });
  });

  it.each(['failed', 'timeout', 'cancelled'] as const)('records status %s', async (status) => {
    bindTelemetry({ tasksPath, config: DEFAULT_TELEMETRY_CONFIG });
    const id = await beginExecution({ purpose: 'execute', harness: 'claude-code' });
    await endExecution({
      id: id!,
      status,
      error: status === 'timeout' ? 'agent timed out' : 'boom',
      exitCode: 1,
    });
    expect((await loadRecords())[0]?.status).toBe(status);
    expect((await loadRecords())[0]?.failure?.message).toBeTruthy();
  });

  it('does not write when telemetry is disabled', async () => {
    bindTelemetry({
      tasksPath,
      config: { ...DEFAULT_TELEMETRY_CONFIG, enabled: false },
    });
    const id = await beginExecution({ purpose: 'prd', harness: 'claude-code' });
    expect(id).toBeNull();
    expect(await loadRecords()).toEqual([]);
  });

  it('swallows a write failure', async () => {
    bindTelemetry({
      tasksPath: join(dir, 'missing', 'tasks.json'),
      config: DEFAULT_TELEMETRY_CONFIG,
    });
    await expect(beginExecution({ purpose: 'prd', harness: 'claude-code' })).resolves.toBeNull();
  });

  it('keeps a failed attempt when a retry is recorded', async () => {
    bindTelemetry({ tasksPath, config: DEFAULT_TELEMETRY_CONFIG });
    const first = await beginExecution({
      purpose: 'prd',
      attempt: 1,
      trigger: 'initial',
      harness: 'claude-code',
      provider: 'anthropic',
    });
    await endExecution({ id: first!, status: 'failed', error: 'rate limited', exitCode: 1 });
    const second = await beginExecution({
      purpose: 'prd',
      attempt: 2,
      trigger: 'retry',
      triggerReason: 'rate_limit',
      harness: 'claude-code',
      provider: 'anthropic',
    });
    await endExecution({ id: second!, usage: { costUsd: 0.01 } });
    const records = await loadRecords();
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.trigger)).toEqual(['initial', 'retry']);
    expect(records[0]?.status).toBe('failed');
    expect(records[1]?.status).toBe('completed');
  });

  it('persists CLI timing and derived harnessStartupMs', async () => {
    bindTelemetry({ tasksPath, config: DEFAULT_TELEMETRY_CONFIG });
    const id = await beginExecution({ purpose: 'prd', harness: 'claude-code' });
    await endExecution({
      id: id!,
      usage: { inputTokens: 2, cliDurationMs: 100, ttftMs: 40, numTurns: 1 },
    });
    const record = (await loadRecords())[0];
    expect(record?.cliDurationMs).toBe(100);
    expect(record?.ttftMs).toBe(40);
    expect(record?.numTurns).toBe(1);
    expect(record?.harnessStartupMs).toBeGreaterThanOrEqual(0);
    expect(record).not.toHaveProperty('apiDurationMs', 0);
  });

  it('does not create a record when nothing is bound', async () => {
    const id = await beginExecution({ purpose: 'prd', harness: 'claude-code' });
    expect(id).toBeNull();
  });
});
