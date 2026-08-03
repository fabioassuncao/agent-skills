import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import { type WebConfig, webConfigSchema } from './schemas.js';
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

// ── Web monitoring configuration ────────────────────────────────────────────

/** Optional per-project configuration file, read from the project root. */
export const WEB_CONFIG_FILENAME = '.issue-flow.json';

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
  let root = projectRoot;
  if (root === undefined) {
    try {
      root = await getProjectRoot();
    } catch {
      return {};
    }
  }

  const filePath = join(root, WEB_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    // The file is entirely optional — absence is the common case.
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`Ignoring ${WEB_CONFIG_FILENAME}: invalid JSON.`);
    return {};
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`Ignoring ${WEB_CONFIG_FILENAME}: expected a JSON object.`);
    return {};
  }

  const web = (parsed as Record<string, unknown>).web;
  if (web === undefined) {
    return {};
  }

  const result = webConfigSchema.partial().safeParse(web);
  if (!result.success) {
    warn(
      `Ignoring "web" key of ${WEB_CONFIG_FILENAME}: ${result.error.issues[0]?.message ?? 'invalid value'}.`,
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
