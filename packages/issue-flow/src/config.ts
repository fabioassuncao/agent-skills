import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { join } from 'node:path';
import type { IssuesConfig } from './issues/types.js';
import { RETRY_CONFIG_KEYS, type RetryPolicyOverride } from './resilience/policy.js';
import {
  issuesConfigSchema,
  type PolicyConfig,
  type PolicyConfigInput,
  type PrReviewConfig,
  policyConfigInputSchema,
  policyConfigSchema,
  prReviewConfigSchema,
  type WebConfig,
  webConfigSchema,
} from './schemas.js';
import { getGlobalRoot } from './storage/paths.js';
import { resolveIssuePaths } from './storage/resolve.js';
import {
  type GlobalConfig,
  globalConfigSchema,
  type ResilienceConfig,
  type ResilienceRetryConfig,
  resilienceConfigSchema,
} from './storage/schemas.js';
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
    // Left absent (rather than defaulted to an empty string) so the execute
    // prompt keeps its historical commit format unless a queue asks otherwise.
    ...(options.commitScope === undefined ? {} : { commitScope: options.commitScope }),
  };
}

/**
 * Resolve file paths based on issue number and project root.
 *
 * With --issue N, every artifact comes from the global storage layer via
 * `resolveIssuePaths()`, which also migrates the legacy `<projectRoot>/issues/`
 * tree on first read:
 *   prdFile = ~/.issue-flow/projects/{id}/issues/{N}/tasks.json
 *   progressFile = ~/.issue-flow/projects/{id}/issues/{N}/progress.txt
 *
 * Standalone:
 *   prdFile = {projectRoot}/prd.json
 *   progressFile = {projectRoot}/progress.txt
 *
 * Beware of the asymmetric mapping in the issue branch: `ResolvedPaths.prdFile`
 * is the engine's *task plan*, so it maps to `IssuePaths.tasksFile`
 * (`tasks.json`) and **not** to `IssuePaths.prdFile` (`prd.md`, the human-facing
 * document produced by the `prd` phase). The name predates the split and is kept
 * because standalone mode really does read a `prd.json`.
 *
 * `projectRoot` stays on the result either way: `core/engine.ts` uses it as the
 * cwd of its git operations, which the global storage does not replace.
 */
