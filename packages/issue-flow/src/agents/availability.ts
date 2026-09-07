import { execa } from 'execa';
import { interpretOpenCodeAuth } from './opencode.js';
import { ensureRunnersRegistered, runnerFor } from './registry.js';
import { resolveAgentFor } from './resolve.js';
import { AGENT_PROVIDER_IDS, type AgentPhase, type AgentProviderId } from './types.js';

export const READINESS_SCHEMA_VERSION = '1';
export const DEFAULT_READINESS_TTL_MS = 5 * 60_000;

export type ReadinessState = 'ready' | 'conditional' | 'unavailable';
export type AuthenticationState = 'confirmed' | 'failed' | 'unverified';
export type ProbeConfidence = 'confirmed' | 'inferred' | 'unknown';
export type ReadinessSource =
  | 'probe'
  | 'config'
  | 'successful-run'
  | 'failure-history'
  | 'static-catalog';

export interface ModelReadiness {
  id: string | null;
  access: 'accessible' | 'denied' | 'unverified';
  confidence: ProbeConfidence;
  source: ReadinessSource;
}

export interface ProviderReadiness {
  provider: AgentProviderId;
  harness: string;
  installed: boolean;
  authentication: AuthenticationState;
  state: ReadinessState;
  models: ModelReadiness[];
  version: string | null;
  detail: string;
  observedAt: string;
  expiresAt: string;
  source: ReadinessSource;
  cooldownUntil: string | null;
}

export interface ReadinessSnapshot {
  schemaVersion: typeof READINESS_SCHEMA_VERSION;
  observedAt: string;
  expiresAt: string;
  providers: Record<AgentProviderId, ProviderReadiness>;
}

export interface AgentAvailability {
  id: AgentProviderId;
  installed: boolean;
  version: string | null;
  authentication: AuthenticationState;
  state: ReadinessState;
  detail: string;
  observedAt: string;
  expiresAt: string;
  source: ReadinessSource;
  cooldownUntil: string | null;
}

const PROVIDER_HARNESS: Record<AgentProviderId, string> = {
  claude: 'claude-code',
  codex: 'codex-cli',
  cursor: 'cursor-cli',
  antigravity: 'antigravity-cli',
  opencode: 'opencode-cli',
};

const ALL_PROVIDERS: readonly AgentProviderId[] = AGENT_PROVIDER_IDS;

const probeCache = new Map<AgentProviderId, Promise<AgentAvailability>>();
let inventoryCache: { expiresAtMs: number; promise: Promise<ReadinessSnapshot> } | null = null;

export function clearAvailabilityCache(): void {
  probeCache.clear();
  inventoryCache = null;
}

export function harnessForProvider(provider: AgentProviderId): string {
  return PROVIDER_HARNESS[provider];
}

export function providerForHarness(harness: string): AgentProviderId | null {
  const entry = (Object.entries(PROVIDER_HARNESS) as [AgentProviderId, string][]).find(
    ([, value]) => value === harness,
  );
  return entry?.[0] ?? null;
}

function deriveState(
  installed: boolean,
  authentication: AuthenticationState,
  cooldownUntil: string | null,
  nowMs: number,
): ReadinessState {
  if (!installed) return 'unavailable';
  if (cooldownUntil !== null && Date.parse(cooldownUntil) > nowMs) return 'unavailable';
  if (authentication === 'failed') return 'unavailable';
  if (authentication === 'unverified') return 'conditional';
  return 'ready';
}

function toAvailability(readiness: ProviderReadiness): AgentAvailability {
  return {
    id: readiness.provider,
    installed: readiness.installed,
    version: readiness.version,
    authentication: readiness.authentication,
    state: readiness.state,
    detail: readiness.detail,
    observedAt: readiness.observedAt,
    expiresAt: readiness.expiresAt,
    source: readiness.source,
    cooldownUntil: readiness.cooldownUntil,
  };
}

export async function probeAgent(id: AgentProviderId): Promise<AgentAvailability> {
  const cached = probeCache.get(id);
  if (cached) return cached;
  const pending = probeAgentUncached(id).then(toAvailability);
  probeCache.set(id, pending);
  return pending;
}

