import {
  type PolicyConfig,
  type PolicyConfigInput,
  policyConfigInputSchema,
  policyConfigSchema,
} from '../schemas.js';
import { printWarning } from '../ui/logger.js';
import { dropNullish, mergeConfigLayers, parseBooleanEnv, readNumberEnv } from './layers.js';
import { PROJECT_CONFIG_FILENAME, readProjectConfigFile } from './sources.js';

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
