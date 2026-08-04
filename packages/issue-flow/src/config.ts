import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import type { IssuesConfig } from './issues/types.js';
import {
  issuesConfigSchema,
  type PrReviewConfig,
  prReviewConfigSchema,
  type WebConfig,
  webConfigSchema,
} from './schemas.js';
import { getGlobalRoot } from './storage/paths.js';
import { type GlobalConfig, globalConfigSchema } from './storage/schemas.js';
import type { EngineConfig, ResolvedPaths } from './types.js';
import { printWarning } from './ui/logger.js';
import { getProjectRoot } from './utils/git.js';
import { run } from './utils/shell.js';

/**
 * Default configuration values — matching the Bash script exactly.
 */
export const DEFAULTS = {
  retryLimit: 10,
  retryForever: false,
  backoffBaseSeconds: 30,
  backoffMaxSeconds: 900,
} as const;

/**
 * Create a EngineConfig with defaults merged with provided options.
 */
export function createConfig(options: Partial<EngineConfig>): EngineConfig {
  return {
    issueNumber: options.issueNumber,
    maxIterations: options.maxIterations,
    retryLimit: options.retryLimit ?? DEFAULTS.retryLimit,
    retryForever: options.retryForever ?? DEFAULTS.retryForever,
    backoffBaseSeconds: options.backoffBaseSeconds ?? DEFAULTS.backoffBaseSeconds,
    backoffMaxSeconds: options.backoffMaxSeconds ?? DEFAULTS.backoffMaxSeconds,
  };
}

/**
 * Resolve file paths based on issue number and project root.
 *
 * With --issue N:
 *   prdFile = {projectRoot}/issues/{N}/tasks.json
 *   progressFile = {projectRoot}/issues/{N}/progress.txt
 *
 * Standalone:
 *   prdFile = {projectRoot}/prd.json
 *   progressFile = {projectRoot}/progress.txt
 */
export async function resolvePaths(
  config: EngineConfig,
  scriptDir?: string,
): Promise<ResolvedPaths> {
  const projectRoot = await getProjectRoot();

  if (config.issueNumber) {
    const issueDir = join(projectRoot, 'issues', config.issueNumber);
    return {
      prdFile: join(issueDir, 'tasks.json'),
      progressFile: join(issueDir, 'progress.txt'),
      archiveDir: join(issueDir, 'archive'),
      lastBranchFile: join(issueDir, '.last-branch'),
      projectRoot,
    };
  }

  // Standalone mode — use scriptDir if available, otherwise projectRoot
  const base = scriptDir ?? projectRoot;
  return {
    prdFile: join(base, 'prd.json'),
    progressFile: join(base, 'progress.txt'),
    archiveDir: join(base, 'archive'),
    lastBranchFile: join(base, '.last-branch'),
    projectRoot,
  };
}

/**
 * Return a platform-appropriate install hint for a given package.
 */
export function getInstallHint(pkg: string): string {
  const os = platform();

  if (os === 'darwin') {
    return `brew install ${pkg}`;
  }
  if (os === 'linux') {
    return `apt install ${pkg}  (or your distro's package manager)`;
  }
  if (os === 'win32') {
    return `winget install ${pkg}  (or choco install ${pkg})`;
  }

  return `install ${pkg} using your system package manager`;
}

/**
 * Validate that required external dependencies are available.
 * Returns an array of error messages (empty if all deps are found).
 */
export async function validateDependencies(): Promise<string[]> {
  const errors: string[] = [];

  // Check git
  const gitResult = await run('git', ['--version']);
  if (gitResult.exitCode !== 0) {
    errors.push(`  - git  (install with: ${getInstallHint('git')})`);
  }

  // Check claude
  const claudeResult = await run('claude', ['--version']);
  if (claudeResult.exitCode !== 0) {
    errors.push('  - claude  (install with: npm install -g @anthropic-ai/claude-code)');
  }

  // Note: jq is NOT required — the TypeScript CLI handles JSON natively

  return errors;
}

// ── Per-project configuration file ──────────────────────────────────────────

/** Optional per-project configuration file, read from the project root. */
export const PROJECT_CONFIG_FILENAME = '.issue-flow.json';

/** Historical alias kept for the web monitoring call sites. */
export const WEB_CONFIG_FILENAME = PROJECT_CONFIG_FILENAME;

/**
 * Read and parse .issue-flow.json from the project root.
 *
 * Never throws: an absent file, unreadable path, invalid JSON or a non-object
 * root all degrade to `null` (with a warning for the malformed cases), so every
 * consumer falls back to its own defaults.
 */
async function readProjectConfigFile(
  projectRoot: string | undefined,
  warn: (message: string) => void,
): Promise<Record<string, unknown> | null> {
  let root = projectRoot;
  if (root === undefined) {
    try {
      root = await getProjectRoot();
    } catch {
      return null;
    }
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

// ── Global configuration file ───────────────────────────────────────────────

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

/**
 * The configuration sources of the engine, ordered from the lowest to the
 * highest precedence:
 *
 *   defaults < config.json (global) < .issue-flow.json (project) < env < CLI
 */
export interface ConfigLayers<T extends object> {
  /** Hard-coded fallbacks, e.g. DEFAULTS or the values baked into a schema. */
  defaults?: Partial<T>;
  /** ~/.issue-flow/config.json, via loadGlobalConfig(). */
  global?: Partial<T>;
  /** The matching key of .issue-flow.json in the project root. */
  project?: Partial<T>;
  /** ISSUE_FLOW_* environment variables. */
  env?: Partial<T>;
  /** CLI flags. */
  cli?: Partial<T>;
}

/**
 * Merge configuration layers following the documented precedence.
 *
 * Pure and shallow: a layer only participates with the keys it actually
 * carries, so an absent key never erases the layer below it. `undefined` counts
 * as absent — that is what lets a layer be built by assigning only the values
 * that were really provided.
 *
 * Because the merge is shallow, nested objects (`web`, `retry`) are replaced
 * whole rather than merged field by field; callers that need per-field
 * precedence inside a nested key must flatten it into its own merge.
 *
 * Caveat for the `project` layer: it must be the *raw* set of keys the user
 * wrote, not the output of a schema that materializes defaults. In zod 4 a
 * `.default()` survives `.partial()`, so parsing the project file with
 * `webConfigSchema.partial()` yields every default and would make the project
 * layer swallow the global one.
 */
export function mergeConfigLayers<T extends object>(layers: ConfigLayers<T>): Partial<T> {
  const merged: Record<string, unknown> = {};

  for (const layer of [layers.defaults, layers.global, layers.project, layers.env, layers.cli]) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }

  return merged as Partial<T>;
}

// ── Web monitoring configuration ────────────────────────────────────────────

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

const FALSY_ENV_VALUES = new Set(['', '0', 'false', 'no', 'off']);

function parseBooleanEnv(value: string): boolean {
  return !FALSY_ENV_VALUES.has(value.trim().toLowerCase());
}

function readNumberEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  warn: (message: string) => void,
): number | undefined {
  const raw = env[name];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    warn(`Ignoring ${name}="${raw}": not a number.`);
    return undefined;
  }
  return parsed;
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

// ── Issue provider configuration ────────────────────────────────────────────

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

// ── PR review configuration ─────────────────────────────────────────────────

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
