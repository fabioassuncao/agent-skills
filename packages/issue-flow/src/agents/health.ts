import type { ClassifiedFailure, FailureKind } from '../resilience/errors.js';
import type { PlanRepositoryContext } from '../storage/db/repository.js';
import { readStoredProvidersHealth, updateStoredProviderHealth } from '../storage/db/repository.js';
import type {
  ProviderHealthRecord,
  ProvidersHealth,
  ResilienceProvidersConfig,
} from '../storage/schemas.js';

export const DEFAULT_PROVIDER_COOLDOWN_MS = 60_000;
export const DEFAULT_PROVIDER_MAX_COOLDOWN_MS = 30 * 60_000;
export const DEFAULT_PROVIDER_FAILURE_WINDOW_MS = 5 * 60_000;
export const DEFAULT_PROVIDER_FAILURES_TO_TRIP = 3;

export interface ProviderHealthOptions {
  now?: () => number;
  config?: ResilienceProvidersConfig;
}

export interface ResolvedProviderHealthConfig {
  cooldownMs: number;
  maxCooldownMs: number;
  failureWindowMs: number;
  failuresToTrip: number;
}

export function resolveProviderHealthConfig(
  config: ResilienceProvidersConfig = {},
): ResolvedProviderHealthConfig {
  return {
    cooldownMs: Math.max(0, config.cooldownMs ?? DEFAULT_PROVIDER_COOLDOWN_MS),
    maxCooldownMs: Math.max(
      config.cooldownMs ?? DEFAULT_PROVIDER_COOLDOWN_MS,
      config.maxCooldownMs ?? DEFAULT_PROVIDER_MAX_COOLDOWN_MS,
    ),
    failureWindowMs: Math.max(1, config.failureWindowMs ?? DEFAULT_PROVIDER_FAILURE_WINDOW_MS),
    failuresToTrip: Math.max(
      1,
      Math.trunc(config.failuresToTrip ?? DEFAULT_PROVIDER_FAILURES_TO_TRIP),
    ),
  };
}

export async function readProvidersHealth(
  context: PlanRepositoryContext,
): Promise<ProvidersHealth> {
  return readStoredProvidersHealth(context);
}

async function updateRecord(
  context: PlanRepositoryContext,
  provider: string,
  update: (record: ProviderHealthRecord) => ProviderHealthRecord,
): Promise<ProviderHealthRecord> {
  return updateStoredProviderHealth(context, provider, update);
}

function cooldownDelay(level: number, config: ResolvedProviderHealthConfig): number {
  return Math.min(config.maxCooldownMs, config.cooldownMs * 2 ** Math.max(0, level));
}

const BREAKER_KINDS = new Set<FailureKind>([
  'timeout',
  'stalled',
  'provider_down',
  'provider_crash',
]);

