import type { RunConfig } from '../schemas.js';
import { runConfigSchema } from '../schemas.js';
import { printWarning } from '../ui/logger.js';
import { PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

export interface LoadRunConfigOptions {
  /** Highest-precedence layer: `--auto-close` / `--keep-open`. */
  cli?: Partial<RunConfig>;
  /** Environment source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Directory containing .issue-flow.json. Defaults to the git project root. */
  projectRoot?: string;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
}

function readRunConfigEnv(env: NodeJS.ProcessEnv): Partial<RunConfig> {
  const autoClose = env.ISSUE_FLOW_RUN_AUTO_CLOSE;
  if (autoClose === undefined) return {};
  // Only the two spellings a shell script would use are honoured; anything
  // else goes through the schema below and produces the same warning a bad
  // config file would.
  if (autoClose === '1' || autoClose.toLowerCase() === 'true') return { autoClose: true };
  if (autoClose === '0' || autoClose.toLowerCase() === 'false') return { autoClose: false };
  return { autoClose: autoClose as unknown as boolean };
}

async function readRunConfigFile(
  projectRoot: string | undefined,
  warn: (message: string) => void,
): Promise<Partial<RunConfig>> {
  const file = await readProjectConfigFile(projectRoot, warn);
  const run = file?.run;
  if (run === undefined) return {};

  const result = runConfigSchema.partial().safeParse(run);
  if (!result.success) {
    warn(
      `Ignoring "run" key of ${PROJECT_CONFIG_FILENAME}: ${result.error.issues[0]?.message ?? 'invalid value'}.`,
    );
    return {};
  }
  return result.data;
}

/**
 * Resolve the `run` configuration with the documented precedence:
 * CLI flag > environment variable > .issue-flow.json > defaults.
 *
 * Never throws: an absent, malformed or unknown value degrades to the default
 * (`autoClose: false`) with a warning, so a typo costs a warning rather than
 * leaving a run unable to start.
 */
export async function loadRunConfig(options: LoadRunConfigOptions = {}): Promise<RunConfig> {
  const warn = options.warn ?? printWarning;
  const env = options.env ?? process.env;

  const fileLayer = await readRunConfigFile(options.projectRoot, warn);
  const envLayer = readRunConfigEnv(env);
  const merged = { ...fileLayer, ...envLayer, ...(options.cli ?? {}) };

  const result = runConfigSchema.safeParse(merged);
  if (result.success) return result.data;
  warn(
    `Invalid run configuration (${result.error.issues[0]?.message ?? 'invalid value'}); using defaults.`,
  );
  return runConfigSchema.parse({});
}
