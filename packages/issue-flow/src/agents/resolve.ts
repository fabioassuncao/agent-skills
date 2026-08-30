import { getTrackedOrigins } from './origins.js';
import {
  AGENT_PHASES,
  type AgentBlock,
  type AgentCliOverrides,
  type AgentConfig,
  type AgentOrigin,
  type AgentPhase,
  type AgentProviderId,
  type ClaudeSettings,
  type CodexSettings,
  isAgentPhase,
  isAgentProviderId,
  type ResolvedAgentSettings,
} from './types.js';

/**
 * Merge two agent blocks key by key. Later wins, and only on keys it
 * actually declares — declaring just `model` keeps the provider.
 */
export function mergeAgentBlocks(base: AgentBlock, overlay: AgentBlock | undefined): AgentBlock {
  if (overlay === undefined) return { ...base };
  return {
    ...base,
    ...dropUndefined(overlay),
    claude: { ...base.claude, ...dropUndefined(overlay.claude ?? {}) },
    codex: { ...base.codex, ...dropUndefined(overlay.codex ?? {}) },
  };
}

function dropUndefined<T extends object>(value: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item;
  }
  return result as Partial<T>;
}

export interface ResolveAgentOptions {
  config?: AgentConfig;
  cli?: AgentCliOverrides;
}

/**
 * Resolve the agent that will run `phase`.
 *
 *   1. default block climbs the five-layer ladder
 *   2. the phase block climbs the same ladder, key by key
 *   3. phase overlays default only on the keys it declares
 *   4. `--agent` / `--agent-model` without a phase overwrite everything
 */
export async function resolveAgentFor(
  phase: AgentPhase,
  options: ResolveAgentOptions = {},
): Promise<ResolvedAgentSettings> {
  const { getAgentCliOverrides, loadAgentConfig } = await import('../config.js');
  const config = options.config ?? (await loadAgentConfig());
  const cli = options.cli ?? getAgentCliOverrides();

  const defaultBlock: AgentBlock = {
    provider: config.provider,
    model: config.model,
    claude: config.claude,
    codex: config.codex,
  };

  const phaseBlock = mergeAgentBlocks(config.phases[phase] ?? {}, cli.phases?.[phase]);
  const merged = mergeAgentBlocks(defaultBlock, phaseBlock);

  const inspected = await inspectAgentResolution(phase, config, cli);

  let provider = (merged.provider ?? 'claude') as AgentProviderId;
  let model = merged.model ?? null;
  let providerOrigin = inspected.providerOrigin;
  let modelOrigin = inspected.modelOrigin;

  if (cli?.forceProvider !== undefined) {
    provider = cli.forceProvider;
    providerOrigin = 'cli';
  }
  if (cli?.forceModel !== undefined) {
    model = cli.forceModel;
    modelOrigin = 'cli';
  }

  return {
    provider,
    model,
    claude: merged.claude ?? {},
    codex: merged.codex ?? {},
    origin: { provider: providerOrigin, model: modelOrigin },
  };
}

export interface InspectedPhase {
  provider: AgentProviderId;
  model: string | null;
  providerOrigin: AgentOrigin;
  modelOrigin: AgentOrigin;
  claude: ClaudeSettings;
  codex: CodexSettings;
}

/**
 * Recover provenance after the layers have been merged.
 *
 * `loadAgentConfig` already applied precedence. This function labels each
 * winning value by asking the inspector that `loadAgentConfig` fills in.
 * When called with a pre-built config (tests), origins degrade to
 * `default` / `project` based on whether the value differs from the baked
 * default — good enough for unit tests that pass an explicit config.
 */