export async function recordProviderFailure(
  context: PlanRepositoryContext,
  provider: string,
  failure: ClassifiedFailure,
  options: ProviderHealthOptions = {},
): Promise<ProviderHealthRecord> {
  const nowMs = options.now?.() ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const config = resolveProviderHealthConfig(options.config);

  return updateRecord(context, provider, (record) => {
    const failures = [
      ...record.failures.filter((entry) => {
        const timestamp = Date.parse(entry.at);
        return Number.isFinite(timestamp) && nowMs - timestamp <= config.failureWindowMs;
      }),
      { at, kind: failure.kind },
    ];
    const consecutiveFailures = record.consecutiveFailures + 1;

    if (failure.kind === 'authentication') {
      return {
        ...record,
        status: 'auth_failed',
        failures,
        consecutiveFailures,
        cooldownUntil: null,
        lastFailureKind: failure.kind,
        lastFailureAt: at,
        probeInFlight: false,
        probeStartedAt: null,
      };
    }

    if (failure.kind === 'rate_limit') {
      const delay = failure.retryAfterMs ?? cooldownDelay(record.cooldownLevel, config);
      return {
        ...record,
        status: 'rate_limited',
        failures,
        consecutiveFailures,
        cooldownLevel:
          failure.retryAfterMs === undefined ? record.cooldownLevel + 1 : record.cooldownLevel,
        cooldownUntil: new Date(nowMs + delay).toISOString(),
        lastFailureKind: failure.kind,
        lastFailureAt: at,
        probeInFlight: false,
        probeStartedAt: null,
      };
    }

    if (BREAKER_KINDS.has(failure.kind)) {
      const recentProviderFailures = failures.filter((entry) =>
        BREAKER_KINDS.has(entry.kind),
      ).length;
      const unavailable =
        record.status === 'half_open' || recentProviderFailures >= config.failuresToTrip;
      const delay = unavailable ? cooldownDelay(record.cooldownLevel, config) : 0;
      return {
        ...record,
        status: unavailable ? 'unavailable' : 'degraded',
        failures,
        consecutiveFailures,
        cooldownLevel: unavailable ? record.cooldownLevel + 1 : record.cooldownLevel,
        cooldownUntil: unavailable ? new Date(nowMs + delay).toISOString() : null,
        lastFailureKind: failure.kind,
        lastFailureAt: at,
        probeInFlight: false,
        probeStartedAt: null,
      };
    }

    // Network and task/repository/configuration failures do not describe the
    // provider's health. Keep the breaker state, but retain the diagnosis for
    // audit and dashboard surfaces.
    return {
      ...record,
      lastFailureKind: failure.kind,
      lastFailureAt: at,
      probeInFlight: false,
      probeStartedAt: null,
    };
  });
}

export async function recordProviderSuccess(
  context: PlanRepositoryContext,
  provider: string,
  options: Pick<ProviderHealthOptions, 'now'> = {},
): Promise<ProviderHealthRecord> {
  const at = new Date(options.now?.() ?? Date.now()).toISOString();
  return updateRecord(context, provider, (record) => ({
    ...record,
    status: 'healthy',
    failures: [],
    consecutiveFailures: 0,
    cooldownLevel: 0,
    cooldownUntil: null,
    lastFailureKind: null,
    lastSuccessAt: at,
    probeInFlight: false,
    probeStartedAt: null,
  }));
}

/** Open the circuit when retry policy asks for failover before the trip count. */
export async function openProviderCircuit(
  context: PlanRepositoryContext,
  provider: string,
  options: ProviderHealthOptions = {},
): Promise<ProviderHealthRecord> {
  const nowMs = options.now?.() ?? Date.now();
  const config = resolveProviderHealthConfig(options.config);
  return updateRecord(context, provider, (record) => {
    if (record.status === 'unavailable' || record.status === 'rate_limited') return record;
    const delay = cooldownDelay(record.cooldownLevel, config);
    return {
      ...record,
      status: 'unavailable',
      cooldownLevel: record.cooldownLevel + 1,
      cooldownUntil: new Date(nowMs + delay).toISOString(),
      probeInFlight: false,
      probeStartedAt: null,
    };
  });
}

export interface HalfOpenResult {
  acquired: boolean;
  record: ProviderHealthRecord;
}

/** Atomically enough for the project-level single-run lock: one half-open probe per provider. */
export async function acquireHalfOpenProbe(
  context: PlanRepositoryContext,
  provider: string,
  options: ProviderHealthOptions = {},
): Promise<HalfOpenResult> {
  const nowMs = options.now?.() ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const config = resolveProviderHealthConfig(options.config);
  let acquired = false;
  const record = await updateRecord(context, provider, (current) => {
    const cooldownUntil = current.cooldownUntil === null ? 0 : Date.parse(current.cooldownUntil);
    if (Number.isFinite(cooldownUntil) && cooldownUntil > nowMs) return current;

    const probeStarted = current.probeStartedAt === null ? 0 : Date.parse(current.probeStartedAt);
    const probeIsFresh =
      current.probeInFlight &&
      Number.isFinite(probeStarted) &&
      nowMs - probeStarted < config.cooldownMs;
    if (probeIsFresh) return current;

    acquired = true;
    return {
      ...current,
      status: 'half_open',
      cooldownUntil: null,
      probeInFlight: true,
      probeStartedAt: at,
    };
  });
  return { acquired, record };
}
