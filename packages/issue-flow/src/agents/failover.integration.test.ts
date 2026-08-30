import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setActiveResilienceConfig, setAgentCliOverrides } from '../config.js';
import { JournalPublisher, parseJournal } from '../core/journal.js';
import { setSessionPublisher } from '../core/session-publisher.js';
import { MemoryPublisher } from '../core/session-state.js';
import { classify } from '../resilience/errors.js';
import { resetStorageResolutionCache, resolveProjectPaths } from '../storage/resolve.js';
import { acquireHalfOpenProbe, recordProviderFailure } from './health.js';
import { invokeSelectedAgent, resetAgentInvocationState } from './invoke.js';
import { clearRunners, registerRunner } from './registry.js';
import { selectAgentForInvocation } from './select.js';
import { type AgentRunner, type AgentRunResult, CLAUDE_CAPABILITIES } from './types.js';

const originalHome = process.env.ISSUE_FLOW_HOME;

function runner(id: 'claude' | 'codex', run: () => AgentRunResult): AgentRunner {
  return {
    id,
    capabilities: CLAUDE_CAPABILITIES,
    versionCommand: () => ({ command: id, args: ['--version'] }),
    run: async () => run(),
  };
}

function result(provider: 'claude' | 'codex', success: boolean): AgentRunResult {
  return {
    success,
    result: success ? 'done' : '',
    rawOutput: success ? '' : 'service unavailable',
    exitCode: success ? 0 : 75,
    usage: null,
    error: success ? null : 'service unavailable',
    agent: { provider, model: null },
  };
}

beforeEach(async () => {
  process.env.ISSUE_FLOW_HOME = await mkdtemp(join(tmpdir(), 'issue-flow-failover-'));
  resetStorageResolutionCache();
  resetAgentInvocationState();
  clearRunners();
  setAgentCliOverrides({ forceProvider: 'claude' });
  setActiveResilienceConfig({
    providers: { failover: true, cooldownMs: 1_000, failuresToTrip: 3 },
  });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.ISSUE_FLOW_HOME;
  else process.env.ISSUE_FLOW_HOME = originalHome;
  setSessionPublisher(undefined);
  setActiveResilienceConfig({});
  setAgentCliOverrides({});
  clearRunners();
  resetStorageResolutionCache();
});

