import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { installHint } from './agents/availability.js';
import { setTrackedOrigins } from './agents/origins.js';
import { runnerFor } from './agents/registry.js';
import { agentConfigInputSchema, parsePhasesInput } from './agents/schemas.js';
import type {
  AgentBlock,
  AgentCliOverrides,
  AgentConfig,
  AgentOrigin,
  AgentPhase,
  AgentProviderId,
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
} from './agents/types.js';
import { AGENT_PHASES, isAgentProviderId } from './agents/types.js';
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
  type RoutingConfig,
  type RoutingConfigInput,
  routingConfigInputSchema,
  routingConfigSchema,
  type VerifyConfig,
  verifyConfigSchema,
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
  type TelemetryConfigInput,
  telemetryConfigInputSchema,
} from './storage/schemas.js';
import { DEFAULT_TELEMETRY_CONFIG, type TelemetryConfig } from './telemetry/types.js';
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
    storiesPerIteration: options.storiesPerIteration ?? 1,
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
  const standalone = {
    prdFile: join(base, 'prd.json'),
    progressFile: join(base, 'progress.txt'),
    archiveDir: join(base, 'archive'),
    lastBranchFile: join(base, '.last-branch'),
    projectRoot,
  };
  const { bindTelemetry } = await import('./telemetry/recorder.js');
  bindTelemetry({ tasksPath: standalone.prdFile });
  return standalone;
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

  // Check the agents this run actually selected — never every binary on the
  // machine. An unconfigured run still only needs `claude`, which is the
  // behaviour every release before the agent layer had.
  const agent = await loadAgentConfig();
  const needed = new Set<AgentProviderId>([agent.provider]);
  for (const phase of AGENT_PHASES) {
    const provider = agent.phases[phase]?.provider;
    if (provider !== undefined) needed.add(provider);
  }
  for (const id of needed) {
    // The binary is the runner's, never a guess. Mapping every non-Codex
    // provider to `claude` made preflight demand the wrong CLI for Cursor and
    // pass without `agy` installed for Antigravity.
    const { command, args } = runnerFor(id).versionCommand();
    const result = await run(command, args);
    if (result.exitCode !== 0) {
      errors.push(`  - ${command}  (${installHint(id)})`);
    }
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
 * Locate the project root without spawning `git`. Tests that mock `execa`
 * wholesale (execute-regression, executor) treat every spawn as the agent;
 * a `git rev-parse` here would steal that first call.
 */
function findProjectRootFromCwd(start: string = process.cwd()): string | undefined {
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

async function readProjectConfigFile(
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

// ── Telemetry configuration ─────────────────────────────────────────────────

export interface LoadTelemetryConfigOptions {
  env?: NodeJS.ProcessEnv;
  global?: TelemetryConfigInput;
  globalRoot?: string;
  projectRoot?: string;
  warn?: (message: string) => void;
}

function parseTelemetryLayer(
  value: unknown,
  source: string,
  warn: (message: string) => void,
): TelemetryConfigInput {
  if (value === undefined) return {};
  const result = telemetryConfigInputSchema.safeParse(value);
  if (result.success) return result.data;
  warn(
    `Ignoring "telemetry" key of ${source}: ${result.error.issues[0]?.message ?? 'invalid value'}.`,
  );
  return {};
}

function readTelemetryEnv(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): TelemetryConfigInput {
  const layer: TelemetryConfigInput = {};
  if (env.ISSUE_FLOW_TELEMETRY !== undefined) {
    layer.enabled = parseBooleanEnv(env.ISSUE_FLOW_TELEMETRY);
  }
  const max = readNumberEnv(env, 'ISSUE_FLOW_TELEMETRY_MAX_EXECUTIONS', warn);
  if (max !== undefined) layer.maxExecutions = max;
  if (env.ISSUE_FLOW_TELEMETRY_ESTIMATE !== undefined) {
    layer.pricing = { estimate: parseBooleanEnv(env.ISSUE_FLOW_TELEMETRY_ESTIMATE) };
  }
  return layer;
}

/**
 * defaults < `config.json` < `.issue-flow.json` < `ISSUE_FLOW_TELEMETRY*`.
 *
 * Nested `pricing` is flattened so a project `estimate` does not erase a
 * global `overrides` map.
 */
export async function loadTelemetryConfig(
  options: LoadTelemetryConfigOptions = {},
): Promise<TelemetryConfig> {
  const warn = options.warn ?? printWarning;
  const env = options.env ?? process.env;
  const globalFile =
    options.global ??
    (
      await loadGlobalConfig({
        env,
        ...(options.globalRoot === undefined ? {} : { globalRoot: options.globalRoot }),
        warn,
      })
    ).telemetry;
  const projectFile = await readProjectConfigFile(options.projectRoot, warn);
  const project = parseTelemetryLayer(projectFile?.telemetry, PROJECT_CONFIG_FILENAME, warn);
  const envLayer = readTelemetryEnv(env, warn);

  const pricing = mergeConfigLayers<TelemetryConfig['pricing']>({
    defaults: DEFAULT_TELEMETRY_CONFIG.pricing,
    global: globalFile?.pricing,
    project: project.pricing,
    env: envLayer.pricing,
  });
  const overrides = {
    ...DEFAULT_TELEMETRY_CONFIG.pricing.overrides,
    ...globalFile?.pricing?.overrides,
    ...project.pricing?.overrides,
    ...envLayer.pricing?.overrides,
  };

  const scalars = mergeConfigLayers<Pick<TelemetryConfig, 'enabled' | 'maxExecutions'>>({
    defaults: {
      enabled: DEFAULT_TELEMETRY_CONFIG.enabled,
      maxExecutions: DEFAULT_TELEMETRY_CONFIG.maxExecutions,
    },
    global: {
      ...(globalFile?.enabled === undefined ? {} : { enabled: globalFile.enabled }),
      ...(globalFile?.maxExecutions === undefined
        ? {}
        : { maxExecutions: globalFile.maxExecutions }),
    },
    project: {
      ...(project.enabled === undefined ? {} : { enabled: project.enabled }),
      ...(project.maxExecutions === undefined ? {} : { maxExecutions: project.maxExecutions }),
    },
    env: {
      ...(envLayer.enabled === undefined ? {} : { enabled: envLayer.enabled }),
      ...(envLayer.maxExecutions === undefined ? {} : { maxExecutions: envLayer.maxExecutions }),
    },
  });

  return {
    enabled: scalars.enabled ?? DEFAULT_TELEMETRY_CONFIG.enabled,
    maxExecutions: scalars.maxExecutions ?? DEFAULT_TELEMETRY_CONFIG.maxExecutions,
    pricing: {
      estimate: pricing.estimate ?? DEFAULT_TELEMETRY_CONFIG.pricing.estimate,
      overrides,
    },
  };
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
  const maxCooldown = readNumberEnv(env, 'ISSUE_FLOW_RESILIENCE_PROVIDER_MAX_COOLDOWN_MS', warn);
  if (maxCooldown !== undefined) {
    providers.maxCooldownMs = maxCooldown;
  }
  const failureWindow = readNumberEnv(
    env,
    'ISSUE_FLOW_RESILIENCE_PROVIDER_FAILURE_WINDOW_MS',
    warn,
  );
  if (failureWindow !== undefined) {
    providers.failureWindowMs = failureWindow;
  }
  const failuresToTrip = readNumberEnv(
    env,
    'ISSUE_FLOW_RESILIENCE_PROVIDER_FAILURES_TO_TRIP',
    warn,
  );
  if (failuresToTrip !== undefined) {
    providers.failuresToTrip = failuresToTrip;
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

// ── Agent configuration ─────────────────────────────────────────────────────

export type { AgentCliOverrides, AgentConfig };

let agentCliOverrides: AgentCliOverrides = {};
let cachedAgentConfig: AgentConfig | undefined;

export function setAgentCliOverrides(overrides: AgentCliOverrides): void {
  agentCliOverrides = overrides;
  cachedAgentConfig = undefined;
}

export function getAgentCliOverrides(): AgentCliOverrides {
  return agentCliOverrides;
}

export interface LoadAgentConfigOptions {
  cli?: AgentCliOverrides;
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  globalRoot?: string;
  warn?: (message: string) => void;
}

function readAgentEnv(env: NodeJS.ProcessEnv, warn: (message: string) => void): AgentCliOverrides {
  const layer: AgentCliOverrides = {};
  if (env.ISSUE_FLOW_AGENT !== undefined) {
    if (isAgentProviderId(env.ISSUE_FLOW_AGENT)) {
      layer.provider = env.ISSUE_FLOW_AGENT;
    } else {
      warn(
        `Ignoring ISSUE_FLOW_AGENT="${env.ISSUE_FLOW_AGENT}": expected claude, codex, cursor or antigravity.`,
      );
    }
  }
  if (env.ISSUE_FLOW_AGENT_MODEL !== undefined && env.ISSUE_FLOW_AGENT_MODEL !== '') {
    layer.model = env.ISSUE_FLOW_AGENT_MODEL;
  }
  const codex: CodexSettings = {};
  if (env.ISSUE_FLOW_CODEX_SANDBOX !== undefined) {
    if (
      env.ISSUE_FLOW_CODEX_SANDBOX === 'read-only' ||
      env.ISSUE_FLOW_CODEX_SANDBOX === 'workspace-write' ||
      env.ISSUE_FLOW_CODEX_SANDBOX === 'danger-full-access'
    ) {
      codex.sandbox = env.ISSUE_FLOW_CODEX_SANDBOX;
    } else {
      warn(`Ignoring ISSUE_FLOW_CODEX_SANDBOX="${env.ISSUE_FLOW_CODEX_SANDBOX}".`);
    }
  }
  if (env.ISSUE_FLOW_CODEX_REASONING_EFFORT !== undefined) {
    const effort = env.ISSUE_FLOW_CODEX_REASONING_EFFORT;
    if (
      effort === 'minimal' ||
      effort === 'low' ||
      effort === 'medium' ||
      effort === 'high' ||
      effort === 'xhigh'
    ) {
      codex.reasoningEffort = effort;
    } else {
      warn(`Ignoring ISSUE_FLOW_CODEX_REASONING_EFFORT="${effort}".`);
    }
  }
  if (env.ISSUE_FLOW_CODEX_IGNORE_USER_CONFIG !== undefined) {
    codex.ignoreUserConfig = parseBooleanEnv(env.ISSUE_FLOW_CODEX_IGNORE_USER_CONFIG);
  }
  if (Object.keys(codex).length > 0) layer.codex = codex;
  const cursor: CursorSettings = {};
  if (env.ISSUE_FLOW_CURSOR_SANDBOX !== undefined) {
    if (
      env.ISSUE_FLOW_CURSOR_SANDBOX === 'enabled' ||
      env.ISSUE_FLOW_CURSOR_SANDBOX === 'disabled'
    ) {
      cursor.sandbox = env.ISSUE_FLOW_CURSOR_SANDBOX;
    } else {
      warn(`Ignoring ISSUE_FLOW_CURSOR_SANDBOX="${env.ISSUE_FLOW_CURSOR_SANDBOX}".`);
    }
  }
  if (env.ISSUE_FLOW_CURSOR_PERMISSIONS_FILE !== undefined) {
    if (
      env.ISSUE_FLOW_CURSOR_PERMISSIONS_FILE === 'global' ||
      env.ISSUE_FLOW_CURSOR_PERMISSIONS_FILE === 'project' ||
      env.ISSUE_FLOW_CURSOR_PERMISSIONS_FILE === 'none'
    ) {
      cursor.permissionsFile = env.ISSUE_FLOW_CURSOR_PERMISSIONS_FILE;
    } else {
      warn(
        `Ignoring ISSUE_FLOW_CURSOR_PERMISSIONS_FILE="${env.ISSUE_FLOW_CURSOR_PERMISSIONS_FILE}".`,
      );
    }
  }
  if (Object.keys(cursor).length > 0) layer.cursor = cursor;
  const antigravity: AntigravitySettings = {};
  if (env.ISSUE_FLOW_ANTIGRAVITY_EFFORT !== undefined) {
    const effort = env.ISSUE_FLOW_ANTIGRAVITY_EFFORT;
    if (effort === 'low' || effort === 'medium' || effort === 'high') {
      antigravity.effort = effort;
    } else {
      warn(`Ignoring ISSUE_FLOW_ANTIGRAVITY_EFFORT="${effort}".`);
    }
  }
  if (env.ISSUE_FLOW_ANTIGRAVITY_SANDBOX !== undefined) {
    antigravity.sandbox = parseBooleanEnv(env.ISSUE_FLOW_ANTIGRAVITY_SANDBOX);
  }
  if (env.ISSUE_FLOW_ANTIGRAVITY_EXECUTE_TIMEOUT !== undefined) {
    antigravity.executeTimeout = env.ISSUE_FLOW_ANTIGRAVITY_EXECUTE_TIMEOUT;
  }
  if (Object.keys(antigravity).length > 0) layer.antigravity = antigravity;
  return layer;
}

function readAgentKey(
  raw: unknown,
  label: string,
  warn: (message: string) => void,
): AgentCliOverrides {
  if (raw === undefined) return {};
  const parsed = agentConfigInputSchema.safeParse(raw);
  if (!parsed.success) {
    warn(
      `Ignoring "agent" key of ${label}: ${parsed.error.issues[0]?.message ?? 'invalid value'}.`,
    );
    return {};
  }
  const phases = parsePhasesInput(
    raw !== null && typeof raw === 'object' && 'phases' in raw
      ? (raw as { phases?: unknown }).phases
      : undefined,
    warn,
  );
  return {
    ...(parsed.data.provider !== undefined ? { provider: parsed.data.provider } : {}),
    ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
    ...(parsed.data.claude !== undefined ? { claude: parsed.data.claude } : {}),
    ...(parsed.data.codex !== undefined ? { codex: parsed.data.codex } : {}),
    ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
    ...(parsed.data.antigravity !== undefined ? { antigravity: parsed.data.antigravity } : {}),
    ...(Object.keys(phases).length > 0 ? { phases } : {}),
  };
}

function pickOrigin(layers: Array<{ origin: AgentOrigin; value: unknown }>): AgentOrigin {
  let current: AgentOrigin = 'default';
  for (const layer of layers) {
    if (layer.value !== undefined) current = layer.origin;
  }
  return current;
}

type TrackedPhaseOrigins = Partial<
  Record<AgentPhase, { provider?: AgentOrigin; model?: AgentOrigin }>
>;

function mergeAgentBlockLayers(
  layers: Array<{ origin: AgentOrigin; block: AgentBlock | undefined }>,
): AgentBlock | undefined {
  let merged: AgentBlock = {};
  let any = false;
  for (const layer of layers) {
    if (layer.block === undefined) continue;
    any = true;
    merged = {
      ...merged,
      ...dropUndefinedBlock(layer.block),
      claude: { ...merged.claude, ...layer.block.claude },
      codex: { ...merged.codex, ...layer.block.codex },
      cursor: { ...merged.cursor, ...layer.block.cursor },
      antigravity: { ...merged.antigravity, ...layer.block.antigravity },
    };
  }
  return any ? merged : undefined;
}

function dropUndefinedBlock(block: AgentBlock): AgentBlock {
  const result: AgentBlock = {};
  if (block.provider !== undefined) result.provider = block.provider;
  if (block.model !== undefined) result.model = block.model;
  if (block.claude !== undefined) result.claude = block.claude;
  if (block.codex !== undefined) result.codex = block.codex;
  if (block.cursor !== undefined) result.cursor = block.cursor;
  if (block.antigravity !== undefined) result.antigravity = block.antigravity;
  return result;
}

/**
 * Resolve the `agent` key with the documented precedence:
 *
 *   default(claude) < ~/.issue-flow/config.json < .issue-flow.json
 *     < ISSUE_FLOW_* < CLI
 *
 * Nested `phases` and `codex`/`claude` are merged key by key so a project's
 * `phases.plan` cannot erase a global `phases.review`. Invalid values warn
 * and degrade; nothing throws.
 */
export async function loadAgentConfig(options: LoadAgentConfigOptions = {}): Promise<AgentConfig> {
  const canCache =
    options.cli === undefined &&
    options.env === undefined &&
    options.projectRoot === undefined &&
    options.globalRoot === undefined &&
    options.warn === undefined;
  if (canCache && cachedAgentConfig !== undefined) return cachedAgentConfig;

  const warn = options.warn ?? printWarning;
  const cli = options.cli ?? agentCliOverrides;
  const env = options.env ?? process.env;

  const globalFile = await loadGlobalConfig({
    env,
    globalRoot: options.globalRoot,
    warn,
  });
  const globalLayer = readAgentKey(globalFile.agent, GLOBAL_CONFIG_FILENAME, warn);

  const projectFile = await readProjectConfigFile(options.projectRoot, warn);
  const projectLayer = readAgentKey(projectFile?.agent, PROJECT_CONFIG_FILENAME, warn);
  const envLayer = readAgentEnv(env, warn);

  const provider = (cli.forceProvider ??
    cli.provider ??
    envLayer.provider ??
    projectLayer.provider ??
    globalLayer.provider ??
    'claude') as AgentProviderId;
  const model =
    cli.forceModel ??
    cli.model ??
    envLayer.model ??
    projectLayer.model ??
    globalLayer.model ??
    null;

  const claude = mergeConfigLayers<ClaudeSettings>({
    global: globalLayer.claude,
    project: projectLayer.claude,
    env: envLayer.claude,
    cli: cli.claude,
  });
  const codex = mergeConfigLayers<CodexSettings>({
    global: globalLayer.codex,
    project: projectLayer.codex,
    env: envLayer.codex,
    cli: cli.codex,
  });
  const cursor = mergeConfigLayers<CursorSettings>({
    global: globalLayer.cursor,
    project: projectLayer.cursor,
    env: envLayer.cursor,
    cli: cli.cursor,
  });
  const antigravity = mergeConfigLayers<AntigravitySettings>({
    global: globalLayer.antigravity,
    project: projectLayer.antigravity,
    env: envLayer.antigravity,
    cli: cli.antigravity,
  });

  const phases: AgentConfig['phases'] = {};
  const phaseOrigins: TrackedPhaseOrigins = {};
  for (const phase of AGENT_PHASES) {
    const block = mergeAgentBlockLayers([
      { origin: 'global', block: globalLayer.phases?.[phase] },
      { origin: 'project', block: projectLayer.phases?.[phase] },
      { origin: 'env', block: envLayer.phases?.[phase] },
      { origin: 'cli', block: cli.phases?.[phase] },
    ]);
    if (block && Object.keys(block).length > 0) {
      phases[phase] = block;
      phaseOrigins[phase] = {
        provider:
          block.provider !== undefined
            ? pickOrigin([
                { origin: 'global', value: globalLayer.phases?.[phase]?.provider },
                { origin: 'project', value: projectLayer.phases?.[phase]?.provider },
                { origin: 'env', value: envLayer.phases?.[phase]?.provider },
                { origin: 'cli', value: cli.phases?.[phase]?.provider },
              ])
            : undefined,
        model:
          block.model !== undefined
            ? pickOrigin([
                { origin: 'global', value: globalLayer.phases?.[phase]?.model },
                { origin: 'project', value: projectLayer.phases?.[phase]?.model },
                { origin: 'env', value: envLayer.phases?.[phase]?.model },
                { origin: 'cli', value: cli.phases?.[phase]?.model },
              ])
            : undefined,
      };
    }
  }

  setTrackedOrigins({
    provider: pickOrigin([
      { origin: 'default', value: 'claude' },
      { origin: 'global', value: globalLayer.provider },
      { origin: 'project', value: projectLayer.provider },
      { origin: 'env', value: envLayer.provider },
      { origin: 'cli', value: cli.forceProvider ?? cli.provider },
    ]),
    model: pickOrigin([
      { origin: 'default', value: undefined },
      { origin: 'global', value: globalLayer.model },
      { origin: 'project', value: projectLayer.model },
      { origin: 'env', value: envLayer.model },
      { origin: 'cli', value: cli.forceModel ?? cli.model },
    ]),
    phases: phaseOrigins,
  });

  const resolved = { provider, model, claude, codex, cursor, antigravity, phases };
  if (canCache) cachedAgentConfig = resolved;
  return resolved;
}

// ── Acceptance-contract configuration ───────────────────────────────────────

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

let routingCliOverrides: Partial<RoutingConfig> = {};

export function setRoutingCliOverrides(overrides: Partial<RoutingConfig>): void {
  routingCliOverrides = overrides;
}

export async function loadRoutingConfig(
  options: {
    projectRoot?: string;
    globalRoot?: string;
    env?: NodeJS.ProcessEnv;
    global?: RoutingConfigInput;
    warn?: (message: string) => void;
    cli?: RoutingConfigInput;
  } = {},
): Promise<RoutingConfig> {
  const warn = options.warn ?? printWarning;
  const global =
    options.global ??
    (
      await loadGlobalConfig({
        env: options.env ?? process.env,
        ...(options.globalRoot === undefined ? {} : { globalRoot: options.globalRoot }),
        warn,
      })
    ).routing;
  const file = await readProjectConfigFile(options.projectRoot, warn);
  const raw = file?.routing;
  const parsedResult = routingConfigInputSchema.safeParse(raw ?? {});
  if (!parsedResult.success) {
    warn(
      `Ignoring "routing" key of ${PROJECT_CONFIG_FILENAME}: ${parsedResult.error.issues[0]?.message ?? 'invalid value'}.`,
    );
  }
  const project = parsedResult.success ? parsedResult.data : {};
  const cli = options.cli ?? routingCliOverrides;
  const result = routingConfigSchema.safeParse({
    ...global,
    ...project,
    ...cli,
    escalation: {
      ...global?.escalation,
      ...project.escalation,
      ...cli.escalation,
    },
    ceilings: {
      ...global?.ceilings,
      ...project.ceilings,
      ...cli.ceilings,
    },
  });
  if (result.success) return result.data;
  warn(
    `Invalid routing configuration (${result.error.issues[0]?.message ?? 'invalid value'}); using defaults.`,
  );
  return routingConfigSchema.parse({});
}
