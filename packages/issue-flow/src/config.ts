import { platform } from 'node:os';
import { installHint } from './agents/availability.js';
import { setTrackedOrigins } from './agents/origins.js';
import { runnerFor } from './agents/registry.js';
import { agentConfigInputSchema, parsePhasesInput } from './agents/schemas.js';
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
} from './agents/types.js';
import { AGENT_PHASES, isAgentProviderId } from './agents/types.js';
import { RETRY_CONFIG_KEYS, type RetryPolicyOverride } from './resilience/policy.js';
import {
  type ResilienceConfig,
  type ResilienceRetryConfig,
  resilienceConfigSchema,
} from './storage/schemas.js';
import { printWarning } from './ui/logger.js';
import { run } from './utils/shell.js';
import { DEFAULTS, createConfig, resolvePaths } from './config/engine.js';
import {
  type ConfigLayers,
  mergeConfigLayers,
  parseBooleanEnv,
  readNumberEnv,
} from './config/layers.js';
import {
  GLOBAL_CONFIG_FILENAME,
  type LoadGlobalConfigOptions,
  PROJECT_CONFIG_FILENAME,
  loadGlobalConfig,
  readProjectConfigFile,
} from './config/sources.js';

export { DEFAULTS, createConfig, resolvePaths };
export type { ConfigLayers };
export { mergeConfigLayers };
export {
  GLOBAL_CONFIG_FILENAME,
  type LoadGlobalConfigOptions,
  PROJECT_CONFIG_FILENAME,
  loadGlobalConfig,
};

/** Historical alias kept for the web monitoring call sites. */
export const WEB_CONFIG_FILENAME = PROJECT_CONFIG_FILENAME;

/**
 * Return a platform-appropriate install hint for a given package.
 */
export function getInstallHint(pkg: string): string {
  const os = platform();

  if (os === 'darwin') {
    return `brew install ${pkg}`;
  }
  if (os === 'linux') {
    return `apt install ${pkg}  (or your distro's package manager)`;
  }
  if (os === 'win32') {
    return `winget install ${pkg}  (or choco install ${pkg})`;
  }

  return `install ${pkg} using your system package manager`;
}

/**
 * Validate that required external dependencies are available.
 * Returns an array of error messages (empty if all deps are found).
 */
export async function validateDependencies(): Promise<string[]> {
  const errors: string[] = [];

  // Check git
  const gitResult = await run('git', ['--version']);
  if (gitResult.exitCode !== 0) {
    errors.push(`  - git  (install with: ${getInstallHint('git')})`);
  }

  // Check the agents this run actually selected — never every binary on the
  // machine. An unconfigured run still only needs `claude`, which is the
  // behaviour every release before the agent layer had.
  const agent = await loadAgentConfig();
  const needed = new Set<AgentProviderId>([agent.provider]);
  for (const phase of AGENT_PHASES) {
    const provider = agent.phases[phase]?.provider;
    if (provider !== undefined) needed.add(provider);
  }
  for (const id of needed) {
    // The binary is the runner's, never a guess. Mapping every non-Codex
    // provider to `claude` made preflight demand the wrong CLI for Cursor and
    // pass without `agy` installed for Antigravity.
    const { command, args } = runnerFor(id).versionCommand();
    const result = await run(command, args);
    if (result.exitCode !== 0) {
      errors.push(`  - ${command}  (${installHint(id)})`);
    }
  }

  // Note: jq is NOT required — the TypeScript CLI handles JSON natively

  return errors;
}

export {
  type LoadWebConfigOptions,
  loadWebConfig,
  setWebCliOverrides,
} from './config/web.js';

export {
  setIssuesCliOverrides,
  loadIssuesConfig,
  type LoadIssuesConfigOptions,
} from './config/issues.js';

export {
  loadPrReviewConfig,
  type LoadPrReviewConfigOptions,
} from './config/pr-review.js';

export {
  setPolicyCliOverrides,
  loadPolicyConfig,
  type LoadPolicyConfigOptions,
} from './config/policy.js';

export {
  loadTelemetryConfig,
  type LoadTelemetryConfigOptions,
} from './config/telemetry.js';

// ── Resilience configuration ────────────────────────────────────────────────

