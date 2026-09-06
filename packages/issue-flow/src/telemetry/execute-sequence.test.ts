import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult } from '../agents/types.js';
import { loadTaskPlan } from '../core/state-manager.js';
import type { TaskPlan } from '../types.js';
import { summarize } from './aggregate.js';
import { bindTelemetry, resetTelemetryState } from './recorder.js';
import { DEFAULT_TELEMETRY_CONFIG } from './types.js';

vi.mock('../agents/select.js', () => ({
  selectAgentForInvocation: vi.fn(),
}));

vi.mock('../agents/registry.js', () => ({
  runnerFor: vi.fn(),
}));

import { invokeSelectedAgent, resetAgentInvocationState } from '../agents/invoke.js';
import { runnerFor } from '../agents/registry.js';
import { selectAgentForInvocation } from '../agents/select.js';

const mockSelect = vi.mocked(selectAgentForInvocation);
const mockRunnerFor = vi.mocked(runnerFor);

function runResult(
  overrides: Partial<AgentRunResult> & { success: boolean; exitCode: number },
): AgentRunResult {
  return {
    result: '',
    rawOutput: overrides.rawOutput ?? overrides.error ?? '',
    usage: null,
    error: null,
    agent: { provider: 'claude', model: null },
    ...overrides,
  };
}

function selection(provider: 'claude' | 'codex', failover: boolean) {
  return {
    primary: 'claude' as const,
    provider,
    settings: {
      provider,
      model: provider === 'codex' ? 'gpt-5' : null,
      claude: {},
      codex: {},
      cursor: {},
      antigravity: {},
      opencode: {},
      origin: { provider: 'default' as const, model: 'default' as const },
    },
    healthFile: null,
    failover,
    reason: failover ? ('rate_limit' as const) : null,
    cooldownUntil: null,
  };
}

describe('execution record sequence', () => {
  let tasksPath: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'telemetry-sequence-'));
    tasksPath = join(dir, 'tasks.json');
    const plan: TaskPlan = {
      project: 'test',
      issueNumber: 63,
      issueUrl: '',
      branchName: 'feat/63-x',
      description: '',
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
    await writeFile(tasksPath, JSON.stringify(plan, null, 2));
    bindTelemetry({ tasksPath, config: DEFAULT_TELEMETRY_CONFIG });
    resetAgentInvocationState();
  });

  afterEach(() => {
    resetTelemetryState();
    resetAgentInvocationState();
  });

  it('records initial → retry → fallback with distinct metrics', async () => {
    mockSelect
      .mockResolvedValueOnce(selection('claude', false))
      .mockResolvedValueOnce(selection('claude', false))
      .mockResolvedValueOnce(selection('codex', true));

    const run = vi
      .fn()
      .mockResolvedValueOnce(
        runResult({
          success: false,
          exitCode: 1,
          error: 'rate limit exceeded',
          rawOutput: 'rate limit exceeded',
          usage: { inputTokens: 400_000, costUsd: 0.31 },
          agent: { provider: 'claude', model: null },
        }),
      )
      .mockResolvedValueOnce(
        runResult({
          success: false,
          exitCode: 1,
          error: 'rate limit exceeded',
          rawOutput: 'rate limit exceeded',
          usage: { inputTokens: 100, costUsd: 0.02 },
          agent: { provider: 'claude', model: null },
        }),
      )
      .mockResolvedValueOnce(
        runResult({
          success: true,
          exitCode: 0,
          result: 'ok',
          usage: { inputTokens: 22718, outputTokens: 194 },
          agent: { provider: 'codex', model: 'gpt-5' },
        }),
      );

    mockRunnerFor.mockReturnValue({
      id: 'claude',
      capabilities: {
        addDirs: true,
        reportsUsage: true,
        reportsCost: true,
        authProbe: 'exit-code',
        bareModelAliases: false,
      },
      versionCommand: () => ({ command: 'claude', args: ['--version'] }),
      run,
    } as never);

    const invocation = {
      prompt: 'p',
      phase: 'prd' as const,
      timeout: 0,
      permission: 'workspace' as const,
    };
    await invokeSelectedAgent(invocation);
    await invokeSelectedAgent(invocation);
    await invokeSelectedAgent(invocation);

    const records = (await loadTaskPlan(tasksPath)).executions ?? [];
    expect(records.map((record) => record.trigger)).toEqual(['initial', 'retry', 'fallback']);
    expect(records.map((record) => record.agent.harness)).toEqual([
      'claude-code',
      'claude-code',
      'codex-cli',
    ]);
    expect(records[2]?.triggerReason).toBe('rate_limit');
    const totals = summarize(records);
    expect(totals.count).toBe(3);
    expect(totals.totalCost.reported).toBeCloseTo(0.33);
    expect(totals.totalCost.unknownExecutions).toBe(1);
  });
});