export async function resolvePaths(
  config: EngineConfig,
  scriptDir?: string,
): Promise<ResolvedPaths> {
  const projectRoot = await getProjectRoot();

  if (config.issueNumber) {
    // projectRoot is forwarded so the resolver does not shell out to
    // `git rev-parse --show-toplevel` a second time for the answer we just got.
    const issuePaths = await resolveIssuePaths(config.issueNumber, { projectRoot });
    return {
      prdFile: issuePaths.tasksFile,
      progressFile: issuePaths.progressFile,
      archiveDir: issuePaths.archiveDir,
      lastBranchFile: issuePaths.lastBranchFile,
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
 *   defaults < discovered < config.json (global) < .issue-flow.json (project)
 *     < env < CLI
 */
export interface ConfigLayers<T extends object> {
  /** Hard-coded fallbacks, e.g. DEFAULTS or the values baked into a schema. */
  defaults?: Partial<T>;
  /**
   * Values read from the consumer repository itself — the policies discovered
   * by `src/policy/`. They sit just above the defaults: a repository's own
   * convention beats a fallback Issue Flow invented, and loses to anything the
   * user explicitly configured.
   */
  discovered?: Partial<T>;
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

  for (const layer of [
    layers.defaults,
    layers.discovered,
    layers.global,
    layers.project,
    layers.env,
    layers.cli,
  ]) {
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

// ── Repository policy configuration ─────────────────────────────────────────

/**
 * CLI overrides for the `policy` key, captured by the preAction hook in cli.ts.
 * Highest-precedence source consumed by loadPolicyConfig().
 */
let policyCliOverrides: PolicyConfigInput = {};

export function setPolicyCliOverrides(overrides: PolicyConfigInput): void {
  policyCliOverrides = overrides;
}

export interface LoadPolicyConfigOptions {
  /** CLI flag overrides. Defaults to the values set via setPolicyCliOverrides(). */
  cli?: PolicyConfigInput;
  /** Environment source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Directory containing .issue-flow.json. Defaults to the git project root. */
  projectRoot?: string;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
}

/**
 * Drop the keys a layer left as `null` or `undefined`.
 *
 * `mergeConfigLayers` only treats `undefined` as "absent", and the input schema
 * accepts `null` as the natural way to write "I do not declare this" — without
 * this, a `"baseBranch": null` would win over the branch discovery found.
 */
function dropNullish<T extends object>(layer: T | undefined): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(layer ?? {})) {
    if (value !== undefined && value !== null) {
      result[key] = value;
    }
  }
  return result as Partial<T>;
}

function readPolicyConfigEnv(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): PolicyConfigInput {
  const layer: PolicyConfigInput = {};

  if (env.ISSUE_FLOW_POLICY !== undefined) {
    layer.enabled = parseBooleanEnv(env.ISSUE_FLOW_POLICY);
  }
  const budget = readNumberEnv(env, 'ISSUE_FLOW_POLICY_CONTEXT_BUDGET', warn);
  if (budget !== undefined) {
    layer.contextBudget = budget;
  }

  const issues: NonNullable<PolicyConfigInput['issues']> = {};
  if (env.ISSUE_FLOW_POLICY_ISSUE_TITLE_CONVENTION !== undefined) {
    issues.titleConvention = env.ISSUE_FLOW_POLICY_ISSUE_TITLE_CONVENTION;
  }
  if (Object.keys(issues).length > 0) layer.issues = issues;

  const pullRequests: NonNullable<PolicyConfigInput['pullRequests']> = {};
  if (env.ISSUE_FLOW_POLICY_BASE_BRANCH !== undefined) {
    pullRequests.baseBranch = env.ISSUE_FLOW_POLICY_BASE_BRANCH;
  }
  if (env.ISSUE_FLOW_POLICY_PR_TITLE_CONVENTION !== undefined) {
    pullRequests.titleConvention = env.ISSUE_FLOW_POLICY_PR_TITLE_CONVENTION;
  }
  if (Object.keys(pullRequests).length > 0) layer.pullRequests = pullRequests;

  const git: NonNullable<PolicyConfigInput['git']> = {};
  if (env.ISSUE_FLOW_POLICY_BRANCH_CONVENTION !== undefined) {
    git.branchConvention = env.ISSUE_FLOW_POLICY_BRANCH_CONVENTION;
  }
  if (env.ISSUE_FLOW_POLICY_COMMIT_CONVENTION !== undefined) {
    git.commitConvention = env.ISSUE_FLOW_POLICY_COMMIT_CONVENTION;
  }
  if (Object.keys(git).length > 0) layer.git = git;

  // An empty string is how a shell spells "unset it again"; it reaches the
  // schema below and is reported like any other invalid value would be.
  const invalid = Object.entries(layer).find(
    ([, value]) => typeof value === 'object' && value !== null && Object.values(value).includes(''),
  );
  if (invalid !== undefined) {
    warn(`Ignoring empty ISSUE_FLOW_POLICY_* value in "${invalid[0]}".`);
  }

  return layer;
}

async function readPolicyConfigFile(
  projectRoot: string | undefined,
  warn: (message: string) => void,
): Promise<PolicyConfigInput> {
  const file = await readProjectConfigFile(projectRoot, warn);
  const policy = file?.policy;
  if (policy === undefined) {
    return {};
  }

  const result = policyConfigInputSchema.safeParse(policy);
  if (!result.success) {
    warn(
      `Ignoring "policy" key of ${PROJECT_CONFIG_FILENAME}: ${result.error.issues[0]?.message ?? 'invalid value'}.`,
    );
    return {};
  }
  return result.data;
}

/**
 * Resolve the repository policy configuration with the documented precedence:
 * CLI flag > ISSUE_FLOW_POLICY_* > .issue-flow.json > defaults.
 *
 * This is only the *explicit* half of the ladder. What the repository declares
 * about itself is discovered by `src/policy/` and merged one rung below, so
 * this function deliberately does not materialize the declarations as `null`:
 * an unset `baseBranch` must stay absent, or it would overrule the base branch
 * discovery actually found.
 *
 * Never throws: an absent, malformed or invalid source degrades to the
 * defaults — discovery on, nothing declared — with a warning.
 */
export async function loadPolicyConfig(
  options: LoadPolicyConfigOptions = {},
): Promise<PolicyConfig> {
  const warn = options.warn ?? printWarning;
  const cli = options.cli ?? policyCliOverrides;
  const env = options.env ?? process.env;

  const fileLayer = await readPolicyConfigFile(options.projectRoot, warn);
  const envLayer = readPolicyConfigEnv(env, warn);

  const merged = {
    ...mergeConfigLayers<{ enabled: boolean; contextBudget: number }>({
      project: dropNullish({ enabled: fileLayer.enabled, contextBudget: fileLayer.contextBudget }),
      env: dropNullish({ enabled: envLayer.enabled, contextBudget: envLayer.contextBudget }),
      cli: dropNullish({ enabled: cli.enabled, contextBudget: cli.contextBudget }),
    }),
    discovery: mergeConfigLayers({
      project: dropNullish(fileLayer.discovery),
      env: dropNullish(envLayer.discovery),
      cli: dropNullish(cli.discovery),
    }),
    issues: mergeConfigLayers({
      project: dropNullish(fileLayer.issues),
      env: dropNullish(envLayer.issues),
      cli: dropNullish(cli.issues),
    }),
    pullRequests: mergeConfigLayers({
      project: dropNullish(fileLayer.pullRequests),
      env: dropNullish(envLayer.pullRequests),
      cli: dropNullish(cli.pullRequests),
    }),
    git: mergeConfigLayers({
      project: dropNullish(fileLayer.git),
      env: dropNullish(envLayer.git),
      cli: dropNullish(cli.git),
    }),
  };

  const result = policyConfigSchema.safeParse(merged);
  if (result.success) {
    return result.data;
  }
  warn(
    `Invalid repository policy configuration (${result.error.issues[0]?.message ?? 'invalid value'}); using defaults.`,
  );
  return policyConfigSchema.parse({});
}

// ── Resilience configuration ────────────────────────────────────────────────

/**
 * CLI overrides for the `resilience` key, captured by the preAction hook in
 * cli.ts. Highest-precedence source consumed by loadResilienceConfig().
 */
let resilienceCliOverrides: ResilienceConfig = {};

export function setResilienceCliOverrides(overrides: ResilienceConfig): void {
  resilienceCliOverrides = overrides;
}

export interface LoadResilienceConfigOptions {
  /** CLI flag overrides. Defaults to the values set via setResilienceCliOverrides(). */
  cli?: ResilienceConfig;
  /** Environment source. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Pre-read `config.json` layer, so a caller holding it avoids a second read. */
  global?: ResilienceConfig;
  /** Directory holding config.json. Defaults to getGlobalRoot(). */
  globalRoot?: string;
  /** Directory containing .issue-flow.json. Defaults to the git project root. */
  projectRoot?: string;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
}

/**
 * Merge one nested section of the key across the four layers, in the ladder's
 * order, and report **absence as absence**: a section nobody configured comes
 * back `undefined` rather than `{}`, which is what lets an unconfigured
 * `resilience` resolve to an empty object instead of a skeleton of empty ones.
 */
function mergeResilienceSection<T extends object>(
  layers: readonly (Partial<T> | undefined)[],
): Partial<T> | undefined {
  const merged = mergeConfigLayers<T>({
    global: layers[0],
    project: layers[1],
    env: layers[2],
    cli: layers[3],
  });
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * `resilience.retry`, merged per `FailureKind` **and** per field inside each
 * kind: a project file that only raises `network.maxDelayMs` must not erase a
 * `network.retryForever` set machine-wide, nor the other kinds next to it.
 *
 * This is the one place the merge goes deeper than `mergeConfigLayers()` does
 * on its own — the documented shallowness stops at the first nested object, and
 * `retry` is two levels deep by construction.
 */
function mergeResilienceRetry(
  layers: readonly (ResilienceRetryConfig | undefined)[],
): ResilienceRetryConfig | undefined {
  const merged: ResilienceRetryConfig = {};
  for (const key of RETRY_CONFIG_KEYS) {
    const entry = mergeResilienceSection<RetryPolicyOverride>(layers.map((layer) => layer?.[key]));
    if (entry !== undefined) {
      merged[key] = entry;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Validate one layer, degrading a malformed one to "nothing configured". */
function parseResilienceLayer(
  value: unknown,
  origin: string,
  warn: (message: string) => void,
): ResilienceConfig {
  const result = resilienceConfigSchema.safeParse(value);
  if (!result.success) {
    warn(
      `Ignoring "resilience" key of ${origin}: ${result.error.issues[0]?.message ?? 'invalid value'}.`,
    );
    return {};
  }
  return result.data;
}

async function readResilienceConfigFile(
  projectRoot: string | undefined,
  warn: (message: string) => void,
): Promise<ResilienceConfig> {
  const file = await readProjectConfigFile(projectRoot, warn);
  const resilience = file?.resilience;
  if (resilience === undefined) {
    return {};
  }
  return parseResilienceLayer(resilience, PROJECT_CONFIG_FILENAME, warn);
}

/**
 * The `ISSUE_FLOW_RESILIENCE_*` layer.
 *
 * Only the scalar knobs get a variable of their own; the per-kind `retry` table
 * is too shaped for a shell variable, so it travels whole as JSON in
 * `ISSUE_FLOW_RESILIENCE_RETRY`. Everything collected here still goes through
 * the schema afterwards, so a typo warns exactly like a bad config file does.
 */
function readResilienceConfigEnv(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): ResilienceConfig {
  const layer: Record<string, unknown> = {};

  if (env.ISSUE_FLOW_RESILIENCE_PROFILE !== undefined) {
    layer.profile = env.ISSUE_FLOW_RESILIENCE_PROFILE;
  }
  if (env.ISSUE_FLOW_RESILIENCE_FAILOVER_ON_AUTH !== undefined) {
    layer.failoverOnAuth = parseBooleanEnv(env.ISSUE_FLOW_RESILIENCE_FAILOVER_ON_AUTH);
  }

  const retry = env.ISSUE_FLOW_RESILIENCE_RETRY;
  if (retry !== undefined) {
    try {
      layer.retry = JSON.parse(retry);
    } catch {
      warn('Ignoring ISSUE_FLOW_RESILIENCE_RETRY: invalid JSON.');
    }
  }

  const providers: Record<string, unknown> = {};
  if (env.ISSUE_FLOW_RESILIENCE_FAILOVER !== undefined) {
    providers.failover = parseBooleanEnv(env.ISSUE_FLOW_RESILIENCE_FAILOVER);
  }
  if (env.ISSUE_FLOW_RESILIENCE_PROVIDER_CHAIN !== undefined) {
    providers.chain = env.ISSUE_FLOW_RESILIENCE_PROVIDER_CHAIN.split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
  }
  const cooldown = readNumberEnv(env, 'ISSUE_FLOW_RESILIENCE_PROVIDER_COOLDOWN_MS', warn);
  if (cooldown !== undefined) {
    providers.cooldownMs = cooldown;
  }
  if (Object.keys(providers).length > 0) layer.providers = providers;

  const queue: Record<string, unknown> = {};
  if (env.ISSUE_FLOW_RESILIENCE_ON_ISSUE_FAILURE !== undefined) {
    queue.onIssueFailure = env.ISSUE_FLOW_RESILIENCE_ON_ISSUE_FAILURE;
  }
  const maxIssueAttempts = readNumberEnv(env, 'ISSUE_FLOW_RESILIENCE_MAX_ISSUE_ATTEMPTS', warn);
  if (maxIssueAttempts !== undefined) {
    queue.maxIssueAttempts = maxIssueAttempts;
  }
  if (Object.keys(queue).length > 0) layer.queue = queue;

  const inactivity = readNumberEnv(env, 'ISSUE_FLOW_RESILIENCE_INACTIVITY_TIMEOUT_MS', warn);
  if (inactivity !== undefined) {
    layer.watchdog = { inactivityTimeoutMs: inactivity };
  }

  const journal: Record<string, unknown> = {};
  if (env.ISSUE_FLOW_RESILIENCE_JOURNAL !== undefined) {
    journal.enabled = parseBooleanEnv(env.ISSUE_FLOW_RESILIENCE_JOURNAL);
  }
  const journalBytes = readNumberEnv(env, 'ISSUE_FLOW_RESILIENCE_JOURNAL_MAX_BYTES', warn);
  if (journalBytes !== undefined) {
    journal.maxFileBytes = journalBytes;
  }
  if (Object.keys(journal).length > 0) layer.journal = journal;

  if (env.ISSUE_FLOW_RESILIENCE_AUTO_DECOMPOSE !== undefined) {
    layer.decompose = { auto: parseBooleanEnv(env.ISSUE_FLOW_RESILIENCE_AUTO_DECOMPOSE) };
  }

  if (Object.keys(layer).length === 0) {
    return {};
  }
  return parseResilienceLayer(layer, 'the ISSUE_FLOW_RESILIENCE_* environment', warn);
}

/**
 * Resolve the `resilience` key with the documented precedence:
 * CLI flag > `ISSUE_FLOW_RESILIENCE_*` > `.issue-flow.json` > `config.json` >
 * defaults.
 *
 * **An unconfigured project resolves to `{}`** — not to a skeleton of empty
 * sections, and never to a materialized default. That is the whole contract of
 * this loader: `resolvePolicy(kind, {})` is the base table of the PRD, so
 * "nothing configured" and "the behaviour of every release before this one" are
 * the same object. The defaults of each sub-key belong to the layer that
 * consumes it (`resilience/policy.ts` for `retry`, and one later story each for
 * `providers`, `queue`, `watchdog`, `journal` and `decompose`), never here.
 *
 * Never throws: an absent, malformed or invalid source degrades to "nothing
 * configured" with a warning, key by key.
 */
export async function loadResilienceConfig(
  options: LoadResilienceConfigOptions = {},
): Promise<ResilienceConfig> {
  const warn = options.warn ?? printWarning;
  const env = options.env ?? process.env;
  const cli = options.cli ?? resilienceCliOverrides;

  const globalLayer =
    options.global ??
    (
      await loadGlobalConfig({
        env,
        ...(options.globalRoot === undefined ? {} : { globalRoot: options.globalRoot }),
        warn,
      })
    ).resilience ??
    {};
  const projectLayer = await readResilienceConfigFile(options.projectRoot, warn);
  const envLayer = readResilienceConfigEnv(env, warn);

  const layers = [globalLayer, projectLayer, envLayer, cli] as const;

  const scalars = mergeConfigLayers<Pick<ResilienceConfig, 'profile' | 'failoverOnAuth'>>({
    global: { profile: globalLayer.profile, failoverOnAuth: globalLayer.failoverOnAuth },
    project: { profile: projectLayer.profile, failoverOnAuth: projectLayer.failoverOnAuth },
    env: { profile: envLayer.profile, failoverOnAuth: envLayer.failoverOnAuth },
    cli: { profile: cli.profile, failoverOnAuth: cli.failoverOnAuth },
  });

  const retry = mergeResilienceRetry(layers.map((layer) => layer.retry));
  const providers = mergeResilienceSection(layers.map((layer) => layer.providers));
  const queue = mergeResilienceSection(layers.map((layer) => layer.queue));
  const watchdog = mergeResilienceSection(layers.map((layer) => layer.watchdog));
  const journal = mergeResilienceSection(layers.map((layer) => layer.journal));
  const decompose = mergeResilienceSection(layers.map((layer) => layer.decompose));

  return {
    ...scalars,
    ...(retry === undefined ? {} : { retry }),
    ...(providers === undefined ? {} : { providers }),
    ...(queue === undefined ? {} : { queue }),
    ...(watchdog === undefined ? {} : { watchdog }),
    ...(journal === undefined ? {} : { journal }),
    ...(decompose === undefined ? {} : { decompose }),
  };
}

/**
 * The `resilience` key in force for this process.
 *
 * Read **synchronously**, by call sites that cannot afford four disk reads per
 * `gh` invocation and must not perform I/O of their own — a provider that
 * shelled out to `git` to find its retry budget would be doing exactly the
 * thing this key exists to make survivable.
 *
 * It starts empty on purpose: `{}` is the base table of `resolvePolicy()`, so
 * a process that never installs anything behaves exactly as it did before the
 * key existed. `initResilienceConfig()` is what fills it in, once, from the
 * command that owns the run.
 */
let activeResilienceConfig: ResilienceConfig = {};

/** The key in force. `{}` until a command installs one. */
export function getActiveResilienceConfig(): ResilienceConfig {
  return activeResilienceConfig;
}

/** Install a key directly. For tests, and for a caller that already loaded it. */
export function setActiveResilienceConfig(config: ResilienceConfig): void {
  activeResilienceConfig = config;
}

/**
 * Load the key off the ladder and install it. Never throws: a failed load
 * leaves the base table in place, which is the documented default.
 */
export async function initResilienceConfig(
  options: LoadResilienceConfigOptions = {},
): Promise<ResilienceConfig> {
  try {
    activeResilienceConfig = await loadResilienceConfig(options);
  } catch {
    activeResilienceConfig = {};
  }
  return activeResilienceConfig;
}
