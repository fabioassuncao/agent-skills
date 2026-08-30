import { type TelemetryConfigInput, telemetryConfigInputSchema } from '../storage/schemas.js';
import { DEFAULT_TELEMETRY_CONFIG, type TelemetryConfig } from '../telemetry/types.js';
import { printWarning } from '../ui/logger.js';
import { mergeConfigLayers, parseBooleanEnv, readNumberEnv } from './layers.js';
import { loadGlobalConfig, PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

export interface LoadTelemetryConfigOptions {
  env?: NodeJS.ProcessEnv;
  global?: TelemetryConfigInput;
  globalRoot?: string;
  projectRoot?: string;
  warn?: (message: string) => void;
}

function parseTelemetryLayer(
  value: unknown,
  source: string,
  warn: (message: string) => void,
): TelemetryConfigInput {
  if (value === undefined) return {};
  const result = telemetryConfigInputSchema.safeParse(value);
  if (result.success) return result.data;
  warn(
    `Ignoring "telemetry" key of ${source}: ${result.error.issues[0]?.message ?? 'invalid value'}.`,
  );
  return {};
}

function readTelemetryEnv(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): TelemetryConfigInput {
  const layer: TelemetryConfigInput = {};
  if (env.ISSUE_FLOW_TELEMETRY !== undefined) {
    layer.enabled = parseBooleanEnv(env.ISSUE_FLOW_TELEMETRY);
  }
  const max = readNumberEnv(env, 'ISSUE_FLOW_TELEMETRY_MAX_EXECUTIONS', warn);
  if (max !== undefined) layer.maxExecutions = max;
  if (env.ISSUE_FLOW_TELEMETRY_ESTIMATE !== undefined) {
    layer.pricing = { estimate: parseBooleanEnv(env.ISSUE_FLOW_TELEMETRY_ESTIMATE) };
  }
  return layer;
}

/**
 * defaults < `config.json` < `.issue-flow.json` < `ISSUE_FLOW_TELEMETRY*`.
 *
 * Nested `pricing` is flattened so a project `estimate` does not erase a
 * global `overrides` map.
 */
export async function loadTelemetryConfig(
  options: LoadTelemetryConfigOptions = {},
): Promise<TelemetryConfig> {
  const warn = options.warn ?? printWarning;
  const env = options.env ?? process.env;
  const globalFile =
    options.global ??
    (
      await loadGlobalConfig({
        env,
        ...(options.globalRoot === undefined ? {} : { globalRoot: options.globalRoot }),
        warn,
      })
    ).telemetry;
  const projectFile = await readProjectConfigFile(options.projectRoot, warn);
  const project = parseTelemetryLayer(projectFile?.telemetry, PROJECT_CONFIG_FILENAME, warn);
  const envLayer = readTelemetryEnv(env, warn);

  const pricing = mergeConfigLayers<TelemetryConfig['pricing']>({
    defaults: DEFAULT_TELEMETRY_CONFIG.pricing,
    global: globalFile?.pricing,
    project: project.pricing,
    env: envLayer.pricing,
  });
  const overrides = {
    ...DEFAULT_TELEMETRY_CONFIG.pricing.overrides,
    ...globalFile?.pricing?.overrides,
    ...project.pricing?.overrides,
    ...envLayer.pricing?.overrides,
  };

  const scalars = mergeConfigLayers<Pick<TelemetryConfig, 'enabled' | 'maxExecutions'>>({
    defaults: {
      enabled: DEFAULT_TELEMETRY_CONFIG.enabled,
      maxExecutions: DEFAULT_TELEMETRY_CONFIG.maxExecutions,
    },
    global: {
      ...(globalFile?.enabled === undefined ? {} : { enabled: globalFile.enabled }),
      ...(globalFile?.maxExecutions === undefined
        ? {}
        : { maxExecutions: globalFile.maxExecutions }),
    },
    project: {
      ...(project.enabled === undefined ? {} : { enabled: project.enabled }),
      ...(project.maxExecutions === undefined ? {} : { maxExecutions: project.maxExecutions }),
    },
    env: {
      ...(envLayer.enabled === undefined ? {} : { enabled: envLayer.enabled }),
      ...(envLayer.maxExecutions === undefined ? {} : { maxExecutions: envLayer.maxExecutions }),
    },
  });

  return {
    enabled: scalars.enabled ?? DEFAULT_TELEMETRY_CONFIG.enabled,
    maxExecutions: scalars.maxExecutions ?? DEFAULT_TELEMETRY_CONFIG.maxExecutions,
    pricing: {
      estimate: pricing.estimate ?? DEFAULT_TELEMETRY_CONFIG.pricing.estimate,
      overrides,
    },
  };
}
