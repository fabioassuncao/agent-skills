import type { VerifyConfig } from '../schemas.js';
import { verifyConfigSchema } from '../schemas.js';
import { printWarning } from '../ui/logger.js';
import { PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

let verifyCliOverrides: Partial<VerifyConfig> = {};

export function setVerifyCliOverrides(overrides: Partial<VerifyConfig>): void {
  verifyCliOverrides = overrides;
}

export interface LoadVerifyConfigOptions {
  cli?: Partial<VerifyConfig>;
  projectRoot?: string;
  warn?: (message: string) => void;
}

async function readVerifyConfigFile(
  projectRoot: string | undefined,
  warn: (message: string) => void,
): Promise<Partial<VerifyConfig>> {
  const file = await readProjectConfigFile(projectRoot, warn);
  const verify = file?.verify;
  if (verify === undefined) return {};
  const result = verifyConfigSchema.partial().safeParse(verify);
  if (!result.success) {
    warn(
      `Ignoring "verify" key of ${PROJECT_CONFIG_FILENAME}: ${result.error.issues[0]?.message ?? 'invalid value'}.`,
    );
    return {};
  }
  return result.data;
}

/**
 * Resolve the acceptance-contract configuration.
 * CLI > .issue-flow.json > defaults. Absence is `{}` (L1, discover).
 */
export async function loadVerifyConfig(
  options: LoadVerifyConfigOptions = {},
): Promise<VerifyConfig> {
  const warn = options.warn ?? printWarning;
  const cli = options.cli ?? verifyCliOverrides;
  const fileLayer = await readVerifyConfigFile(options.projectRoot, warn);
  const merged = { ...fileLayer, ...cli };
  const result = verifyConfigSchema.safeParse(merged);
  if (result.success) return result.data;
  warn(
    `Invalid verify configuration (${result.error.issues[0]?.message ?? 'invalid value'}); using defaults.`,
  );
  return verifyConfigSchema.parse({});
}
