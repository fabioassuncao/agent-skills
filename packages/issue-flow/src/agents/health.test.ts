import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../resilience/errors.js';
import type { PlanRepositoryContext } from '../storage/db/repository.js';
import {
  acquireHalfOpenProbe,
  readProvidersHealth,
  recordProviderFailure,
  recordProviderSuccess,
} from './health.js';

function healthContext(dir: string): PlanRepositoryContext {
  return {
    tasksPath: join(dir, 'tasks.json'),
    projectId: `health-${dir.split('/').at(-1)}`,
    issueId: 'provider-health',
    projectRoot: dir,
    databaseOptions: { env: { ISSUE_FLOW_HOME: dir } },
  };
}

describe('provider health persistence', () => {
  it('trips, doubles cooldown after a failed half-open probe, and resets on success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'issue-flow-health-'));
    const context = healthContext(dir);
    let now = Date.parse('2026-08-30T10:00:00.000Z');
    const failure = classify({ source: 'agent', stdout: 'service unavailable' });
    const options = {
      now: () => now,
      config: { cooldownMs: 100, maxCooldownMs: 1_000, failuresToTrip: 3 },
    };

    await recordProviderFailure(context, 'claude', failure, options);
    await recordProviderFailure(context, 'claude', failure, options);
    let record = await recordProviderFailure(context, 'claude', failure, options);
    expect(record.status).toBe('unavailable');
    expect(Date.parse(record.cooldownUntil ?? '') - now).toBe(100);

    now += 100;
    const firstProbe = await acquireHalfOpenProbe(context, 'claude', options);
    const secondProbe = await acquireHalfOpenProbe(context, 'claude', options);
    expect(firstProbe.acquired).toBe(true);
    expect(secondProbe.acquired).toBe(false);

    record = await recordProviderFailure(context, 'claude', failure, options);
    expect(record.status).toBe('unavailable');
    expect(Date.parse(record.cooldownUntil ?? '') - now).toBe(200);

    now += 200;
    expect((await acquireHalfOpenProbe(context, 'claude', options)).acquired).toBe(true);
    record = await recordProviderSuccess(context, 'claude', { now: () => now });
    expect(record).toMatchObject({ status: 'healthy', cooldownLevel: 0, cooldownUntil: null });

    expect((await readProvidersHealth(context)).providers.claude.status).toBe('healthy');
  });

  it('uses Retry-After verbatim for rate limits and survives a fresh read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'issue-flow-health-'));
    const context = healthContext(dir);
    const now = Date.parse('2026-08-30T10:00:00.000Z');
    const failure = classify({ source: 'agent', stdout: 'rate limit; Retry-After: 7' });

    const record = await recordProviderFailure(context, 'codex', failure, { now: () => now });
    expect(record.status).toBe('rate_limited');
    expect(Date.parse(record.cooldownUntil ?? '') - now).toBe(7_000);
    expect((await readProvidersHealth(context)).providers.codex).toEqual(record);
  });

  it('stores provider health in SQLite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'issue-flow-health-sqlite-'));
    const context = healthContext(dir);
    const record = await recordProviderFailure(
      context,
      'codex',
      classify({ source: 'agent', stdout: 'rate limit; Retry-After: 7' }),
    );
    expect(record.status).toBe('rate_limited');
    expect((await readProvidersHealth(context)).providers.codex).toEqual(record);
  });

  it('does not let network or task failures contaminate breaker counters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'issue-flow-health-'));
    const context = healthContext(dir);
    const providerFailure = classify({ source: 'agent', stdout: 'service unavailable' });
    const networkFailure = classify({ source: 'git', stdout: 'could not resolve host' });
    const taskFailure = classify({ source: 'agent', stdout: 'Tests 3 failed' });

    await recordProviderFailure(context, 'claude', providerFailure);
    await recordProviderFailure(context, 'claude', networkFailure);
    const record = await recordProviderFailure(context, 'claude', taskFailure);

    expect(record.status).toBe('degraded');
    expect(record.consecutiveFailures).toBe(1);
    expect(record.failures).toHaveLength(1);
    expect(record.lastFailureKind).toBe('task_execution');
  });

  it('uses a sliding failure window and caps exponential cooldown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'issue-flow-health-'));
    const context = healthContext(dir);
    let now = Date.parse('2026-08-30T10:00:00.000Z');
    const failure = classify({ source: 'agent', stdout: 'service unavailable' });
    const options = {
      now: () => now,
      config: {
        cooldownMs: 100,
        maxCooldownMs: 250,
        failureWindowMs: 1_000,
        failuresToTrip: 2,
      },
    };

    await recordProviderFailure(context, 'claude', failure, options);
    now += 1_001;
    let record = await recordProviderFailure(context, 'claude', failure, options);
    expect(record.status).toBe('degraded');
    expect(record.failures).toHaveLength(1);

    record = await recordProviderFailure(context, 'claude', failure, options);
    expect(Date.parse(record.cooldownUntil ?? '') - now).toBe(100);
    now += 100;
    expect((await acquireHalfOpenProbe(context, 'claude', options)).acquired).toBe(true);
    record = await recordProviderFailure(context, 'claude', failure, options);
    expect(Date.parse(record.cooldownUntil ?? '') - now).toBe(200);
    now += 200;
    expect((await acquireHalfOpenProbe(context, 'claude', options)).acquired).toBe(true);
    record = await recordProviderFailure(context, 'claude', failure, options);
    expect(Date.parse(record.cooldownUntil ?? '') - now).toBe(250);
  });
});