describe('agent failover integration', () => {
  it('moves from Claude to Codex after two provider failures and journals the switch', async () => {
    registerRunner(runner('claude', () => result('claude', false)));
    registerRunner(runner('codex', () => result('codex', true)));
    const { projectDir } = await resolveProjectPaths();
    const events = join(projectDir, 'events.jsonl');
    const journal = new JournalPublisher(events, join(projectDir, 'events.1.jsonl'));
    setSessionPublisher(journal);
    const invocation = {
      prompt: 'work',
      phase: 'execute' as const,
      timeout: 0,
      permission: 'autonomous' as const,
    };

    expect((await invokeSelectedAgent(invocation)).run.agent.provider).toBe('claude');
    expect((await invokeSelectedAgent(invocation)).run.agent.provider).toBe('claude');
    expect((await invokeSelectedAgent(invocation)).run.agent.provider).toBe('codex');
    await journal.close();

    const entries = parseJournal(await readFile(events, 'utf-8'));
    expect(entries.some((entry) => entry.event.type === 'failover')).toBe(true);
    expect(entries.find((entry) => entry.event.type === 'failover')?.event).toMatchObject({
      from: 'claude',
      to: 'codex',
      reason: 'provider_down',
    });
  });

  it('does not fail over authentication by default', async () => {
    registerRunner(
      runner('claude', () => ({
        ...result('claude', false),
        rawOutput: 'authentication failed',
        error: 'authentication failed',
        exitCode: 1,
      })),
    );
    let codexCalls = 0;
    registerRunner(
      runner('codex', () => {
        codexCalls++;
        return result('codex', true);
      }),
    );
    const invocation = {
      prompt: 'work',
      phase: 'execute' as const,
      timeout: 0,
      permission: 'autonomous' as const,
    };

    const first = await invokeSelectedAgent(invocation);
    expect(first.failure?.kind).toBe('authentication');
    await expect(invokeSelectedAgent(invocation)).rejects.toThrow(
      /authentication.*run is blocked/i,
    );
    expect(codexCalls).toBe(0);
  });

  it('works symmetrically with Codex as the primary provider', async () => {
    setAgentCliOverrides({ forceProvider: 'codex' });
    registerRunner(runner('codex', () => result('codex', false)));
    registerRunner(runner('claude', () => result('claude', true)));
    const invocation = {
      prompt: 'work',
      phase: 'execute' as const,
      timeout: 0,
      permission: 'autonomous' as const,
    };

    expect((await invokeSelectedAgent(invocation)).run.agent.provider).toBe('codex');
    expect((await invokeSelectedAgent(invocation)).run.agent.provider).toBe('codex');
    expect((await invokeSelectedAgent(invocation)).run.agent.provider).toBe('claude');
  });

  it('keeps a rate-limited primary for the first occurrence and fails over after the second', async () => {
    setActiveResilienceConfig({ providers: { failover: true, cooldownMs: 100 } });
    registerRunner(
      runner('claude', () => ({
        ...result('claude', false),
        rawOutput: 'rate limit exceeded',
        error: 'rate limit exceeded',
        exitCode: 1,
      })),
    );
    registerRunner(runner('codex', () => result('codex', true)));
    const invocation = {
      prompt: 'work',
      phase: 'execute' as const,
      timeout: 0,
      permission: 'autonomous' as const,
    };

    expect((await invokeSelectedAgent(invocation)).selection.provider).toBe('claude');
    expect((await invokeSelectedAgent(invocation)).selection.provider).toBe('claude');
    expect((await invokeSelectedAgent(invocation)).selection.provider).toBe('codex');
  });

  it.each([
    ['network', 'network unavailable'],
    ['task_execution', 'Tests 3 failed'],
  ] as const)('never fails over %s failures', async (expectedKind, diagnostics) => {
    let codexCalls = 0;
    registerRunner(
      runner('claude', () => ({
        ...result('claude', false),
        rawOutput: diagnostics,
        error: diagnostics,
        exitCode: 1,
      })),
    );
    registerRunner(
      runner('codex', () => {
        codexCalls++;
        return result('codex', true);
      }),
    );
    const invocation = {
      prompt: 'work',
      phase: 'execute' as const,
      timeout: 0,
      permission: 'autonomous' as const,
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      const selected = await invokeSelectedAgent(invocation);
      expect(selected.selection.provider).toBe('claude');
      expect(selected.failure?.kind).toBe(expectedKind);
    }
    expect(codexCalls).toBe(0);
  });

  it('waits for the shortest cooldown and admits one half-open probe', async () => {
    registerRunner(runner('claude', () => result('claude', true)));
    registerRunner(runner('codex', () => result('codex', true)));
    const { providersHealthFile } = await resolveProjectPaths();
    let now = Date.parse('2026-08-30T10:00:00.000Z');
    const healthConfig = { cooldownMs: 100, failuresToTrip: 1 };
    const down = classify({ source: 'agent', stdout: 'service unavailable' });
    await recordProviderFailure(providersHealthFile, 'claude', down, {
      now: () => now,
      config: healthConfig,
    });
    await recordProviderFailure(providersHealthFile, 'codex', down, {
      now: () => now,
      config: { ...healthConfig, cooldownMs: 200 },
    });
    const waits: number[] = [];

    const selected = await selectAgentForInvocation('execute', {
      config: { providers: { failover: true, ...healthConfig } },
      now: () => now,
      delay: async (ms) => {
        waits.push(ms);
        now += ms;
        return true;
      },
    });

    expect(waits).toEqual([100]);
    expect(selected.provider).toBe('claude');
  });

  it('reclaims a half-open probe abandoned by a killed run', async () => {
    registerRunner(runner('claude', () => result('claude', true)));
    const { providersHealthFile } = await resolveProjectPaths();
    let now = Date.parse('2026-08-30T10:00:00.000Z');
    const healthConfig = { cooldownMs: 100, failuresToTrip: 1 };
    await recordProviderFailure(
      providersHealthFile,
      'claude',
      classify({ source: 'agent', stdout: 'service unavailable' }),
      { now: () => now, config: healthConfig },
    );

    // A run acquires the probe and is SIGKILLed: the record stays `half_open`
    // with `probeInFlight`, and nothing else ever clears it.
    now += 100;
    expect(
      (
        await acquireHalfOpenProbe(providersHealthFile, 'claude', {
          now: () => now,
          config: healthConfig,
        })
      ).acquired,
    ).toBe(true);

    // Long enough after that the probe is stale. Before the fix, `half_open`
    // returned an unconditional cooldown and the next run waited forever.
    now += 10_000;
    const waits: number[] = [];
    const selected = await selectAgentForInvocation('execute', {
      config: { providers: { failover: true, ...healthConfig } },
      now: () => now,
      delay: async (ms) => {
        waits.push(ms);
        now += ms;
        if (waits.length > 3) throw new Error('selection did not converge');
        return true;
      },
    });

    expect(waits).toEqual([]);
    expect(selected.provider).toBe('claude');
  });

  it('keeps the configured primary and creates no health file when failover is disabled', async () => {
    setActiveResilienceConfig({ providers: { failover: false } });
    registerRunner(runner('claude', () => result('claude', false)));
    let codexCalls = 0;
    registerRunner(
      runner('codex', () => {
        codexCalls++;
        return result('codex', true);
      }),
    );
    const selected = await invokeSelectedAgent({
      prompt: 'work',
      phase: 'execute',
      timeout: 0,
      permission: 'autonomous',
    });

    expect(selected.selection).toMatchObject({ provider: 'claude', healthFile: null });
    expect(codexCalls).toBe(0);
  });

  it('projects real runner output as the provider last activity', async () => {
    setActiveResilienceConfig({ providers: { failover: false } });
    registerRunner({
      ...runner('claude', () => result('claude', true)),
      run: async (invocation) => {
        invocation.onLine?.('working');
        return result('claude', true);
      },
    });
    const publisher = new MemoryPublisher();
    publisher.publish({
      type: 'session:start',
      at: '2026-08-30T10:00:00Z',
      sessionId: 'session-1',
      issueNumber: 70,
      phases: ['execute'],
    });
    setSessionPublisher(publisher);

    await invokeSelectedAgent({
      prompt: 'work',
      phase: 'execute',
      timeout: 0,
      permission: 'autonomous',
    });

    expect(publisher.snapshot().resilience).toMatchObject({
      attempt: 1,
      provider: 'claude',
    });
    expect(publisher.snapshot().resilience.lastActivityAt).not.toBeNull();
  });
});
