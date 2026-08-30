import type { IssuesConfig } from '../issues/types.js';
import { issuesConfigSchema } from '../schemas.js';
import { printWarning } from '../ui/logger.js';
import { PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

/**
 * CLI overrides captured by the preAction hook in cli.ts (--local, --github,
 * --prefer-local, --prefer-github, --ask). Highest-precedence source consumed
 * by loadIssuesConfig().
 */
let issuesCliOverrides: Partial<IssuesConfig> = {};

export function setIssuesCliOverrides(overrides: Partial<IssuesConfig>): void {
  issuesCliOverrides = overrides;
}

export interface LoadIssuesConfigOptions {
  /** CLI flag overrides. Defaults to the values set via setIssuesCliOverrides(). */
  cli?: Partial<IssuesConfig>;
  /** Directory containing .issue-flow.json. Defaults to the git project root. */
  projectRoot?: string;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
}

async function readIssuesConfigFile(
  projectRoot: string | undefined,
  warn: (message: string) => void,
): Promise<Partial<IssuesConfig>> {
  const file = await readProjectConfigFile(projectRoot, warn);
  const issues = file?.issues;
  if (issues === undefined) {
    return {};
  }

  const result = issuesConfigSchema.partial().safeParse(issues);
  if (!result.success) {
    warn(
      `Ignoring "issues" key of ${PROJECT_CONFIG_FILENAME}: ${result.error.issues[0]?.message ?? 'invalid value'}.`,
    );
    return {};
  }
  return result.data;
}

/**
 * Resolve the Issue provider configuration with the documented precedence:
 * CLI flag > .issue-flow.json > defaults.
 *
 * Never throws: missing or invalid sources degrade to the defaults with a
 * warning, and the defaults reproduce the GitHub-only behaviour.
 */
export async function loadIssuesConfig(
  options: LoadIssuesConfigOptions = {},
): Promise<IssuesConfig> {
  const warn = options.warn ?? printWarning;
  const cli = options.cli ?? issuesCliOverrides;

  const fileLayer = await readIssuesConfigFile(options.projectRoot, warn);
  const merged = { ...fileLayer, ...cli };

  const result = issuesConfigSchema.safeParse(merged);
  if (result.success) {
    return result.data;
  }
  warn(
    `Invalid Issue provider configuration (${result.error.issues[0]?.message ?? 'invalid value'}); using defaults.`,
  );
  return issuesConfigSchema.parse({});
}
