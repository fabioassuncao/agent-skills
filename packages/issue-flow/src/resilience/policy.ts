/**
 * Retry policy: how long to wait, how many times, and what to do when the
 * budget runs out.
 *
 * `errors.ts` answers *what went wrong*; this module answers *what to do about
 * it*. It is pure — no I/O, no clock of its own, no knowledge of phases — so
 * every decision here is reproducible from its arguments. `retry.ts` is the
 * only executor that acts on what this module returns.
 *
 * The run-level state machine lives here too, for the same reason: whether a
 * run may go from `blocked` to `running` is a policy question, and there must
 * be exactly one answer to it in the codebase.
 *
 * The invariants of this layer are in `src/resilience/AGENTS.md`.
 */

import { type FailureKind, requiresHumanAction } from './errors.js';

/* ── the policy ─────────────────────────────────────────────────────────── */

/** What to do with the provider once a kind keeps failing. */
export type FailoverMode = 'never' | 'after_attempts' | 'immediate';

/** What a failure becomes once the attempt budget is spent. */
export type ExhaustedAction = 'fail' | 'block';

export interface RetryPolicy {
  /** `0` means the kind is never retried by this layer. */
  maxAttempts: number;
  initialDelayMs: number;
  /** The ceiling of the backoff — honoured even under `retryForever`. */
  maxDelayMs: number;
  backoffFactor: number;
  jitter: 'none' | 'full';
  retryForever: boolean;
  failover: FailoverMode;
  /** Attempts to burn before `failover: 'after_attempts'` kicks in. */
  failoverAfterAttempts: number;
  onExhausted: ExhaustedAction;
}

/** A partial policy, as a configuration layer supplies it. */
export type RetryPolicyOverride = Partial<RetryPolicy>;

/* ── configuration ──────────────────────────────────────────────────────── */

export type ResilienceProfile = 'default' | 'continuous';

/**
 * The configuration keys of `resilience.retry`, one per `FailureKind` in the
 * camelCase spelling the JSON uses.
 */
export type RetryConfigKey =
  | 'network'
  | 'timeout'
  | 'stalled'
  | 'rateLimit'
  | 'providerDown'
  | 'providerCrash'
  | 'authentication'
  | 'configuration'
  | 'repositoryState'
  | 'taskExecution'
  | 'internal'
  | 'unknown';

const CONFIG_KEYS: Readonly<Record<FailureKind, RetryConfigKey>> = {
  network: 'network',
  timeout: 'timeout',
  stalled: 'stalled',
  rate_limit: 'rateLimit',
  provider_down: 'providerDown',
  provider_crash: 'providerCrash',
  authentication: 'authentication',
  configuration: 'configuration',
  repository_state: 'repositoryState',
  task_execution: 'taskExecution',
  internal: 'internal',
  unknown: 'unknown',
};

/** The configuration key `resilience.retry` uses for `kind`. */
export function retryConfigKey(kind: FailureKind): RetryConfigKey {
  return CONFIG_KEYS[kind];
}

/**
 * Every key `resilience.retry` accepts, for the layers that have to iterate
 * them (the schema in `storage/schemas.ts`, the merge in `config.ts`). Derived
 * from `CONFIG_KEYS` rather than written a second time, so a new `FailureKind`
 * cannot reach the configuration surface half-declared.
 */
export const RETRY_CONFIG_KEYS: readonly RetryConfigKey[] = Object.values(CONFIG_KEYS);

/**
 * The slice of the `resilience` configuration this module reads. The full key
 * (providers, queue, watchdog, journal, decompose) is a superset of this, and
 * satisfies it structurally.
 */
export interface PolicyConfig {
  profile?: ResilienceProfile;
  /**
   * Whether a credential failure may migrate to another provider. Explicit on
   * purpose, never a default: switching provider because the main one lost its
   * credential hides exactly what the user needs to be told.
   */
  failoverOnAuth?: boolean;
  retry?: Partial<Record<RetryConfigKey, RetryPolicyOverride>>;
}

/* ── the defaults ───────────────────────────────────────────────────────── */

const SECOND = 1000;

function policy(overrides: RetryPolicyOverride): RetryPolicy {
  return {
    maxAttempts: 0,
    initialDelayMs: 0,
    maxDelayMs: 0,
    backoffFactor: 2,
    jitter: 'full',
    retryForever: false,
    failover: 'never',
    failoverAfterAttempts: 2,
    onExhausted: 'fail',
    ...overrides,
  };
}

