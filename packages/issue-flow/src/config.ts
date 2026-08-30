/**
 * Configuration façade — re-exports the public surface of `src/config/`.
 * Domains live under `./config/`; this file must not hold loader logic.
 */

import {
  GLOBAL_CONFIG_FILENAME,
  type LoadGlobalConfigOptions,
  PROJECT_CONFIG_FILENAME,
  loadGlobalConfig,
} from './config/sources.js';

export { DEFAULTS, createConfig, resolvePaths } from './config/engine.js';
export { getInstallHint, validateDependencies } from './config/dependencies.js';

export type { ConfigLayers } from './config/layers.js';
export { mergeConfigLayers } from './config/layers.js';

export {
  GLOBAL_CONFIG_FILENAME,
  type LoadGlobalConfigOptions,
  PROJECT_CONFIG_FILENAME,
  loadGlobalConfig,
};

/** @deprecated Use {@link PROJECT_CONFIG_FILENAME}. Historical alias kept for call-site compatibility. */
export const WEB_CONFIG_FILENAME = PROJECT_CONFIG_FILENAME;

export {
  type LoadWebConfigOptions,
  loadWebConfig,
  setWebCliOverrides,
} from './config/web.js';

export {
  type LoadIssuesConfigOptions,
  loadIssuesConfig,
  setIssuesCliOverrides,
} from './config/issues.js';

export {
  type LoadPrReviewConfigOptions,
  loadPrReviewConfig,
} from './config/pr-review.js';

export {
  type LoadPolicyConfigOptions,
  loadPolicyConfig,
  setPolicyCliOverrides,
} from './config/policy.js';

export {
  type LoadTelemetryConfigOptions,
  loadTelemetryConfig,
} from './config/telemetry.js';

export {
  type LoadResilienceConfigOptions,
  getActiveResilienceConfig,
  initResilienceConfig,
  loadResilienceConfig,
  setActiveResilienceConfig,
  setResilienceCliOverrides,
} from './config/resilience.js';

export type { AgentCliOverrides, AgentConfig } from './config/agent.js';
export {
  type LoadAgentConfigOptions,
  getAgentCliOverrides,
  loadAgentConfig,
  setAgentCliOverrides,
} from './config/agent.js';

export {
  type LoadVerifyConfigOptions,
  loadVerifyConfig,
  setVerifyCliOverrides,
} from './config/verify.js';

export { loadRoutingConfig, setRoutingCliOverrides } from './config/routing.js';
