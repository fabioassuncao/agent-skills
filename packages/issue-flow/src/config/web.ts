import type { WebConfig } from '../schemas.js';
import { webConfigSchema } from '../schemas.js';
import { printWarning } from '../ui/logger.js';
import { parseBooleanEnv, readNumberEnv } from './layers.js';
import { PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

/**
 * CLI overrides captured by the preAction hook in cli.ts. Highest-precedence
 * source consumed by loadWebConfig().
 */
let webCliOverrides: Partial<WebConfig> = {};

export function setWebCliOverrides(overrides: Partial<WebConfig>): void {
  webCliOverrides = overrides;
}

export interface LoadWebConfigOptions {
  /** CLI flag overrides. Defaults to the values set via setWebCliOverrides(). */
  cli?: Partial<WebConfig>;
  /** Environment source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Directory containing .issue-flow.json. Defaults to the git project root. */
  projectRoot?: string;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
}

function readWebConfigEnv(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): Partial<WebConfig> {
  const layer: Partial<WebConfig> = {};
  if (env.ISSUE_FLOW_WEB !== undefined) {
    layer.enabled = parseBooleanEnv(env.ISSUE_FLOW_WEB);
  }
  const port = readNumberEnv(env, 'ISSUE_FLOW_WEB_PORT', warn);
  if (port !== undefined) {
    layer.port = port;
  }
  if (env.ISSUE_FLOW_WEB_HOST !== undefined) {
    layer.host = env.ISSUE_FLOW_WEB_HOST;
  }
  const refresh = readNumberEnv(env, 'ISSUE_FLOW_WEB_REFRESH', warn);
  if (refresh !== undefined) {
    layer.refreshSeconds = refresh;
  }
  const logLimit = readNumberEnv(env, 'ISSUE_FLOW_WEB_LOG_LIMIT', warn);
  if (logLimit !== undefined) {
    layer.logLimit = logLimit;
  }
  return layer;
}

async function readWebConfigFile(
  projectRoot: string | undefined,
  warn: (message: string) => void,
): Promise<Partial<WebConfig>> {
  const file = await readProjectConfigFile(projectRoot, warn);
  const web = file?.web;
  if (web === undefined) {
    return {};
  }

  const result = webConfigSchema.partial().safeParse(web);
  if (!result.success) {
    warn(
      `Ignoring "web" key of ${PROJECT_CONFIG_FILENAME}: ${result.error.issues[0]?.message ?? 'invalid value'}.`,
    );
    return {};
  }
  return result.data;
}

/**
 * Resolve the web monitoring configuration with the documented precedence:
 * CLI flag > environment variable > .issue-flow.json > defaults.
 *
 * Never throws: missing or invalid sources degrade to the defaults with a
 * warning.
 */
export async function loadWebConfig(options: LoadWebConfigOptions = {}): Promise<WebConfig> {
  const warn = options.warn ?? printWarning;
  const cli = options.cli ?? webCliOverrides;
  const env = options.env ?? process.env;

  const fileLayer = await readWebConfigFile(options.projectRoot, warn);
  const envLayer = readWebConfigEnv(env, warn);
  const merged = { ...fileLayer, ...envLayer, ...cli };

  const result = webConfigSchema.safeParse(merged);
  if (result.success) {
    return result.data;
  }
  warn(
    `Invalid web monitoring configuration (${result.error.issues[0]?.message ?? 'invalid value'}); using defaults.`,
  );
  return webConfigSchema.parse({});
}
