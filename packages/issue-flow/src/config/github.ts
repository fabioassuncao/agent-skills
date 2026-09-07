import type { GitHubConfig } from '../schemas.js';
import { githubConfigSchema } from '../schemas.js';
import { printWarning } from '../ui/logger.js';
import { parseBooleanEnv, readNumberEnv } from './layers.js';
import { updateProjectConfigSection } from './project-settings.js';
import { PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

/**
 * The `github` key of `.issue-flow.json` — linked repositories and the display
 * sync interval.
 *
 * Linked repositories come from the WebMux absorption (§20): a unit of work can
 * span sibling repositories, and their Pull Requests belong to the same view.
 * Declaring none — the default — leaves every `gh` call exactly where it was.
 */

export interface LoadGitHubConfigOptions {
  /** Highest-precedence layer, for a future flag. */
  cli?: Partial<GitHubConfig>;
  /** Environment source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Directory containing .issue-flow.json. Defaults to the git project root. */
  projectRoot?: string;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
}

/**
 * Parse `ISSUE_FLOW_GITHUB_LINKED_REPOS`, a comma-separated list of
 * `owner/repo=alias` pairs. The alias may be omitted, in which case the
 * repository name stands in for it — writing `acme/api` is the common case and
 * should not require repeating "api".
 *
 * An entry that carries no usable slug is dropped with a warning rather than
 * failing the load: a typo in an environment variable must not cost the run.
 */
export function parseLinkedReposEnv(
  raw: string,
  warn: (message: string) => void,
): GitHubConfig['linkedRepos'] {
  const parsed: GitHubConfig['linkedRepos'] = [];
  for (const chunk of raw.split(',')) {
    const entry = chunk.trim();
    if (entry === '') continue;
    const [slug, alias] = entry.split('=', 2).map((part) => part.trim());
    if (slug === undefined || !slug.includes('/')) {
      warn(`Ignoring linked repository "${entry}": expected owner/repo[=alias].`);
      continue;
    }
    const fallback = slug.slice(slug.indexOf('/') + 1);
    parsed.push({ repo: slug, alias: alias === undefined || alias === '' ? fallback : alias });
  }
  return parsed;
}

function readGitHubConfigEnv(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): Partial<GitHubConfig> {
  const layer: Partial<GitHubConfig> = {};

  const linked = env.ISSUE_FLOW_GITHUB_LINKED_REPOS;
  if (linked !== undefined) {
    layer.linkedRepos = parseLinkedReposEnv(linked, warn);
  }

  const interval = readNumberEnv(env, 'ISSUE_FLOW_GITHUB_SYNC_INTERVAL_MS', warn);
  if (interval !== undefined) {
    layer.syncIntervalMs = interval;
  }

  if (env.ISSUE_FLOW_GITHUB_AUTO_REMOVE_ON_MERGE !== undefined) {
    layer.autoRemoveOnMerge = parseBooleanEnv(env.ISSUE_FLOW_GITHUB_AUTO_REMOVE_ON_MERGE);
  }

  return layer;
}

export async function persistGitHubAutoRemoveOnMerge(
  projectRoot: string,
  enabled: boolean,
): Promise<void> {
  await updateProjectConfigSection(projectRoot, 'github', (github) => ({
    ...github,
    autoRemoveOnMerge: enabled,
  }));
}

async function readGitHubConfigFile(
  projectRoot: string | undefined,
  warn: (message: string) => void,
): Promise<Partial<GitHubConfig>> {
  const file = await readProjectConfigFile(projectRoot, warn);
  const github = file?.github;
  if (github === undefined) {
    return {};
  }

  const result = githubConfigSchema.partial().safeParse(github);
  if (!result.success) {
    warn(
      `Ignoring "github" key of ${PROJECT_CONFIG_FILENAME}: ${result.error.issues[0]?.message ?? 'invalid value'}.`,
    );
    return {};
  }
  return result.data;
}

/**
 * Resolve the GitHub integration configuration with the documented precedence:
 * CLI flag > environment variable > .issue-flow.json > defaults.
 *
 * Never throws: an absent, malformed or unknown value degrades to the defaults
 * with a warning, so a typo costs a warning rather than the Pull Request view.
 */
export async function loadGitHubConfig(
  options: LoadGitHubConfigOptions = {},
): Promise<GitHubConfig> {
  const warn = options.warn ?? printWarning;
  const env = options.env ?? process.env;

  const fileLayer = await readGitHubConfigFile(options.projectRoot, warn);
  const envLayer = readGitHubConfigEnv(env, warn);
  const merged = { ...fileLayer, ...envLayer, ...(options.cli ?? {}) };

  const result = githubConfigSchema.safeParse(merged);
  if (result.success) {
    return result.data;
  }
  warn(
    `Invalid GitHub configuration (${result.error.issues[0]?.message ?? 'invalid value'}); using defaults.`,
  );
  return githubConfigSchema.parse({});
}
