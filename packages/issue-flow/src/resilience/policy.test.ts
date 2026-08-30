import { describe, expect, it, vi } from 'vitest';
import type { FailureKind } from './errors.js';
import {
  abortableDelay,
  canTransition,
  computeDelayMs,
  isTerminalRunStatus,
  type PolicyConfig,
  type RetryPolicy,
  RUN_TRANSITIONS,
  type RunStatus,
  resolvePolicy,
  retryConfigKey,
  shouldFailover,
  shouldRetry,
} from './policy.js';

const ALL_KINDS: readonly FailureKind[] = [
  'network',
  'timeout',
  'stalled',
  'rate_limit',
  'provider_down',
  'provider_crash',
  'authentication',
  'configuration',
  'repository_state',
  'task_execution',
  'internal',
  'unknown',
];

const ALL_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting',
  'retrying',
  'paused',
  'blocked',
  'failed',
  'completed',
  'cancelled',
];

/**
 * The defaults table of the PRD, cell by cell. These numbers are documented
 * behaviour, so a change here has to be a deliberate one.
 */
const DEFAULTS: readonly {
  kind: FailureKind;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  failover: RetryPolicy['failover'];
  onExhausted: RetryPolicy['onExhausted'];
}[] = [
  {
    kind: 'network',
    maxAttempts: 8,
    initialDelayMs: 2000,
    maxDelayMs: 120000,
    failover: 'never',
    onExhausted: 'fail',
  },
  {
    kind: 'timeout',
    maxAttempts: 2,
    initialDelayMs: 30000,
    maxDelayMs: 120000,
    failover: 'after_attempts',
    onExhausted: 'fail',
  },
  {
    kind: 'stalled',
    maxAttempts: 2,
    initialDelayMs: 15000,
    maxDelayMs: 15000,
    failover: 'after_attempts',
    onExhausted: 'fail',
  },
  {
    kind: 'rate_limit',
    maxAttempts: 6,
    initialDelayMs: 60000,
    maxDelayMs: 900000,
    failover: 'after_attempts',
    onExhausted: 'fail',
  },
  {
    kind: 'provider_down',
    maxAttempts: 4,
    initialDelayMs: 10000,
    maxDelayMs: 300000,
    failover: 'after_attempts',
    onExhausted: 'fail',
  },
  {
    kind: 'provider_crash',
    maxAttempts: 3,
    initialDelayMs: 5000,
    maxDelayMs: 60000,
    failover: 'after_attempts',
    onExhausted: 'fail',
  },
  {
    kind: 'authentication',
    maxAttempts: 0,
    initialDelayMs: 0,
    maxDelayMs: 0,
    failover: 'never',
    onExhausted: 'block',
  },
  {
    kind: 'configuration',
    maxAttempts: 0,
    initialDelayMs: 0,
    maxDelayMs: 0,
    failover: 'never',
    onExhausted: 'fail',
  },
  {
    kind: 'repository_state',
    maxAttempts: 0,
    initialDelayMs: 0,
    maxDelayMs: 0,
    failover: 'never',
    onExhausted: 'block',
  },
  {
    kind: 'task_execution',
    maxAttempts: 0,
    initialDelayMs: 0,
    maxDelayMs: 0,
    failover: 'never',
    onExhausted: 'fail',
  },
  {
    kind: 'internal',
    maxAttempts: 2,
    initialDelayMs: 5000,
    maxDelayMs: 5000,
    failover: 'never',
    onExhausted: 'fail',
  },
  {
    kind: 'unknown',
    maxAttempts: 2,
    initialDelayMs: 5000,
    maxDelayMs: 5000,
    failover: 'never',
    onExhausted: 'fail',
  },
];

describe('resolvePolicy — the defaults table', () => {
  for (const row of DEFAULTS) {
    it(`${row.kind}: ${row.maxAttempts} attempts, ${row.initialDelayMs}ms → ${row.maxDelayMs}ms, ${row.failover}, ${row.onExhausted}`, () => {
      const policy = resolvePolicy(row.kind);
      expect(policy.maxAttempts).toBe(row.maxAttempts);
      expect(policy.initialDelayMs).toBe(row.initialDelayMs);
      expect(policy.maxDelayMs).toBe(row.maxDelayMs);
      expect(policy.failover).toBe(row.failover);
      expect(policy.onExhausted).toBe(row.onExhausted);
    });
  }

  it('defaults to full jitter, factor 2 and a bounded budget for every kind', () => {
    for (const kind of ALL_KINDS) {
      const policy = resolvePolicy(kind);
      expect(policy.jitter).toBe('full');
      expect(policy.backoffFactor).toBe(2);
      expect(policy.retryForever).toBe(false);
    }
  });
});

