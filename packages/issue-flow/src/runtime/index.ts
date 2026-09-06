import { createHeadlessRuntime } from './headless.js';
import type { Runtime, RuntimeMode } from './types.js';

export { createHeadlessRuntime } from './headless.js';
export type {
  AgentHandle,
  DisposeOptions,
  PrepareInput,
  Runtime,
  RuntimeCapabilities,
  RuntimeContext,
  RuntimeIsolation,
  RuntimeMode,
  ServiceRuntimeState,
} from './types.js';

/**
 * Build the runtime for a mode.
 *
 * Only `headless` exists so far; `interactive` and `sandbox` arrive with the
 * tmux and Docker phases. Failing loudly here is deliberate — a mode that
 * silently fell back to `headless` would report an isolation it never provided,
 * and isolation is the whole reason to ask for another mode.
 */
export function createRuntime(mode: RuntimeMode): Runtime {
  switch (mode) {
    case 'headless':
      return createHeadlessRuntime();
    case 'interactive':
    case 'sandbox':
      throw new Error(
        `Runtime mode '${mode}' is not available in this release. Only 'headless' is implemented.`,
      );
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown runtime mode: ${String(exhaustive)}`);
    }
  }
}