export async function inspectAgentResolution(
  phase: AgentPhase,
  config: AgentConfig,
  cli?: AgentCliOverrides,
): Promise<InspectedPhase> {
  const overlay = config.phases[phase];
  const provider = overlay?.provider ?? config.provider;
  const model = overlay?.model !== undefined ? overlay.model : config.model;

  let providerOrigin: AgentOrigin =
    provider === 'claude' && overlay?.provider === undefined ? 'default' : 'project';
  let modelOrigin: AgentOrigin =
    model === null && overlay?.model === undefined ? 'default' : 'project';

  const tracked = getTrackedOrigins();
  if (tracked) {
    providerOrigin =
      overlay?.provider !== undefined
        ? (tracked.phases[phase]?.provider ?? tracked.provider)
        : tracked.provider;
    modelOrigin =
      overlay?.model !== undefined
        ? (tracked.phases[phase]?.model ?? tracked.model)
        : tracked.model;
  }

  if (cli?.forceProvider !== undefined) providerOrigin = 'cli';
  if (cli?.forceModel !== undefined) modelOrigin = 'cli';

  return {
    provider,
    model,
    providerOrigin,
    modelOrigin,
    claude: { ...config.claude, ...overlay?.claude },
    codex: { ...config.codex, ...overlay?.codex },
  };
}

export function parseAgentPhaseFlag(value: string): { phase: AgentPhase; block: AgentBlock } {
  const eq = value.indexOf('=');
  if (eq <= 0) {
    throw new Error(
      `Invalid --agent-phase value "${value}". Expected <phase>=<provider>[:<model>].`,
    );
  }
  const phase = value.slice(0, eq);
  const rest = value.slice(eq + 1);
  if (!isAgentPhase(phase)) {
    throw new Error(
      `Unknown agent phase "${phase}". Valid phases: analyze, generate, prd, plan, execute, review, pr, pr-review.`,
    );
  }
  const [providerRaw, ...modelParts] = rest.split(':');
  if (!providerRaw || !isAgentProviderId(providerRaw)) {
    throw new Error(
      `Unknown agent provider "${providerRaw ?? ''}". Valid providers: claude, codex.`,
    );
  }
  const model = modelParts.length > 0 ? modelParts.join(':') : undefined;
  return {
    phase,
    block: {
      provider: providerRaw,
      ...(model ? { model } : {}),
    },
  };
}

/** Whether any layer other than the baked default has spoken. */
export interface RunAgentSummary {
  /** `misto` when at least one phase differs from the default provider. */
  label: AgentProviderId | 'misto';
  defaultProvider: AgentProviderId;
  defaultModel: string | null;
  byPhase: Record<AgentPhase, { provider: AgentProviderId; model: string | null }>;
}

export async function describeRunAgents(
  phases: readonly AgentPhase[] = AGENT_PHASES,
): Promise<RunAgentSummary> {
  const target = phases.length > 0 ? phases : AGENT_PHASES;
  const byPhase = {} as RunAgentSummary['byPhase'];
  let defaultProvider: AgentProviderId = 'claude';
  let defaultModel: string | null = null;
  const providers = new Set<AgentProviderId>();

  for (const phase of target) {
    const settings = await resolveAgentFor(phase);
    byPhase[phase] = { provider: settings.provider, model: settings.model };
    providers.add(settings.provider);
    if (phase === target[0]) {
      defaultProvider = settings.provider;
      defaultModel = settings.model;
    }
  }

  // The run default is the unscoped provider, not the first phase's overlay.
  const { loadAgentConfig } = await import('../config.js');
  const config = await loadAgentConfig();
  defaultProvider = config.provider;
  defaultModel = config.model;

  return {
    label: providers.size > 1 ? 'misto' : (providers.values().next().value ?? defaultProvider),
    defaultProvider,
    defaultModel,
    byPhase,
  };
}

export function hasExplicitAgentSelection(config: AgentConfig, cli?: AgentCliOverrides): boolean {
  if (cli?.forceProvider !== undefined || cli?.forceModel !== undefined) return true;
  if (cli?.phases && Object.keys(cli.phases).length > 0) return true;
  if (config.provider !== 'claude') return true;
  if (config.model !== null) return true;
  if (Object.keys(config.phases).length > 0) return true;
  if (config.claude.ignoreUserConfig !== undefined) return true;
  if (Object.keys(config.codex).length > 0) return true;
  return false;
}