/**
 * CLI overrides for the `resilience` key, captured by the preAction hook in
 * cli.ts. Highest-precedence source consumed by loadResilienceConfig().
 */
let resilienceCliOverrides: ResilienceConfig = {};

export function setResilienceCliOverrides(overrides: ResilienceConfig): void {
  resilienceCliOverrides = overrides;
}

export interface LoadResilienceConfigOptions {
  /** CLI flag overrides. Defaults to the values set via setResilienceCliOverrides(). */
  cli?: ResilienceConfig;
  /** Environment source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Pre-read `config.json` layer, so a caller holding it avoids a second read. */
  global?: ResilienceConfig;
  /** Directory holding config.json. Defaults to getGlobalRoot(). */
  globalRoot?: string;
  /** Directory containing .issue-flow.json. Defaults to the git project root. */
  projectRoot?: string;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
}

/**
 * Merge one nested section of the key across the four layers, in the ladder's
 * order, and report **absence as absence**: a section nobody configured comes
 * back `undefined` rather than `{}`, which is what lets an unconfigured
 * `resilience` resolve to an empty object instead of a skeleton of empty ones.
 */
function mergeResilienceSection<T extends object>(
  layers: readonly (Partial<T> | undefined)[],
): Partial<T> | undefined {
  const merged = mergeConfigLayers<T>({
    global: layers[0],
    project: layers[1],
    env: layers[2],
    cli: layers[3],
  });
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * `resilience.retry`, merged per `FailureKind` **and** per field inside each
 * kind: a project file that only raises `network.maxDelayMs` must not erase a
 * `network.retryForever` set machine-wide, nor the other kinds next to it.
 *
 * This is the one place the merge goes deeper than `mergeConfigLayers()` does
 * on its own — the documented shallowness stops at the first nested object, and
 * `retry` is two levels deep by construction.
 */
function mergeResilienceRetry(
  layers: readonly (ResilienceRetryConfig | undefined)[],
): ResilienceRetryConfig | undefined {
  const merged: ResilienceRetryConfig = {};
  for (const key of RETRY_CONFIG_KEYS) {
    const entry = mergeResilienceSection<RetryPolicyOverride>(layers.map((layer) => layer?.[key]));
    if (entry !== undefined) {
      merged[key] = entry;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Validate one layer, degrading a malformed one to "nothing configured". */
function parseResilienceLayer(
  value: unknown,
  origin: string,
  warn: (message: string) => void,
): ResilienceConfig {
  const result = resilienceConfigSchema.safeParse(value);
  if (!result.success) {
    warn(
      `Ignoring "resilience" key of ${origin}: ${result.error.issues[0]?.message ?? 'invalid value'}.`,
    );
    return {};
  }
  return result.data;
}

async function readResilienceConfigFile(
  projectRoot: string | undefined,
  warn: (message: string) => void,
): Promise<ResilienceConfig> {
  const file = await readProjectConfigFile(projectRoot, warn);
  const resilience = file?.resilience;
  if (resilience === undefined) {
    return {};
  }
  return parseResilienceLayer(resilience, PROJECT_CONFIG_FILENAME, warn);
}

/**
 * The `ISSUE_FLOW_RESILIENCE_*` layer.
 *
 * Only the scalar knobs get a variable of their own; the per-kind `retry` table
 * is too shaped for a shell variable, so it travels whole as JSON in
 * `ISSUE_FLOW_RESILIENCE_RETRY`. Everything collected here still goes through
 * the schema afterwards, so a typo warns exactly like a bad config file does.
 */
function readResilienceConfigEnv(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): ResilienceConfig {
  const layer: Record<string, unknown> = {};

  if (env.ISSUE_FLOW_RESILIENCE_PROFILE !== undefined) {
    layer.profile = env.ISSUE_FLOW_RESILIENCE_PROFILE;
  }
  if (env.ISSUE_FLOW_RESILIENCE_FAILOVER_ON_AUTH !== undefined) {
    layer.failoverOnAuth = parseBooleanEnv(env.ISSUE_FLOW_RESILIENCE_FAILOVER_ON_AUTH);
  }

  const retry = env.ISSUE_FLOW_RESILIENCE_RETRY;
  if (retry !== undefined) {
    try {
      layer.retry = JSON.parse(retry);
    } catch {
      warn('Ignoring ISSUE_FLOW_RESILIENCE_RETRY: invalid JSON.');
    }
  }

  const providers: Record<string, unknown> = {};
  if (env.ISSUE_FLOW_RESILIENCE_FAILOVER !== undefined) {
    providers.failover = parseBooleanEnv(env.ISSUE_FLOW_RESILIENCE_FAILOVER);
  }
  if (env.ISSUE_FLOW_RESILIENCE_PROVIDER_CHAIN !== undefined) {
    providers.chain = env.ISSUE_FLOW_RESILIENCE_PROVIDER_CHAIN.split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
  }
  const cooldown = readNumberEnv(env, 'ISSUE_FLOW_RESILIENCE_PROVIDER_COOLDOWN_MS', warn);
  if (cooldown !== undefined) {
    providers.cooldownMs = cooldown;
  }
  const maxCooldown = readNumberEnv(env, 'ISSUE_FLOW_RESILIENCE_PROVIDER_MAX_COOLDOWN_MS', warn);
  if (maxCooldown !== undefined) {
    providers.maxCooldownMs = maxCooldown;
  }
  const failureWindow = readNumberEnv(
    env,
    'ISSUE_FLOW_RESILIENCE_PROVIDER_FAILURE_WINDOW_MS',
    warn,
  );
  if (failureWindow !== undefined) {
    providers.failureWindowMs = failureWindow;
  }
  const failuresToTrip = readNumberEnv(
    env,
    'ISSUE_FLOW_RESILIENCE_PROVIDER_FAILURES_TO_TRIP',
    warn,
  );
  if (failuresToTrip !== undefined) {
    providers.failuresToTrip = failuresToTrip;
  }
  if (Object.keys(providers).length > 0) layer.providers = providers;

  const queue: Record<string, unknown> = {};
  if (env.ISSUE_FLOW_RESILIENCE_ON_ISSUE_FAILURE !== undefined) {
    queue.onIssueFailure = env.ISSUE_FLOW_RESILIENCE_ON_ISSUE_FAILURE;
  }
  const maxIssueAttempts = readNumberEnv(env, 'ISSUE_FLOW_RESILIENCE_MAX_ISSUE_ATTEMPTS', warn);
  if (maxIssueAttempts !== undefined) {
    queue.maxIssueAttempts = maxIssueAttempts;
  }
  if (Object.keys(queue).length > 0) layer.queue = queue;

  const inactivity = readNumberEnv(env, 'ISSUE_FLOW_RESILIENCE_INACTIVITY_TIMEOUT_MS', warn);
  if (inactivity !== undefined) {
    layer.watchdog = { inactivityTimeoutMs: inactivity };
  }

  const journal: Record<string, unknown> = {};
  if (env.ISSUE_FLOW_RESILIENCE_JOURNAL !== undefined) {
    journal.enabled = parseBooleanEnv(env.ISSUE_FLOW_RESILIENCE_JOURNAL);
  }
  const journalBytes = readNumberEnv(env, 'ISSUE_FLOW_RESILIENCE_JOURNAL_MAX_BYTES', warn);
  if (journalBytes !== undefined) {
    journal.maxFileBytes = journalBytes;
  }
  if (Object.keys(journal).length > 0) layer.journal = journal;

  if (env.ISSUE_FLOW_RESILIENCE_AUTO_DECOMPOSE !== undefined) {
    layer.decompose = { auto: parseBooleanEnv(env.ISSUE_FLOW_RESILIENCE_AUTO_DECOMPOSE) };
  }

  if (Object.keys(layer).length === 0) {
    return {};
  }
  return parseResilienceLayer(layer, 'the ISSUE_FLOW_RESILIENCE_* environment', warn);
}

/**
 * Resolve the `resilience` key with the documented precedence:
 * CLI flag > `ISSUE_FLOW_RESILIENCE_*` > `.issue-flow.json` > `config.json` >
 * defaults.
 *
 * **An unconfigured project resolves to `{}`** — not to a skeleton of empty
 * sections, and never to a materialized default. That is the whole contract of
 * this loader: `resolvePolicy(kind, {})` is the base table of the PRD, so
 * "nothing configured" and "the behaviour of every release before this one" are
 * the same object. The defaults of each sub-key belong to the layer that
 * consumes it (`resilience/policy.ts` for `retry`, and one later story each for
 * `providers`, `queue`, `watchdog`, `journal` and `decompose`), never here.
 *
 * Never throws: an absent, malformed or invalid source degrades to "nothing
 * configured" with a warning, key by key.
 */
export async function loadResilienceConfig(
  options: LoadResilienceConfigOptions = {},
): Promise<ResilienceConfig> {
  const warn = options.warn ?? printWarning;
  const env = options.env ?? process.env;
  const cli = options.cli ?? resilienceCliOverrides;

  const globalLayer =
    options.global ??
    (
      await loadGlobalConfig({
        env,
        ...(options.globalRoot === undefined ? {} : { globalRoot: options.globalRoot }),
        warn,
      })
    ).resilience ??
    {};
  const projectLayer = await readResilienceConfigFile(options.projectRoot, warn);
  const envLayer = readResilienceConfigEnv(env, warn);

  const layers = [globalLayer, projectLayer, envLayer, cli] as const;

  const scalars = mergeConfigLayers<Pick<ResilienceConfig, 'profile' | 'failoverOnAuth'>>({
    global: { profile: globalLayer.profile, failoverOnAuth: globalLayer.failoverOnAuth },
    project: { profile: projectLayer.profile, failoverOnAuth: projectLayer.failoverOnAuth },
    env: { profile: envLayer.profile, failoverOnAuth: envLayer.failoverOnAuth },
    cli: { profile: cli.profile, failoverOnAuth: cli.failoverOnAuth },
  });

  const retry = mergeResilienceRetry(layers.map((layer) => layer.retry));
  const providers = mergeResilienceSection(layers.map((layer) => layer.providers));
  const queue = mergeResilienceSection(layers.map((layer) => layer.queue));
  const watchdog = mergeResilienceSection(layers.map((layer) => layer.watchdog));
  const journal = mergeResilienceSection(layers.map((layer) => layer.journal));
  const decompose = mergeResilienceSection(layers.map((layer) => layer.decompose));

  return {
    ...scalars,
    ...(retry === undefined ? {} : { retry }),
    ...(providers === undefined ? {} : { providers }),
    ...(queue === undefined ? {} : { queue }),
    ...(watchdog === undefined ? {} : { watchdog }),
    ...(journal === undefined ? {} : { journal }),
    ...(decompose === undefined ? {} : { decompose }),
  };
}

/**
 * The `resilience` key in force for this process.
 *
 * Read **synchronously**, by call sites that cannot afford four disk reads per
 * `gh` invocation and must not perform I/O of their own — a provider that
 * shelled out to `git` to find its retry budget would be doing exactly the
 * thing this key exists to make survivable.
 *
 * It starts empty on purpose: `{}` is the base table of `resolvePolicy()`, so
 * a process that never installs anything behaves exactly as it did before the
 * key existed. `initResilienceConfig()` is what fills it in, once, from the
 * command that owns the run.
 */
let activeResilienceConfig: ResilienceConfig = {};

/** The key in force. `{}` until a command installs one. */
export function getActiveResilienceConfig(): ResilienceConfig {
  return activeResilienceConfig;
}

/** Install a key directly. For tests, and for a caller that already loaded it. */
export function setActiveResilienceConfig(config: ResilienceConfig): void {
  activeResilienceConfig = config;
}

/**
 * Load the key off the ladder and install it. Never throws: a failed load
 * leaves the base table in place, which is the documented default.
 */
export async function initResilienceConfig(
  options: LoadResilienceConfigOptions = {},
): Promise<ResilienceConfig> {
  try {
    activeResilienceConfig = await loadResilienceConfig(options);
  } catch {
    activeResilienceConfig = {};
  }
  return activeResilienceConfig;
}

// ── Agent configuration ─────────────────────────────────────────────────────

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

export {
  setVerifyCliOverrides,
  loadVerifyConfig,
  type LoadVerifyConfigOptions,
} from './config/verify.js';

export {
  setRoutingCliOverrides,
  loadRoutingConfig,
} from './config/routing.js';

