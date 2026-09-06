import { type AgentHooksConfig, agentHooksConfigSchema } from '../schemas.js';
import { printWarning } from '../ui/logger.js';
import { parseBooleanEnv } from './layers.js';
import { PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

/**
 * Configuration of the agent lifecycle hooks, on the documented ladder:
 * environment variable > `.issue-flow.json` > default.
 *
 * It is its own section rather than a field of `AgentConfig` because it is not
 * a property of *which* agent runs — it is a property of whether the pipeline
 * may write hook files into the working tree at all, which is a decision about
 * the repository, not about the provider.
 */

export interface LoadAgentHooksConfigOptions {
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  warn?: (message: string) => void;
}

async function readFileLayer(
  projectRoot: string | undefined,
  warn: (message: string) => void,
): Promise<Partial<AgentHooksConfig>> {
  const file = await readProjectConfigFile(projectRoot, warn);
  const agent = file?.agent;
  if (agent === null || typeof agent !== 'object' || Array.isArray(agent)) return {};
  const hooks = (agent as { hooks?: unknown }).hooks;
  if (hooks === undefined) return {};
  const result = agentHooksConfigSchema.partial().safeParse(hooks);
  if (!result.success) {
    warn(
      `Ignoring "agent.hooks" key of ${PROJECT_CONFIG_FILENAME}: ${
        result.error.issues[0]?.message ?? 'invalid value'
      }.`,
    );
    return {};
  }
  return result.data;
}

/** Never throws: an invalid source degrades to the default with a warning. */
export async function loadAgentHooksConfig(
  options: LoadAgentHooksConfigOptions = {},
): Promise<AgentHooksConfig> {
  const warn = options.warn ?? printWarning;
  const env = options.env ?? process.env;
  const fileLayer = await readFileLayer(options.projectRoot, warn);
  const envLayer: Partial<AgentHooksConfig> =
    env.ISSUE_FLOW_AGENT_HOOKS === undefined
      ? {}
      : { enabled: parseBooleanEnv(env.ISSUE_FLOW_AGENT_HOOKS) };

  const result = agentHooksConfigSchema.safeParse({ ...fileLayer, ...envLayer });
  if (result.success) return result.data;
  warn(
    `Invalid agent hook configuration (${
      result.error.issues[0]?.message ?? 'invalid value'
    }); using defaults.`,
  );
  return agentHooksConfigSchema.parse({});
}
