import {
  type RoutingConfig,
  type RoutingConfigInput,
  routingConfigInputSchema,
  routingConfigSchema,
} from '../schemas.js';
import { printWarning } from '../ui/logger.js';
import { loadGlobalConfig, PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

let routingCliOverrides: Partial<RoutingConfig> = {};

export function setRoutingCliOverrides(overrides: Partial<RoutingConfig>): void {
  routingCliOverrides = overrides;
}

export async function loadRoutingConfig(
  options: {
    projectRoot?: string;
    globalRoot?: string;
    env?: NodeJS.ProcessEnv;
    global?: RoutingConfigInput;
    warn?: (message: string) => void;
    cli?: RoutingConfigInput;
  } = {},
): Promise<RoutingConfig> {
  const warn = options.warn ?? printWarning;
  const global =
    options.global ??
    (
      await loadGlobalConfig({
        env: options.env ?? process.env,
        ...(options.globalRoot === undefined ? {} : { globalRoot: options.globalRoot }),
        warn,
      })
    ).routing;
  const file = await readProjectConfigFile(options.projectRoot, warn);
  const raw = file?.routing;
  const parsedResult = routingConfigInputSchema.safeParse(raw ?? {});
  if (!parsedResult.success) {
    warn(
      `Ignoring "routing" key of ${PROJECT_CONFIG_FILENAME}: ${parsedResult.error.issues[0]?.message ?? 'invalid value'}.`,
    );
  }
  const project = parsedResult.success ? parsedResult.data : {};
  const cli = options.cli ?? routingCliOverrides;
  const result = routingConfigSchema.safeParse({
    ...global,
    ...project,
    ...cli,
    escalation: {
      ...global?.escalation,
      ...project.escalation,
      ...cli.escalation,
    },
    ceilings: {
      ...global?.ceilings,
      ...project.ceilings,
      ...cli.ceilings,
    },
  });
  if (result.success) return result.data;
  warn(
    `Invalid routing configuration (${result.error.issues[0]?.message ?? 'invalid value'}); using defaults.`,
  );
  return routingConfigSchema.parse({});
}