describe('resolvePolicy — the continuous profile', () => {
  const continuous: PolicyConfig = { profile: 'continuous' };

  it('retries network and rate_limit forever, still under maxDelayMs', () => {
    for (const kind of ['network', 'rate_limit'] as const) {
      const policy = resolvePolicy(kind, continuous);
      expect(policy.retryForever).toBe(true);
      expect(policy.maxDelayMs).toBe(resolvePolicy(kind).maxDelayMs);
    }
  });

  it('widens timeout, stalled and provider_crash budgets', () => {
    expect(resolvePolicy('timeout', continuous).maxAttempts).toBe(3);
    expect(resolvePolicy('stalled', continuous).maxAttempts).toBe(3);
    expect(resolvePolicy('provider_crash', continuous).maxAttempts).toBe(5);
  });

  it('retries provider_down forever, with failover', () => {
    const policy = resolvePolicy('provider_down', continuous);
    expect(policy.retryForever).toBe(true);
    expect(policy.failover).toBe('after_attempts');
  });

  it('never grants an attempt to a kind that needs a human', () => {
    for (const kind of [
      'authentication',
      'configuration',
      'repository_state',
      'task_execution',
    ] as const) {
      const policy = resolvePolicy(kind, continuous);
      expect(policy.maxAttempts).toBe(0);
      expect(policy.retryForever).toBe(false);
    }
  });
});

describe('resolvePolicy — the configuration layer', () => {
  it('maps every kind to a camelCase configuration key', () => {
    expect(retryConfigKey('rate_limit')).toBe('rateLimit');
    expect(retryConfigKey('provider_down')).toBe('providerDown');
    expect(retryConfigKey('repository_state')).toBe('repositoryState');
    expect(new Set(ALL_KINDS.map(retryConfigKey)).size).toBe(ALL_KINDS.length);
  });

  it('lets the user override a single field, keeping the rest of the row', () => {
    const policy = resolvePolicy('provider_down', {
      retry: { providerDown: { maxAttempts: 9 } },
    });
    expect(policy.maxAttempts).toBe(9);
    expect(policy.initialDelayMs).toBe(10000);
    expect(policy.failover).toBe('after_attempts');
  });

  it('lets the user override the profile', () => {
    const policy = resolvePolicy('network', {
      profile: 'continuous',
      retry: { network: { retryForever: false, maxAttempts: 4 } },
    });
    expect(policy.retryForever).toBe(false);
    expect(policy.maxAttempts).toBe(4);
  });

  it('an absent configuration is the same as an empty one', () => {
    for (const kind of ALL_KINDS) {
      expect(resolvePolicy(kind, {})).toEqual(resolvePolicy(kind));
    }
  });

  it('clamps a nonsensical configuration instead of breaking the math', () => {
    const policy = resolvePolicy('network', {
      retry: {
        network: {
          maxAttempts: -3,
          initialDelayMs: -1,
          maxDelayMs: -1,
          backoffFactor: 0.5,
          failoverAfterAttempts: 0,
        },
      },
    });
    expect(policy.maxAttempts).toBe(0);
    expect(policy.initialDelayMs).toBe(0);
    expect(policy.maxDelayMs).toBe(0);
    expect(policy.backoffFactor).toBe(1);
    expect(policy.failoverAfterAttempts).toBe(1);
  });
});