async function probeAgentUncached(
  id: AgentProviderId,
  options: { now?: () => Date; ttlMs?: number; cooldownUntil?: string | null } = {},
): Promise<ProviderReadiness> {
  ensureRunnersRegistered();
  const runner = runnerFor(id);
  const now = options.now?.() ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_READINESS_TTL_MS;
  const observedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const cooldownUntil = options.cooldownUntil ?? null;

  let version: string | null = null;
  let installed = false;
  try {
    const { command, args } = runner.versionCommand();
    const proc = await execa(command, args, { reject: false, timeout: 10_000 });
    installed = proc.exitCode === 0;
    version = installed ? proc.stdout?.toString().trim() || 'unknown' : null;
  } catch {
    installed = false;
  }

  let authentication: AuthenticationState = installed ? 'unverified' : 'failed';
  let detail = installed ? (version ?? 'installed') : 'not found';
  let source: ReadinessSource = 'probe';

  if (!installed) {
    authentication = 'failed';
    detail = 'not found';
  } else if (runner.authCommand && runner.capabilities.authProbe !== 'none') {
    try {
      const { command, args } = runner.authCommand();
      const auth = await execa(command, args, { reject: false, timeout: 10_000 });
      const text = `${auth.stdout?.toString() ?? ''}\n${auth.stderr?.toString() ?? ''}`;
      const ok =
        runner.capabilities.authProbe === 'text'
          ? id === 'opencode'
            ? interpretOpenCodeAuth(text)
            : !/not logged in|not authenticated|no models available/i.test(text)
          : auth.exitCode === 0;
      authentication = ok ? 'confirmed' : 'failed';
      detail = ok ? `${version} (authenticated)` : `${version} (not authenticated)`;
    } catch {
      authentication = 'failed';
      detail = `${version} (not authenticated)`;
    }
  } else {
    // authProbe: 'none' — installation is not authentication.
    authentication = 'unverified';
    detail = `${version} (auth unverified)`;
    source = 'probe';
  }

  const state = deriveState(installed, authentication, cooldownUntil, now.getTime());
  if (
    state === 'unavailable' &&
    cooldownUntil !== null &&
    Date.parse(cooldownUntil) > now.getTime()
  ) {
    detail = `${detail}; cooldown until ${cooldownUntil}`;
  }

  return {
    provider: id,
    harness: PROVIDER_HARNESS[id],
    installed,
    authentication,
    state,
    models: [
      {
        id: null,
        access: installed ? 'unverified' : 'denied',
        confidence: 'unknown',
        source: 'static-catalog',
      },
    ],
    version,
    detail,
    observedAt,
    expiresAt,
    source,
    cooldownUntil,
  };
}

/**
 * Concurrent inventory of every registered harness. Pure consumers (routing)
 * receive this snapshot; they never probe themselves.
 */
export async function probeReadinessInventory(
  options: {
    now?: () => Date;
    ttlMs?: number;
    cooldowns?: Partial<Record<AgentProviderId, string | null>>;
    force?: boolean;
  } = {},
): Promise<ReadinessSnapshot> {
  const now = options.now?.() ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_READINESS_TTL_MS;
  if (!options.force && inventoryCache !== null && inventoryCache.expiresAtMs > now.getTime()) {
    return inventoryCache.promise;
  }

  const promise = (async () => {
    const providers = await Promise.all(
      ALL_PROVIDERS.map((id) =>
        probeAgentUncached(id, {
          now: () => now,
          ttlMs,
          cooldownUntil: options.cooldowns?.[id] ?? null,
        }),
      ),
    );
    const byId = Object.fromEntries(providers.map((entry) => [entry.provider, entry])) as Record<
      AgentProviderId,
      ProviderReadiness
    >;
    for (const entry of providers) {
      probeCache.set(entry.provider, Promise.resolve(toAvailability(entry)));
    }
    return {
      schemaVersion: READINESS_SCHEMA_VERSION,
      observedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      providers: byId,
    } satisfies ReadinessSnapshot;
  })();

  inventoryCache = { expiresAtMs: now.getTime() + ttlMs, promise };
  return promise;
}

