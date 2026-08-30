import { RETRY_CONFIG_KEYS, type RetryPolicyOverride } from '../resilience/policy.js';
import {
  type ResilienceConfig,
  type ResilienceRetryConfig,
  resilienceConfigSchema,
} from '../storage/schemas.js';
import { printWarning } from '../ui/logger.js';
import { mergeConfigLayers, parseBooleanEnv, readNumberEnv } from './layers.js';
import { loadGlobalConfig, PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

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
