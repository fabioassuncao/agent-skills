/**
 * Configuration façade — re-exports the public surface of `src/config/`.
 * Domains live under `./config/`; this file must not hold loader logic.
 */

import {
  GLOBAL_CONFIG_FILENAME,
  type LoadGlobalConfigOptions,
  loadGlobalConfig,
  PROJECT_CONFIG_FILENAME,
} from './config/sources.js';

export { loadAutoNameConfig } from './config/auto-name.js';
export { getInstallHint, validateDependencies } from './config/dependencies.js';
export { createConfig, DEFAULTS, resolvePaths } from './config/engine.js';

export type { ConfigLayers } from './config/layers.js';
export { mergeConfigLayers } from './config/layers.js';

export {
  GLOBAL_CONFIG_FILENAME,
  type LoadGlobalConfigOptions,
  loadGlobalConfig,
  PROJECT_CONFIG_FILENAME,
};

/** @deprecated Use {@link PROJECT_CONFIG_FILENAME}. Historical alias kept for call-site compatibility. */
export const WEB_CONFIG_FILENAME = PROJECT_CONFIG_FILENAME;

export type { AgentCliOverrides, AgentConfig } from './config/agent.js';
export {
  getAgentCliOverrides,
  type LoadAgentConfigOptions,
  loadAgentConfig,
  setAgentCliOverrides,
} from './config/agent.js';
export {
  type CustomAgentsConfig,
  type LoadCustomAgentsConfigOptions,
  loadCustomAgentsConfig,
  persistCustomAgent,
  removeCustomAgent,
} from './config/custom-agents.js';
export {
  type LoadGitHubConfigOptions,
  loadGitHubConfig,
  persistGitHubAutoRemoveOnMerge,
} from './config/github.js';
export {
  type LoadIssuesConfigOptions,
  loadIssuesConfig,
  setIssuesCliOverrides,
} from './config/issues.js';
export {
  type LinearConfig,
  type LoadLinearConfigOptions,
  linearApiKey,
  loadLinearConfig,
  persistLinearAutoCreate,
} from './config/linear.js';
export {
  type LoadPolicyConfigOptions,
  loadPolicyConfig,
  setPolicyCliOverrides,
} from './config/policy.js';
export {
  type LoadPrReviewConfigOptions,
  loadPrReviewConfig,
} from './config/pr-review.js';
export {
  getActiveResilienceConfig,
  initResilienceConfig,
  type LoadResilienceConfigOptions,
  loadResilienceConfig,
  setActiveResilienceConfig,
  setResilienceCliOverrides,
} from './config/resilience.js';
export { loadRoutingConfig, setRoutingCliOverrides } from './config/routing.js';
export { type LoadRunConfigOptions, loadRunConfig } from './config/run.js';
export {
  type LoadRuntimeConfigOptions,
  loadRuntimeConfig,
  type RuntimeConfig,
  setRuntimeCliOverrides,
} from './config/runtime.js';
export {
  type LoadTelemetryConfigOptions,
  loadTelemetryConfig,
} from './config/telemetry.js';

export {
  type LoadVerifyConfigOptions,
  loadVerifyConfig,
  setVerifyCliOverrides,
} from './config/verify.js';
export {
  type LoadWebConfigOptions,
  loadWebConfig,
  setWebCliOverrides,
} from './config/web.js';