describe('resolvePolicy — the golden rule', () => {
  it('refuses to retry task_execution, even with retryForever configured', () => {
    const policy = resolvePolicy('task_execution', {
      profile: 'continuous',
      retry: { taskExecution: { maxAttempts: 10, retryForever: true } },
    });
    expect(policy.maxAttempts).toBe(0);
    expect(policy.retryForever).toBe(false);
    expect(shouldRetry(policy, 0)).toBe(false);
  });

  it('refuses to retry authentication, configuration and repository_state too', () => {
    for (const kind of ['authentication', 'configuration', 'repository_state'] as const) {
      const policy = resolvePolicy(kind, {
        retry: { [retryConfigKey(kind)]: { maxAttempts: 5, retryForever: true } },
      });
      expect(shouldRetry(policy, 0)).toBe(false);
    }
  });

  it('never fails over on a credential failure unless asked explicitly', () => {
    const byDefault = resolvePolicy('authentication', {
      retry: { authentication: { failover: 'immediate' } },
    });
    expect(byDefault.failover).toBe('never');
    expect(shouldFailover(byDefault, 99)).toBe(false);

    const optedIn = resolvePolicy('authentication', {
      failoverOnAuth: true,
      retry: { authentication: { failover: 'immediate' } },
    });
    expect(optedIn.failover).toBe('immediate');
  });

  it('failoverOnAuth does not leak into the other human-action kinds', () => {
    for (const kind of ['configuration', 'repository_state', 'task_execution'] as const) {
      const policy = resolvePolicy(kind, {
        failoverOnAuth: true,
        retry: { [retryConfigKey(kind)]: { failover: 'immediate' } },
      });
      expect(policy.failover).toBe('never');
    }
  });
});

describe('shouldRetry', () => {
  it('spends exactly maxAttempts attempts', () => {
    const policy = resolvePolicy('provider_crash');
    expect(shouldRetry(policy, 0)).toBe(true);
    expect(shouldRetry(policy, 2)).toBe(true);
    expect(shouldRetry(policy, 3)).toBe(false);
  });

  it('never stops under retryForever', () => {
    const policy = resolvePolicy('network', { profile: 'continuous' });
    expect(shouldRetry(policy, 10000)).toBe(true);
  });

  it('a zero budget outranks retryForever', () => {
    const policy: RetryPolicy = { ...resolvePolicy('network'), maxAttempts: 0, retryForever: true };
    expect(shouldRetry(policy, 0)).toBe(false);
  });
});

describe('shouldFailover', () => {
  it('never, for a kind whose failover is never', () => {
    expect(shouldFailover(resolvePolicy('network'), 100)).toBe(false);
  });

  it('after the configured number of attempts', () => {
    const policy = resolvePolicy('provider_down');
    expect(shouldFailover(policy, 1)).toBe(false);
    expect(shouldFailover(policy, 2)).toBe(true);
  });

  it('immediately, when the policy says so', () => {
    const policy: RetryPolicy = { ...resolvePolicy('provider_down'), failover: 'immediate' };
    expect(shouldFailover(policy, 0)).toBe(true);
  });
});

describe('computeDelayMs — backoff and jitter, deterministically', () => {
  /** A fixed RNG: full jitter with `random = 1` yields the ceiling itself. */
  const ceiling = () => 1;
  const half = () => 0.5;

  it('grows by backoffFactor until it hits maxDelayMs', () => {
    const policy = resolvePolicy('network'); // 2s → 120s, factor 2
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) =>
      computeDelayMs(policy, attempt, { random: ceiling }),
    );
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, 64000, 120000, 120000]);
  });

  it('draws uniformly from [0, ceiling) under full jitter', () => {
    const policy = resolvePolicy('network');
    expect(computeDelayMs(policy, 3, { random: () => 0 })).toBe(0);
    expect(computeDelayMs(policy, 3, { random: half })).toBe(4000);
    expect(computeDelayMs(policy, 3, { random: ceiling })).toBe(8000);
  });

  it('returns the ceiling exactly when jitter is off', () => {
    const policy: RetryPolicy = { ...resolvePolicy('network'), jitter: 'none' };
    const random = vi.fn(() => 0.5);
    expect(computeDelayMs(policy, 3, { random })).toBe(8000);
    expect(random).not.toHaveBeenCalled();
  });

  it('respects maxDelayMs under retryForever — never a tight poll', () => {
    const policy = resolvePolicy('rate_limit', { profile: 'continuous' });
    for (const attempt of [1, 10, 100, 1000]) {
      expect(computeDelayMs(policy, attempt, { random: ceiling })).toBeLessThanOrEqual(
        policy.maxDelayMs,
      );
    }
    expect(computeDelayMs(policy, 1000, { random: ceiling })).toBe(900000);
  });

  it('honours a server Retry-After verbatim, above maxDelayMs and without jitter', () => {
    const policy = resolvePolicy('rate_limit');
    const random = vi.fn(() => 0.5);
    expect(computeDelayMs(policy, 1, { random, retryAfterMs: 1_800_000 })).toBe(1_800_000);
    expect(random).not.toHaveBeenCalled();
  });

  it('ignores a negative Retry-After and falls back to the backoff', () => {
    const policy = resolvePolicy('rate_limit');
    expect(computeDelayMs(policy, 1, { random: ceiling, retryAfterMs: -1 })).toBe(60000);
  });

  it('is zero for a kind with no delay at all', () => {
    expect(computeDelayMs(resolvePolicy('authentication'), 1, { random: ceiling })).toBe(0);
  });
});

