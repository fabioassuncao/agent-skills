import {
  DEFAULT_PROFILE_NAME,
  defaultProfiles,
  getDefaultProfileName,
  mergeProfileLayers,
  parseRuntimeProfiles,
  type RuntimeProfile,
} from '../runtime/profiles.js';
import { parseServiceSpecs, type ServiceSpec } from '../runtime/services.js';
import { printWarning } from '../ui/logger.js';
import { PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

/**
 * The `runtime` key of `.issue-flow.json` — profiles, panes and services.
 *
 * Adapted from WebMux `backend/src/adapters/config.ts` @ d8c9d5f (§16, §19). The
 * upstream reads two YAML files (`.webmux.yaml` plus a `.webmux.local.yaml`
 * overlay); this project already has a layered configuration and one project
 * file, so the *ladder* is Issue Flow's and only the *parsing* is the
 * upstream's. Profiles overlay by name across layers exactly as they do
 * upstream, which is what makes a locally declared `sandbox` replace a project
 * one instead of half-merging with it.
 *
 * Precedence, as documented in `docs/configuration.md`:
 *
 * ```text
 * CLI flag > environment variable > .issue-flow.json > built-in defaults
 * ```
 *
 * There is no machine rung, exactly like `web` and `github`: a profile names
 * pane commands and container images that only mean something inside one
 * repository, so a machine-wide default would be a window somebody else's
 * project has to live with.
 *
 * Never throws. An invalid section degrades to the defaults with a warning, and
 * inside a valid one an unusable profile, pane or service is dropped on its own
 * — a typo in a fourth pane must not cost the other three.
 */

export interface RuntimeConfig {
  /** Profile a run opens with when nothing else selects one. */
  profile: string;
  profiles: Record<string, RuntimeProfile>;
  services: ServiceSpec[];
  /** Variables exported into every pane, hook and agent of a worktree. */
  startupEnv: Record<string, string>;
}

/**
 * CLI overrides captured by the preAction hook in cli.ts. Highest-precedence
 * source consumed by loadRuntimeConfig().
 */
let runtimeCliOverrides: Partial<RuntimeConfig> = {};

export function setRuntimeCliOverrides(overrides: Partial<RuntimeConfig>): void {
  runtimeCliOverrides = overrides;
}

export interface LoadRuntimeConfigOptions {
  /** CLI flag overrides. Defaults to the values set via setRuntimeCliOverrides(). */
  cli?: Partial<RuntimeConfig>;
  /** Environment source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Directory containing .issue-flow.json. Defaults to the git project root. */
  projectRoot?: string;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
}

interface RuntimeConfigLayer {
  profile?: string;
  profiles?: Record<string, RuntimeProfile>;
  services?: ServiceSpec[];
  startupEnv?: Record<string, string>;
}

/**
 * Normalise one `startupEnv` entry.
 *
 * The upstream stores `string | boolean` and stringifies at the point of use
 * (`stringifyStartupEnvValue`). One representation is kept instead of two: the
 * file is a shell-consumable env map, everything in it ends up a string, and
 * carrying the boolean further only creates a second place where the conversion
 * could disagree.
 */
function stringifyStartupEnvValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return undefined;
}

export function parseStartupEnv(
  raw: unknown,
  warn: (message: string) => void,
): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const startupEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const stringified = stringifyStartupEnvValue(value);
    if (stringified === undefined) {
      warn(`Ignoring startupEnv entry "${key}": expected a string, number or boolean.`);
      continue;
    }
    startupEnv[key] = stringified;
  }
  return startupEnv;
}

function readRuntimeConfigEnv(env: NodeJS.ProcessEnv): RuntimeConfigLayer {
  const layer: RuntimeConfigLayer = {};
  const profile = env.ISSUE_FLOW_RUNTIME_PROFILE?.trim();
  if (profile !== undefined && profile !== '') layer.profile = profile;
  return layer;
}

async function readRuntimeConfigFile(
  projectRoot: string | undefined,
  warn: (message: string) => void,
): Promise<RuntimeConfigLayer> {
  const file = await readProjectConfigFile(projectRoot, warn);
  const runtime = file?.runtime;
  if (runtime === undefined) return {};

  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) {
    warn(`Ignoring "runtime" key of ${PROJECT_CONFIG_FILENAME}: expected an object.`);
    return {};
  }

  const section = runtime as Record<string, unknown>;
  const profile = typeof section.profile === 'string' ? section.profile.trim() : '';
  return {
    ...(profile === '' ? {} : { profile }),
    // `false`: an absent `profiles` key means "keep the built-in default", not
    // "reset to it" — the layer below already provided it.
    ...(section.profiles === undefined
      ? {}
      : { profiles: parseRuntimeProfiles(section.profiles, false) }),
    ...(section.services === undefined ? {} : { services: parseServiceSpecs(section.services) }),
    ...(section.startupEnv === undefined
      ? {}
      : { startupEnv: parseStartupEnv(section.startupEnv, warn) }),
  };
}

/**
 * Resolve the runtime configuration.
 *
 * The active profile is validated against the resolved map: a name nobody
 * declared falls back to the default with a warning rather than failing, but it
 * warns, because a run that silently used `default` when `sandbox` was asked for
 * is a run whose isolation nobody got.
 */
export async function loadRuntimeConfig(
  options: LoadRuntimeConfigOptions = {},
): Promise<RuntimeConfig> {
  const warn = options.warn ?? printWarning;
  const cli = options.cli ?? runtimeCliOverrides;
  const env = options.env ?? process.env;

  const fileLayer = await readRuntimeConfigFile(options.projectRoot, warn);
  const envLayer = readRuntimeConfigEnv(env);

  const profiles = mergeProfileLayers(
    defaultProfiles(),
    fileLayer.profiles ?? {},
    cli.profiles ?? {},
  );

  const requested = cli.profile ?? envLayer.profile ?? fileLayer.profile;
  let profile = getDefaultProfileName(profiles);
  if (requested !== undefined && requested !== '') {
    if (profiles[requested] !== undefined) {
      profile = requested;
    } else {
      warn(`Unknown runtime profile "${requested}"; using "${profile}".`);
    }
  }

  return {
    profile,
    profiles,
    services: cli.services ?? fileLayer.services ?? [],
    startupEnv: { ...(fileLayer.startupEnv ?? {}), ...(cli.startupEnv ?? {}) },
  };
}

export { DEFAULT_PROFILE_NAME };
