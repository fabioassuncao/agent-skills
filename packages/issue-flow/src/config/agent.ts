import { setTrackedOrigins } from '../agents/origins.js';
import { agentConfigInputSchema, parsePhasesInput } from '../agents/schemas.js';
import type {
  AgentBlock,
  AgentCliOverrides,
  AgentConfig,
  AgentOrigin,
  AgentPhase,
  AgentProviderId,
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
} from '../agents/types.js';
import { AGENT_PHASES, isAgentProviderId } from '../agents/types.js';
import { printWarning } from '../ui/logger.js';
import { mergeConfigLayers, parseBooleanEnv } from './layers.js';
import {
  GLOBAL_CONFIG_FILENAME,
  loadGlobalConfig,
  PROJECT_CONFIG_FILENAME,
  readProjectConfigFile,
} from './sources.js';

export type { AgentCliOverrides, AgentConfig };

let agentCliOverrides: AgentCliOverrides = {};
let cachedAgentConfig: AgentConfig | undefined;

export function setAgentCliOverrides(overrides: AgentCliOverrides): void {
  agentCliOverrides = overrides;
  cachedAgentConfig = undefined;
}

export function getAgentCliOverrides(): AgentCliOverrides {
  return agentCliOverrides;
}

export interface LoadAgentConfigOptions {
  cli?: AgentCliOverrides;
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  globalRoot?: string;
  warn?: (message: string) => void;
}

function readAgentEnv(env: NodeJS.ProcessEnv, warn: (message: string) => void): AgentCliOverrides {
  const layer: AgentCliOverrides = {};
  if (env.ISSUE_FLOW_AGENT !== undefined) {
    if (isAgentProviderId(env.ISSUE_FLOW_AGENT)) {
      layer.provider = env.ISSUE_FLOW_AGENT;
    } else {
      warn(
        `Ignoring ISSUE_FLOW_AGENT="${env.ISSUE_FLOW_AGENT}": expected claude, codex, cursor or antigravity.`,
      );
    }
  }
  if (env.ISSUE_FLOW_AGENT_MODEL !== undefined && env.ISSUE_FLOW_AGENT_MODEL !== '') {
    layer.model = env.ISSUE_FLOW_AGENT_MODEL;
  }
  const codex: CodexSettings = {};
  if (env.ISSUE_FLOW_CODEX_SANDBOX !== undefined) {
    if (
      env.ISSUE_FLOW_CODEX_SANDBOX === 'read-only' ||
      env.ISSUE_FLOW_CODEX_SANDBOX === 'workspace-write' ||
      env.ISSUE_FLOW_CODEX_SANDBOX === 'danger-full-access'
    ) {
      codex.sandbox = env.ISSUE_FLOW_CODEX_SANDBOX;
    } else {
      warn(`Ignoring ISSUE_FLOW_CODEX_SANDBOX="${env.ISSUE_FLOW_CODEX_SANDBOX}".`);
    }
  }
  if (env.ISSUE_FLOW_CODEX_REASONING_EFFORT !== undefined) {
    const effort = env.ISSUE_FLOW_CODEX_REASONING_EFFORT;
    if (
      effort === 'minimal' ||
      effort === 'low' ||
      effort === 'medium' ||
      effort === 'high' ||
      effort === 'xhigh'
    ) {
      codex.reasoningEffort = effort;
    } else {
      warn(`Ignoring ISSUE_FLOW_CODEX_REASONING_EFFORT="${effort}".`);
    }
  }
  if (env.ISSUE_FLOW_CODEX_IGNORE_USER_CONFIG !== undefined) {
    codex.ignoreUserConfig = parseBooleanEnv(env.ISSUE_FLOW_CODEX_IGNORE_USER_CONFIG);
  }
  if (Object.keys(codex).length > 0) layer.codex = codex;
  const cursor: CursorSettings = {};
  if (env.ISSUE_FLOW_CURSOR_SANDBOX !== undefined) {
    if (
      env.ISSUE_FLOW_CURSOR_SANDBOX === 'enabled' ||
      env.ISSUE_FLOW_CURSOR_SANDBOX === 'disabled'
    ) {
      cursor.sandbox = env.ISSUE_FLOW_CURSOR_SANDBOX;
    } else {
      warn(`Ignoring ISSUE_FLOW_CURSOR_SANDBOX="${env.ISSUE_FLOW_CURSOR_SANDBOX}".`);
    }
  }
  if (env.ISSUE_FLOW_CURSOR_PERMISSIONS_FILE !== undefined) {
    if (
      env.ISSUE_FLOW_CURSOR_PERMISSIONS_FILE === 'global' ||
      env.ISSUE_FLOW_CURSOR_PERMISSIONS_FILE === 'project' ||
      env.ISSUE_FLOW_CURSOR_PERMISSIONS_FILE === 'none'
    ) {
      cursor.permissionsFile = env.ISSUE_FLOW_CURSOR_PERMISSIONS_FILE;
    } else {
      warn(
        `Ignoring ISSUE_FLOW_CURSOR_PERMISSIONS_FILE="${env.ISSUE_FLOW_CURSOR_PERMISSIONS_FILE}".`,
      );
    }
  }
  if (Object.keys(cursor).length > 0) layer.cursor = cursor;
  const antigravity: AntigravitySettings = {};
  if (env.ISSUE_FLOW_ANTIGRAVITY_EFFORT !== undefined) {
    const effort = env.ISSUE_FLOW_ANTIGRAVITY_EFFORT;
    if (effort === 'low' || effort === 'medium' || effort === 'high') {
      antigravity.effort = effort;
    } else {
      warn(`Ignoring ISSUE_FLOW_ANTIGRAVITY_EFFORT="${effort}".`);
    }
  }
  if (env.ISSUE_FLOW_ANTIGRAVITY_SANDBOX !== undefined) {
    antigravity.sandbox = parseBooleanEnv(env.ISSUE_FLOW_ANTIGRAVITY_SANDBOX);
  }
  if (env.ISSUE_FLOW_ANTIGRAVITY_EXECUTE_TIMEOUT !== undefined) {
    antigravity.executeTimeout = env.ISSUE_FLOW_ANTIGRAVITY_EXECUTE_TIMEOUT;
  }
  if (Object.keys(antigravity).length > 0) layer.antigravity = antigravity;
  return layer;
}

