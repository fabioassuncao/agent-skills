import { getActiveResilienceConfig } from '../config.js';
import { getShutdownSignal } from '../core/shutdown.js';
import type { FailureKind } from '../resilience/errors.js';
import { abortableDelay, resolvePolicy, shouldFailover } from '../resilience/policy.js';
import type { PlanRepositoryContext } from '../storage/db/repository.js';
import { resolveProjectPaths } from '../storage/resolve.js';
import type { ProviderHealthRecord, ResilienceConfig } from '../storage/schemas.js';
import {
  acquireHalfOpenProbe,
  openProviderCircuit,
  readProvidersHealth,
  resolveProviderHealthConfig,
} from './health.js';
import { ensureRunnersRegistered, getRegisteredProviders } from './registry.js';
import { resolveAgentFor } from './resolve.js';
import {
  type AgentPhase,
  type AgentProviderId,
  isAgentProviderId,
  type ResolvedAgentSettings,
} from './types.js';

export interface AgentSelection {
  primary: AgentProviderId;
  provider: AgentProviderId;
  settings: ResolvedAgentSettings;
  health: PlanRepositoryContext | null;
  failover: boolean;
  reason: FailureKind | null;
  cooldownUntil: string | null;
}

export class AgentSelectionBlockedError extends Error {
  readonly provider: AgentProviderId;
  readonly kind: FailureKind;

  constructor(provider: AgentProviderId, kind: FailureKind) {
    super(
      `Authentication failed for agent provider '${provider}' (${kind}); the run is blocked. Authenticate or repair that provider before resuming.`,
    );
    this.name = 'AgentSelectionBlockedError';
    this.provider = provider;
    this.kind = kind;
  }
}

interface CandidateVerdict {
  available: boolean;
  waitMs: number | null;
  cooldownUntil: string | null;
  reason: FailureKind | null;
  blocked: boolean;
}

function remainingMs(until: string | null, nowMs: number): number | null {
  if (until === null) return null;
  const parsed = Date.parse(until);
  return Number.isFinite(parsed) ? Math.max(0, parsed - nowMs) : null;
}

function failoverIsDue(
  record: ProviderHealthRecord | undefined,
  config: ResilienceConfig,
): boolean {
  if (record?.lastFailureKind == null) return false;
  return shouldFailover(resolvePolicy(record.lastFailureKind, config), record.consecutiveFailures);
}

async function verdictFor(
  provider: AgentProviderId,
  record: ProviderHealthRecord | undefined,
  options: {
    health: PlanRepositoryContext;
    config: ResilienceConfig;
    primary: boolean;
    nowMs: number;
  },
): Promise<CandidateVerdict> {
  if (record === undefined || record.status === 'healthy') {
    return { available: true, waitMs: null, cooldownUntil: null, reason: null, blocked: false };
  }

  const reason = record.lastFailureKind;
  if (record.status === 'auth_failed') {
    const mayFailover = reason !== null && failoverIsDue(record, options.config);
    return {
      available: false,
      waitMs: null,
      cooldownUntil: null,
      reason,
      blocked: options.primary && !mayFailover,
    };
  }

  if (record.status === 'degraded') {
    const due = failoverIsDue(record, options.config);
    const opened = due
      ? await openProviderCircuit(options.health, provider, {
          now: () => options.nowMs,
          config: options.config.providers,
        })
      : record;
    return {
      available: !due,
      waitMs: due ? remainingMs(opened.cooldownUntil, options.nowMs) : null,
      cooldownUntil: opened.cooldownUntil,
      reason,
      blocked: false,
    };
  }

  // `half_open` joins the two closed states on purpose: `acquireHalfOpenProbe`
  // is the only place that knows a probe went stale, and a record left
  // `probeInFlight` by a SIGKILLed run is otherwise never reclaimed — the next
  // run just waits on a cooldown that never ends.
  if (
    record.status === 'unavailable' ||
    record.status === 'rate_limited' ||
    record.status === 'half_open'
  ) {
    const waitMs = remainingMs(record.cooldownUntil, options.nowMs);
    if (waitMs !== null && waitMs > 0) {
      return {
        available: false,
        waitMs,
        cooldownUntil: record.cooldownUntil,
        reason,
        blocked: false,
      };
    }
    const probe = await acquireHalfOpenProbe(options.health, provider, {
      now: () => options.nowMs,
      config: options.config.providers,
    });
    return {
      available: probe.acquired,
      waitMs: probe.acquired
        ? null
        : resolveProviderHealthConfig(options.config.providers).cooldownMs,
      cooldownUntil: probe.record.cooldownUntil,
      reason,
      blocked: false,
    };
  }

  return { available: true, waitMs: null, cooldownUntil: null, reason, blocked: false };
}