/**
 * The table of the PRD, verbatim. Changing a number here changes documented
 * behaviour: `policy.test.ts` asserts this table cell by cell on purpose.
 */
const BASE_POLICIES: Readonly<Record<FailureKind, RetryPolicy>> = {
  network: policy({ maxAttempts: 8, initialDelayMs: 2 * SECOND, maxDelayMs: 120 * SECOND }),
  timeout: policy({
    maxAttempts: 2,
    initialDelayMs: 30 * SECOND,
    maxDelayMs: 120 * SECOND,
    failover: 'after_attempts',
  }),
  stalled: policy({
    maxAttempts: 2,
    initialDelayMs: 15 * SECOND,
    maxDelayMs: 15 * SECOND,
    failover: 'after_attempts',
  }),
  rate_limit: policy({
    maxAttempts: 6,
    initialDelayMs: 60 * SECOND,
    maxDelayMs: 900 * SECOND,
    failover: 'after_attempts',
  }),
  provider_down: policy({
    maxAttempts: 4,
    initialDelayMs: 10 * SECOND,
    maxDelayMs: 300 * SECOND,
    failover: 'after_attempts',
  }),
  provider_crash: policy({
    maxAttempts: 3,
    initialDelayMs: 5 * SECOND,
    maxDelayMs: 60 * SECOND,
    failover: 'after_attempts',
  }),
  authentication: policy({ maxAttempts: 0, onExhausted: 'block' }),
  configuration: policy({ maxAttempts: 0 }),
  repository_state: policy({ maxAttempts: 0, onExhausted: 'block' }),
  task_execution: policy({ maxAttempts: 0 }),
  internal: policy({ maxAttempts: 2, initialDelayMs: 5 * SECOND, maxDelayMs: 5 * SECOND }),
  unknown: policy({ maxAttempts: 2, initialDelayMs: 5 * SECOND, maxDelayMs: 5 * SECOND }),
};

/**
 * The `continuous` profile — autonomous, long-running execution. It only ever
 * *widens* a budget: what is not retryable under `default` is not retryable
 * here either.
 */
const CONTINUOUS_OVERRIDES: Readonly<Partial<Record<FailureKind, RetryPolicyOverride>>> = {
  network: { retryForever: true },
  timeout: { maxAttempts: 3 },
  stalled: { maxAttempts: 3 },
  rate_limit: { retryForever: true },
  provider_down: { retryForever: true, failover: 'after_attempts' },
  provider_crash: { maxAttempts: 5 },
};

/**
 * Resolve the policy of a `FailureKind`: base table → profile → user
 * configuration, in that order.
 *
 * The kinds that need a human (`authentication`, `configuration`,
 * `repository_state`, `task_execution`) are clamped **after** the user layer:
 * no configuration, no profile and no `retryForever` can buy them an attempt.
 * That clamp is the golden rule of `AGENTS.md` made unbypassable.
 */
export function resolvePolicy(kind: FailureKind, config: PolicyConfig = {}): RetryPolicy {
  const base = BASE_POLICIES[kind];
  const profile = config.profile === 'continuous' ? CONTINUOUS_OVERRIDES[kind] : undefined;
  const user = config.retry?.[retryConfigKey(kind)];

  const resolved: RetryPolicy = { ...base, ...profile, ...user };

  if (!requiresHumanAction(kind)) return sanitize(resolved);

  return sanitize({
    ...resolved,
    maxAttempts: 0,
    retryForever: false,
    failover:
      kind === 'authentication' && config.failoverOnAuth === true ? resolved.failover : 'never',
  });
}

/** Guard against a configuration layer supplying a number that breaks the math. */
function sanitize(value: RetryPolicy): RetryPolicy {
  return {
    ...value,
    maxAttempts: Math.max(0, Math.trunc(value.maxAttempts)),
    initialDelayMs: Math.max(0, value.initialDelayMs),
    maxDelayMs: Math.max(0, value.maxDelayMs),
    backoffFactor: value.backoffFactor >= 1 ? value.backoffFactor : 1,
    failoverAfterAttempts: Math.max(1, Math.trunc(value.failoverAfterAttempts)),
  };
}

/* ── the decisions ──────────────────────────────────────────────────────── */

/**
 * Whether another attempt is allowed after `attemptsMade` attempts have
 * already failed.
 */
