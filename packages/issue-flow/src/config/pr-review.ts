import type { PrReviewConfig } from '../schemas.js';
import { prReviewConfigSchema } from '../schemas.js';
import { printWarning } from '../ui/logger.js';
import { PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

export interface LoadPrReviewConfigOptions {
  /** Highest-precedence layer, for a future `--publisher` flag. */
  cli?: Partial<PrReviewConfig>;
  /** Environment source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Directory containing .issue-flow.json. Defaults to the git project root. */
  projectRoot?: string;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
}

function readPrReviewConfigEnv(env: NodeJS.ProcessEnv): Partial<PrReviewConfig> {
  const publisher = env.ISSUE_FLOW_PR_REVIEW_PUBLISHER;
  // An unknown value is not dropped here: it goes through the schema below, so
  // the user gets the same warning a bad config file would produce.
  return publisher === undefined ? {} : { publisher: publisher as PrReviewConfig['publisher'] };
}

async function readPrReviewConfigFile(
  projectRoot: string | undefined,
  warn: (message: string) => void,
): Promise<Partial<PrReviewConfig>> {
  const file = await readProjectConfigFile(projectRoot, warn);
  const prReview = file?.prReview;
  if (prReview === undefined) {
    return {};
  }

  const result = prReviewConfigSchema.partial().safeParse(prReview);
  if (!result.success) {
    warn(
      `Ignoring "prReview" key of ${PROJECT_CONFIG_FILENAME}: ${result.error.issues[0]?.message ?? 'invalid value'}.`,
    );
    return {};
  }
  return result.data;
}

/**
 * Resolve the `pr-review` configuration with the documented precedence:
 * CLI flag > environment variable > .issue-flow.json > defaults.
 *
 * Never throws: an absent, malformed or unknown value degrades to the default
 * publisher with a warning, so a typo in .issue-flow.json costs a warning
 * rather than the review.
 */
export async function loadPrReviewConfig(
  options: LoadPrReviewConfigOptions = {},
): Promise<PrReviewConfig> {
  const warn = options.warn ?? printWarning;
  const env = options.env ?? process.env;

  const fileLayer = await readPrReviewConfigFile(options.projectRoot, warn);
  const envLayer = readPrReviewConfigEnv(env);
  const merged = { ...fileLayer, ...envLayer, ...(options.cli ?? {}) };

  const result = prReviewConfigSchema.safeParse(merged);
  if (result.success) {
    return result.data;
  }
  warn(
    `Invalid PR review configuration (${result.error.issues[0]?.message ?? 'invalid value'}); using defaults.`,
  );
  return prReviewConfigSchema.parse({});
}