function readAgentKey(
  raw: unknown,
  label: string,
  warn: (message: string) => void,
): AgentCliOverrides {
  if (raw === undefined) return {};
  const parsed = agentConfigInputSchema.safeParse(raw);
  if (!parsed.success) {
    warn(
      `Ignoring "agent" key of ${label}: ${parsed.error.issues[0]?.message ?? 'invalid value'}.`,
    );
    return {};
  }
  const phases = parsePhasesInput(
    raw !== null && typeof raw === 'object' && 'phases' in raw
      ? (raw as { phases?: unknown }).phases
      : undefined,
    warn,
  );
  return {
    ...(parsed.data.provider !== undefined ? { provider: parsed.data.provider } : {}),
    ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
    ...(parsed.data.claude !== undefined ? { claude: parsed.data.claude } : {}),
    ...(parsed.data.codex !== undefined ? { codex: parsed.data.codex } : {}),
    ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
    ...(parsed.data.antigravity !== undefined ? { antigravity: parsed.data.antigravity } : {}),
    ...(Object.keys(phases).length > 0 ? { phases } : {}),
  };
}

function pickOrigin(layers: Array<{ origin: AgentOrigin; value: unknown }>): AgentOrigin {
  let current: AgentOrigin = 'default';
  for (const layer of layers) {
    if (layer.value !== undefined) current = layer.origin;
  }
  return current;
}

type TrackedPhaseOrigins = Partial<
  Record<AgentPhase, { provider?: AgentOrigin; model?: AgentOrigin }>
>;

function mergeAgentBlockLayers(
  layers: Array<{ origin: AgentOrigin; block: AgentBlock | undefined }>,
): AgentBlock | undefined {
  let merged: AgentBlock = {};
  let any = false;
  for (const layer of layers) {
    if (layer.block === undefined) continue;
    any = true;
    merged = {
      ...merged,
      ...dropUndefinedBlock(layer.block),
      claude: { ...merged.claude, ...layer.block.claude },
      codex: { ...merged.codex, ...layer.block.codex },
      cursor: { ...merged.cursor, ...layer.block.cursor },
      antigravity: { ...merged.antigravity, ...layer.block.antigravity },
    };
  }
  return any ? merged : undefined;
}

function dropUndefinedBlock(block: AgentBlock): AgentBlock {
  const result: AgentBlock = {};
  if (block.provider !== undefined) result.provider = block.provider;
  if (block.model !== undefined) result.model = block.model;
  if (block.claude !== undefined) result.claude = block.claude;
  if (block.codex !== undefined) result.codex = block.codex;
  if (block.cursor !== undefined) result.cursor = block.cursor;
  if (block.antigravity !== undefined) result.antigravity = block.antigravity;
  return result;
}