export function shouldRetry(policy: RetryPolicy, attemptsMade: number): boolean {
  if (policy.maxAttempts <= 0) return false;
  if (policy.retryForever) return true;
  return attemptsMade < policy.maxAttempts;
}

/** Whether the next attempt should be handed to a different provider. */
export function shouldFailover(policy: RetryPolicy, attemptsMade: number): boolean {
  if (policy.failover === 'never') return false;
  if (policy.failover === 'immediate') return true;
  return attemptsMade >= policy.failoverAfterAttempts;
}

export interface DelayOptions {
  /** Injectable RNG, so the jitter is deterministic under test. */
  random?: () => number;
  /** What the server asked for, when it asked (`Retry-After`). */
  retryAfterMs?: number;
}

/**
 * The delay before attempt number `attemptsMade + 1`.
 *
 * `ceiling = min(maxDelayMs, initialDelayMs * backoffFactor^(attemptsMade-1))`,
 * and full jitter — the default — draws uniformly from `[0, ceiling)`. The
 * ceiling applies under `retryForever` exactly as it does otherwise: waiting
 * forever is allowed, hammering is not.
 *
 * A server-supplied `Retry-After` wins outright, un-jittered and uncapped: the
 * point of honouring it is not to come back before it says, and capping it by
 * `maxDelayMs` would do precisely that.
 */
export function computeDelayMs(
  policy: RetryPolicy,
  attemptsMade: number,
  options: DelayOptions = {},
): number {
  if (options.retryAfterMs !== undefined && options.retryAfterMs >= 0) {
    return Math.round(options.retryAfterMs);
  }

  const exponent = Math.max(0, attemptsMade - 1);
  const growth = policy.initialDelayMs * policy.backoffFactor ** exponent;
  const ceiling = Math.min(policy.maxDelayMs, growth);
  if (ceiling <= 0) return 0;

  if (policy.jitter === 'none') return Math.round(ceiling);

  const random = options.random ?? Math.random;
  return Math.round(random() * ceiling);
}

/* ── the abortable delay ────────────────────────────────────────────────── */

/**
 * Wait `ms`, unless `signal` fires first.
 *
 * Resolves `true` when the full delay elapsed and `false` when it was cut
 * short — a caller that waited fifteen minutes and a caller that was
 * interrupted must not take the same next step. It never throws: an abort is
 * an expected outcome here, not an error.
 */
export function abortableDelay(
  ms: number,
  options: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const { signal } = options;
  if (signal?.aborted === true) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* ── the run state machine ──────────────────────────────────────────────── */

/**
 * The state of a run — a queued issue in `execution-plan.json`, or the single
 * issue of a `tasks.json`.
 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'retrying'
  | 'paused'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled';

/**
 * Every legal transition, in one place.
 *
 * `completed` and `cancelled` are terminal: nothing leaves them. `blocked` has
 * exits, but none the pipeline may take on its own — see `canTransition`.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'blocked', 'cancelled'],
  running: ['waiting', 'retrying', 'paused', 'blocked', 'failed', 'completed', 'cancelled'],
  waiting: ['running', 'retrying', 'paused', 'blocked', 'failed', 'cancelled'],
  retrying: ['running', 'waiting', 'paused', 'blocked', 'failed', 'cancelled'],
  paused: ['running', 'blocked', 'cancelled'],
  blocked: ['running', 'cancelled'],
  failed: ['running', 'cancelled'],
  completed: [],
  cancelled: [],
};

/** Nothing leaves these, by anyone. */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['completed', 'cancelled']);

/** Whether `status` is terminal. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Who is attempting the transition. The pipeline is the default. */
export type TransitionActor = 'pipeline' | 'human';

/**
 * Whether `from → to` is legal for `actor`.
 *
 * `blocked` exists precisely to stop the machine until someone looks at it, so
 * the pipeline may enter it but never leave it: only `actor: 'human'` — a
 * `resume`, a `cancel` — can. A pipeline able to unblock itself would spin on
 * the same missing credential forever.
 */
export function canTransition(
  from: RunStatus,
  to: RunStatus,
  options: { actor?: TransitionActor } = {},
): boolean {
  if (!RUN_TRANSITIONS[from].includes(to)) return false;
  if (from === 'blocked' && (options.actor ?? 'pipeline') !== 'human') return false;
  return true;
}