describe('abortableDelay', () => {
  it('resolves true once the delay elapses', async () => {
    await expect(abortableDelay(5)).resolves.toBe(true);
  });

  it('resolves false as soon as the signal fires', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = abortableDelay(60_000, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('resolves false immediately when the signal already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableDelay(60_000, { signal: controller.signal })).resolves.toBe(false);
  });

  it('does not wait at all for a zero delay', async () => {
    await expect(abortableDelay(0)).resolves.toBe(true);
  });

  it('leaves no listener behind once it resolves', async () => {
    const controller = new AbortController();
    const spy = vi.spyOn(controller.signal, 'removeEventListener');
    await abortableDelay(1, { signal: controller.signal });
    expect(spy).toHaveBeenCalled();
  });
});

describe('the run state machine', () => {
  it('completed and cancelled are terminal, and nothing else is', () => {
    for (const status of ALL_STATUSES) {
      const terminal = status === 'completed' || status === 'cancelled';
      expect(isTerminalRunStatus(status)).toBe(terminal);
      expect(RUN_TRANSITIONS[status].length === 0).toBe(terminal);
    }
  });

  it('no transition leaves a terminal status, for anyone', () => {
    for (const from of ['completed', 'cancelled'] as const) {
      for (const to of ALL_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
        expect(canTransition(from, to, { actor: 'human' })).toBe(false);
      }
    }
  });

  it('blocked is left only by a human', () => {
    expect(canTransition('blocked', 'running')).toBe(false);
    expect(canTransition('blocked', 'cancelled')).toBe(false);
    expect(canTransition('blocked', 'running', { actor: 'human' })).toBe(true);
    expect(canTransition('blocked', 'cancelled', { actor: 'human' })).toBe(true);
    expect(canTransition('blocked', 'completed', { actor: 'human' })).toBe(false);
  });

  it('the pipeline may enter blocked from anywhere it can still act', () => {
    for (const from of ['queued', 'running', 'waiting', 'retrying', 'paused'] as const) {
      expect(canTransition(from, 'blocked')).toBe(true);
    }
  });

  it('a run reaches completed only from running', () => {
    for (const from of ALL_STATUSES) {
      expect(canTransition(from, 'completed', { actor: 'human' })).toBe(from === 'running');
    }
  });

  it('every status is cancellable while it is not terminal', () => {
    for (const from of ALL_STATUSES) {
      if (isTerminalRunStatus(from)) continue;
      expect(canTransition(from, 'cancelled', { actor: 'human' })).toBe(true);
    }
  });

  it('no status transitions to itself, and no target is unknown', () => {
    for (const from of ALL_STATUSES) {
      expect(RUN_TRANSITIONS[from]).not.toContain(from);
      for (const to of RUN_TRANSITIONS[from]) expect(ALL_STATUSES).toContain(to);
    }
  });

  it('the full transition matrix is exactly the declared table', () => {
    const matrix = ALL_STATUSES.flatMap((from) =>
      ALL_STATUSES.filter((to) => canTransition(from, to, { actor: 'human' })).map(
        (to) => `${from}→${to}`,
      ),
    );
    expect(matrix).toEqual([
      'queued→running',
      'queued→blocked',
      'queued→cancelled',
      'running→waiting',
      'running→retrying',
      'running→paused',
      'running→blocked',
      'running→failed',
      'running→completed',
      'running→cancelled',
      'waiting→running',
      'waiting→retrying',
      'waiting→paused',
      'waiting→blocked',
      'waiting→failed',
      'waiting→cancelled',
      'retrying→running',
      'retrying→waiting',
      'retrying→paused',
      'retrying→blocked',
      'retrying→failed',
      'retrying→cancelled',
      'paused→running',
      'paused→blocked',
      'paused→cancelled',
      'blocked→running',
      'blocked→cancelled',
      'failed→running',
      'failed→cancelled',
    ]);
  });
});