/**
 * Resolve the `agent` key with the documented precedence:
 *
 *   default(claude) < ~/.issue-flow/config.json < .issue-flow.json
 *     < ISSUE_FLOW_* < CLI
 *
 * Nested `phases` and `codex`/`claude` are merged key by key so a project's
 * `phases.plan` cannot erase a global `phases.review`. Invalid values warn
 * and degrade; nothing throws.
 */
export async function loadAgentConfig(options: LoadAgentConfigOptions = {}): Promise<AgentConfig> {
  const canCache =
    options.cli === undefined &&
    options.env === undefined &&
    options.projectRoot === undefined &&
    options.globalRoot === undefined &&
    options.warn === undefined;
  if (canCache && cachedAgentConfig !== undefined) return cachedAgentConfig;

  const warn = options.warn ?? printWarning;
  const cli = options.cli ?? agentCliOverrides;
  const env = options.env ?? process.env;

  const globalFile = await loadGlobalConfig({
    env,
    globalRoot: options.globalRoot,
    warn,
  });
  const globalLayer = readAgentKey(globalFile.agent, GLOBAL_CONFIG_FILENAME, warn);

  const projectFile = await readProjectConfigFile(options.projectRoot, warn);
  const projectLayer = readAgentKey(projectFile?.agent, PROJECT_CONFIG_FILENAME, warn);
  const envLayer = readAgentEnv(env, warn);

  const provider = (cli.forceProvider ??
    cli.provider ??
    envLayer.provider ??
    projectLayer.provider ??
    globalLayer.provider ??
    'claude') as AgentProviderId;
  const model =
    cli.forceModel ??
    cli.model ??
    envLayer.model ??
    projectLayer.model ??
    globalLayer.model ??
    null;

  const claude = mergeConfigLayers<ClaudeSettings>({
    global: globalLayer.claude,
    project: projectLayer.claude,
    env: envLayer.claude,
    cli: cli.claude,
  });
  const codex = mergeConfigLayers<CodexSettings>({
    global: globalLayer.codex,
    project: projectLayer.codex,
    env: envLayer.codex,
    cli: cli.codex,
  });
  const cursor = mergeConfigLayers<CursorSettings>({
    global: globalLayer.cursor,
    project: projectLayer.cursor,
    env: envLayer.cursor,
    cli: cli.cursor,
  });
  const antigravity = mergeConfigLayers<AntigravitySettings>({
    global: globalLayer.antigravity,
    project: projectLayer.antigravity,
    env: envLayer.antigravity,
    cli: cli.antigravity,
  });

  const phases: AgentConfig['phases'] = {};
  const phaseOrigins: TrackedPhaseOrigins = {};
  for (const phase of AGENT_PHASES) {
    const block = mergeAgentBlockLayers([
      { origin: 'global', block: globalLayer.phases?.[phase] },
      { origin: 'project', block: projectLayer.phases?.[phase] },
      { origin: 'env', block: envLayer.phases?.[phase] },
      { origin: 'cli', block: cli.phases?.[phase] },
    ]);
    if (block && Object.keys(block).length > 0) {
      phases[phase] = block;
      phaseOrigins[phase] = {
        provider:
          block.provider !== undefined
            ? pickOrigin([
                { origin: 'global', value: globalLayer.phases?.[phase]?.provider },
                { origin: 'project', value: projectLayer.phases?.[phase]?.provider },
                { origin: 'env', value: envLayer.phases?.[phase]?.provider },
                { origin: 'cli', value: cli.phases?.[phase]?.provider },
              ])
            : undefined,
        model:
          block.model !== undefined
            ? pickOrigin([
                { origin: 'global', value: globalLayer.phases?.[phase]?.model },
                { origin: 'project', value: projectLayer.phases?.[phase]?.model },
                { origin: 'env', value: envLayer.phases?.[phase]?.model },
                { origin: 'cli', value: cli.phases?.[phase]?.model },
              ])
            : undefined,
      };
    }
  }

  setTrackedOrigins({
    provider: pickOrigin([
      { origin: 'default', value: 'claude' },
      { origin: 'global', value: globalLayer.provider },
      { origin: 'project', value: projectLayer.provider },
      { origin: 'env', value: envLayer.provider },
      { origin: 'cli', value: cli.forceProvider ?? cli.provider },
    ]),
    model: pickOrigin([
      { origin: 'default', value: undefined },
      { origin: 'global', value: globalLayer.model },
      { origin: 'project', value: projectLayer.model },
      { origin: 'env', value: envLayer.model },
      { origin: 'cli', value: cli.forceModel ?? cli.model },
    ]),
    phases: phaseOrigins,
  });

  const resolved = { provider, model, claude, codex, cursor, antigravity, phases };
  if (canCache) cachedAgentConfig = resolved;
  return resolved;
}
