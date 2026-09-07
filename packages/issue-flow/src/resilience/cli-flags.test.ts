import { describe, expect, it } from 'vitest';
import { DEFAULT_INACTIVITY_TIMEOUT_MS } from '../core/watchdog.js';
import { resolveResilienceOverrides } from './cli-flags.js';
import { resolvePolicy } from './policy.js';

describe('resolveResilienceOverrides — nothing asked for', () => {
  it('produces no configuration at all', () => {
    // The whole non-regression claim of the profile: without a flag, the CLI
    // rung is empty and every kind stays on the base table.
    expect(resolveResilienceOverrides({})).toEqual({});
  });
});

describe('--continuous', () => {
  it('turns on the autonomous behaviours', () => {
    const overrides = resolveResilienceOverrides({ continuous: true });

    expect(overrides).toEqual({
      profile: 'continuous',
      providers: { failover: true },
      queue: { onIssueFailure: 'skip' },
      watchdog: { inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS },
    });
  });

  it('is what makes network and rate limits retry forever', () => {
    const overrides = resolveResilienceOverrides({ continuous: true });

    // The retry half comes from the profile of `resolvePolicy()`, never from a
    // list of numbers repeated in the flag layer.
    expect(resolvePolicy('network', overrides).retryForever).toBe(true);
    expect(resolvePolicy('rate_limit', overrides).retryForever).toBe(true);
  });

  it('still cannot buy an attempt for a failure that needs a human', () => {
    const overrides = resolveResilienceOverrides({ continuous: true });

    for (const kind of [
      'authentication',
      'configuration',
      'repository_state',
      'task_execution',
    ] as const) {
      expect(resolvePolicy(kind, overrides).maxAttempts).toBe(0);
      expect(resolvePolicy(kind, overrides).retryForever).toBe(false);
    }
  });

  it('accepts --resilient as the same thing', () => {
    expect(resolveResilienceOverrides({ resilient: true })).toEqual(
      resolveResilienceOverrides({ continuous: true }),
    );
  });
});

describe('a granular flag beats the profile', () => {
  it('--continuous --no-failover keeps everything else and turns failover off', () => {
    const overrides = resolveResilienceOverrides({ continuous: true, failover: false });

    expect(overrides.providers).toEqual({ failover: false });
    // Nothing else the profile asked for is lost.
    expect(overrides.queue).toEqual({ onIssueFailure: 'skip' });
  });

  it('--continuous --on-issue-failure stop keeps the queue behaviour of today', () => {
    const overrides = resolveResilienceOverrides({ continuous: true, onIssueFailure: 'stop' });

    expect(overrides.queue).toEqual({ onIssueFailure: 'stop' });
  });

  it('--continuous --inactivity-timeout 0 turns the watchdog off', () => {
    const overrides = resolveResilienceOverrides({ continuous: true, inactivityTimeout: 0 });

    expect(overrides.watchdog).toEqual({ inactivityTimeoutMs: 0 });
  });
});

describe('the granular flags on their own', () => {
  it('--no-failover configures only that', () => {
    expect(resolveResilienceOverrides({ failover: false })).toEqual({
      providers: { failover: false },
    });
  });

  it('an absent --no-failover configures nothing', () => {
    // Commander leaves the field absent when the flag was not passed, so
    // `false` is always an explicit statement rather than a default.
    expect(resolveResilienceOverrides({ failover: undefined })).toEqual({});
  });

  it('--auto-decompose configures only that', () => {
    expect(resolveResilienceOverrides({ autoDecompose: true })).toEqual({
      decompose: { auto: true },
    });
  });

  it('--inactivity-timeout is given in seconds and stored in milliseconds', () => {
    expect(resolveResilienceOverrides({ inactivityTimeout: 90 })).toEqual({
      watchdog: { inactivityTimeoutMs: 90_000 },
    });
  });

  it('--on-issue-failure configures only the queue', () => {
    expect(resolveResilienceOverrides({ onIssueFailure: 'block' })).toEqual({
      queue: { onIssueFailure: 'block' },
    });
  });
});