function providerOrder(primary: AgentProviderId, config: ResilienceConfig): AgentProviderId[] {
  ensureRunnersRegistered();
  const registered = getRegisteredProviders();
  const configured = (config.providers?.chain ?? []).filter(isAgentProviderId);
  return [...new Set([primary, ...configured, ...registered])];
}

function settingsFor(
  base: ResolvedAgentSettings,
  provider: AgentProviderId,
): ResolvedAgentSettings {
  if (provider === base.provider) return base;
  return {
    ...base,
    provider,
    // A model name belongs to the configured primary unless the selected
    // provider is that primary. Passing a Claude alias to Codex (or vice
    // versa) is less useful than letting the fallback use its own default.
    model: null,
  };
}

/**
 * Select one provider. When every provider is cooling down, wait for the
 * earliest circuit instead of turning a temporary absence into a failed run.
 */
export async function selectAgentForInvocation(
  phase: AgentPhase,
  options: {
    config?: ResilienceConfig;
    now?: () => number;
    delay?: (ms: number, options: { signal?: AbortSignal }) => Promise<boolean>;
  } = {},
): Promise<AgentSelection> {
  const config = options.config ?? getActiveResilienceConfig();
  const base = await resolveAgentFor(phase);
  const failover = config.providers?.failover === true;
  if (!failover) {
    return {
      primary: base.provider,
      provider: base.provider,
      settings: base,
      health: null,
      failover: false,
      reason: null,
      cooldownUntil: null,
    };
  }

  let health: PlanRepositoryContext;
  try {
    health = (await resolveProjectPaths()).providerHealthContext;
  } catch {
    return {
      primary: base.provider,
      provider: base.provider,
      settings: base,
      health: null,
      failover: true,
      reason: null,
      cooldownUntil: null,
    };
  }

  const delay = options.delay ?? abortableDelay;
  selection: for (;;) {
    const nowMs = options.now?.() ?? Date.now();
    const providerHealth = await readProvidersHealth(health);
    const waits: number[] = [];
    let primaryReason: FailureKind | null = null;
    let primaryCooldown: string | null = null;

    for (const provider of providerOrder(base.provider, config)) {
      const verdict = await verdictFor(provider, providerHealth.providers[provider], {
        health,
        config,
        primary: provider === base.provider,
        nowMs,
      });
      if (provider === base.provider) {
        primaryReason = verdict.reason;
        primaryCooldown = verdict.cooldownUntil;
      }
      if (verdict.blocked && verdict.reason !== null) {
        throw new AgentSelectionBlockedError(provider, verdict.reason);
      }
      if (
        provider === base.provider &&
        !verdict.available &&
        verdict.waitMs !== null &&
        !failoverIsDue(providerHealth.providers[provider], config)
      ) {
        if (!(await delay(Math.max(1, verdict.waitMs), { signal: getShutdownSignal() }))) {
          throw new Error('Agent provider selection was interrupted while waiting for cooldown.');
        }
        continue selection;
      }
      if (verdict.available) {
        return {
          primary: base.provider,
          provider,
          settings: settingsFor(base, provider),
          health,
          failover: provider !== base.provider,
          reason: provider === base.provider ? null : primaryReason,
          cooldownUntil: primaryCooldown,
        };
      }
      if (verdict.waitMs !== null) waits.push(verdict.waitMs);
    }

    const waitMs = waits.length > 0 ? Math.max(1, Math.min(...waits)) : null;
    if (waitMs === null) {
      throw new Error(
        'No healthy agent provider is available and none has a cooldown to wait for.',
      );
    }
    if (!(await delay(waitMs, { signal: getShutdownSignal() }))) {
      throw new Error('Agent provider selection was interrupted while waiting for cooldown.');
    }
  }
}