export function installHint(id: AgentProviderId): string {
  if (id === 'codex') {
    return 'Install Codex CLI: https://developers.openai.com/codex/noninteractive';
  }
  if (id === 'cursor') {
    return 'Install Cursor CLI: curl https://cursor.com/install -fsS | bash';
  }
  if (id === 'antigravity') {
    return 'Install Antigravity CLI: https://antigravity.google/docs/cli/install/';
  }
  if (id === 'opencode') {
    return 'Install OpenCode CLI: https://opencode.ai/docs';
  }
  return 'Install Claude Code: https://docs.anthropic.com/en/docs/claude-code';
}

/**
 * Fail before a run starts when a configured provider is missing or
 * authentication has failed. Unverified auth (authProbe: none) is allowed —
 * the first real invocation is the confirmation.
 */
export async function assertAgentAvailable(
  phase: AgentPhase,
  providerId?: AgentProviderId,
): Promise<void> {
  const provider = providerId ?? (await resolveAgentFor(phase)).provider;
  const probe = await probeAgent(provider);
  if (!probe.installed || probe.state === 'unavailable') {
    if (!probe.installed) {
      throw new AgentUnavailableError(
        `Phase '${phase}' is configured to use '${provider}', but ${provider} is not installed. ${installHint(provider)}`,
        phase,
        provider,
      );
    }
    if (probe.authentication === 'failed') {
      throw new AgentUnavailableError(
        `Phase '${phase}' is configured to use '${provider}', but ${provider} is not authenticated. ${
          provider === 'codex'
            ? 'Run: codex login --with-api-key  (or set CODEX_API_KEY)'
            : provider === 'cursor'
              ? 'Run: cursor-agent login (or cursor-agent status)'
              : provider === 'antigravity'
                ? 'Antigravity has no auth probe. Log in with `agy` interactively; Issue Flow never reads GEMINI_API_KEY.'
                : provider === 'opencode'
                  ? 'Run: opencode auth login'
                  : 'Run: claude auth login'
        }`,
        phase,
        provider,
      );
    }
    throw new AgentUnavailableError(
      `Phase '${phase}' is configured to use '${provider}', but ${provider} is unavailable (${probe.detail}).`,
      phase,
      provider,
    );
  }
}

export class AgentUnavailableError extends Error {
  readonly phase: AgentPhase;
  readonly provider: AgentProviderId;

  constructor(message: string, phase: AgentPhase, provider: AgentProviderId) {
    super(message);
    this.name = 'AgentUnavailableError';
    this.phase = phase;
    this.provider = provider;
  }
}

/** Synthetic readiness for tests — no I/O. */
export function readinessFixture(
  overrides: Partial<Record<AgentProviderId, Partial<ProviderReadiness>>> = {},
  options: { now?: Date; ttlMs?: number } = {},
): ReadinessSnapshot {
  const now = options.now ?? new Date('2026-08-30T12:00:00.000Z');
  const ttlMs = options.ttlMs ?? DEFAULT_READINESS_TTL_MS;
  const observedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const providers = {} as Record<AgentProviderId, ProviderReadiness>;
  for (const id of ALL_PROVIDERS) {
    const base: ProviderReadiness = {
      provider: id,
      harness: PROVIDER_HARNESS[id],
      installed: true,
      authentication: id === 'claude' || id === 'antigravity' ? 'unverified' : 'confirmed',
      state: id === 'claude' || id === 'antigravity' ? 'conditional' : 'ready',
      models: [{ id: null, access: 'unverified', confidence: 'unknown', source: 'static-catalog' }],
      version: 'test',
      detail: 'fixture',
      observedAt,
      expiresAt,
      source: 'probe',
      cooldownUntil: null,
    };
    const patch = overrides[id];
    providers[id] = patch
      ? {
          ...base,
          ...patch,
          provider: id,
          harness: patch.harness ?? PROVIDER_HARNESS[id],
          state:
            patch.state ??
            deriveState(
              patch.installed ?? base.installed,
              patch.authentication ?? base.authentication,
              patch.cooldownUntil ?? base.cooldownUntil,
              now.getTime(),
            ),
        }
      : base;
  }
  return { schemaVersion: READINESS_SCHEMA_VERSION, observedAt, expiresAt, providers };
}
