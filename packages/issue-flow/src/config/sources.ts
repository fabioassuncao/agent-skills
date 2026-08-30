import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getGlobalRoot } from '../storage/paths.js';
import { type GlobalConfig, globalConfigSchema } from '../storage/schemas.js';
import { printWarning } from '../ui/logger.js';

/** Optional per-project configuration file, read from the project root. */
export const PROJECT_CONFIG_FILENAME = '.issue-flow.json';

/**
 * Locate the project root without spawning `git`. Tests that mock `execa`
 * wholesale (execute-regression, executor) treat every spawn as the agent;
 * a `git rev-parse` here would steal that first call.
 */
export function findProjectRootFromCwd(start: string = process.cwd()): string | undefined {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, PROJECT_CONFIG_FILENAME)) || existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function readProjectConfigFile(
  projectRoot: string | undefined,
  warn: (message: string) => void,
): Promise<Record<string, unknown> | null> {
  const root = projectRoot ?? findProjectRootFromCwd();
  if (root === undefined) {
    return null;
  }

  const filePath = join(root, PROJECT_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    // The file is entirely optional — absence is the common case.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`Ignoring ${PROJECT_CONFIG_FILENAME}: invalid JSON.`);
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`Ignoring ${PROJECT_CONFIG_FILENAME}: expected a JSON object.`);
    return null;
  }

  return parsed as Record<string, unknown>;
}

/** Machine-wide configuration file, read from the global storage root. */
export const GLOBAL_CONFIG_FILENAME = 'config.json';

export interface LoadGlobalConfigOptions {
  /** Environment source, forwarded to getGlobalRoot(). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Directory holding config.json. Defaults to getGlobalRoot(). */
  globalRoot?: string;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
}

/**
 * Read and parse `~/.issue-flow/config.json`, the preferences a user sets once
 * for every project.
 *
 * Never throws, exactly like readProjectConfigFile(): an absent file, an
 * unreadable path, invalid JSON, a non-object root or an invalid key all
 * degrade to "no global preference" so the caller falls back to the layers
 * below. Absence is silent — it is the common case; every other failure warns,
 * because a preference the user did write is being dropped.
 *
 * Validation happens key by key on purpose: a typo in `retry` must not cost the
 * user their `web` settings. Unknown keys are dropped without a warning, which
 * is what keeps a file written by a newer release readable here.
 */
export async function loadGlobalConfig(
  options: LoadGlobalConfigOptions = {},
): Promise<GlobalConfig> {
  const warn = options.warn ?? printWarning;

  let root: string;
  try {
    root = options.globalRoot ?? getGlobalRoot({ env: options.env ?? process.env });
  } catch (err: unknown) {
    warn(`Ignoring ${GLOBAL_CONFIG_FILENAME}: ${(err as Error).message}`);
    return {};
  }

  const filePath = join(root, GLOBAL_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`Ignoring ${GLOBAL_CONFIG_FILENAME}: ${(err as Error).message}`);
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`Ignoring ${GLOBAL_CONFIG_FILENAME}: invalid JSON.`);
    return {};
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`Ignoring ${GLOBAL_CONFIG_FILENAME}: expected a JSON object.`);
    return {};
  }

  const config: GlobalConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    const result = globalConfigSchema.safeParse({ [key]: value });
    if (!result.success) {
      warn(
        `Ignoring "${key}" key of ${GLOBAL_CONFIG_FILENAME}: ${result.error.issues[0]?.message ?? 'invalid value'}.`,
      );
      continue;
    }
    // An unknown key parses successfully into an empty object and disappears
    // here, which is the retro-compatible behaviour we want.
    Object.assign(config, result.data);
  }

  return config;
}
