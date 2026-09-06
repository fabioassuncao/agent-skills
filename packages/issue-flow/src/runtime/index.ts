import { createHeadlessRuntime } from './headless.js';
import { createInteractiveRuntime } from './interactive.js';
import { createSandboxRuntime } from './sandbox.js';
import type { Runtime, RuntimeMode } from './types.js';

export { createHeadlessRuntime } from './headless.js';
export {
  type AgentLifecycleEventSource,
  createInteractiveRuntime,
  createPaneRuntime,
  createStoredLifecycleEvents,
  type PaneRuntimeAdapter,
  type PaneRuntimeDeps,
  RuntimeUnavailableError,
  resolvePaneRuntimeDeps,
} from './interactive.js';
export {
  createSandboxRuntime,
  requireDockerProfile,
  resolveSandboxRuntimeDeps,
  type SandboxRuntimeDeps,
} from './sandbox.js';
export type {
  AgentHandle,
  DisposeOptions,
  PrepareInput,
  Runtime,
  RuntimeCapabilities,
  RuntimeContext,
  RuntimeIsolation,
  RuntimeMode,
  RuntimeSessionBinding,
  ServiceRuntimeState,
} from './types.js';

/**
 * Build the runtime for a mode.
 *
 * The three modes are real implementations of one contract, and choosing
 * between them is the only decision this function makes. Nothing is created
 * here: `interactive` and `sandbox` resolve their own wiring on the first
 * `prepare()`, from the `projectRoot` it is given, so building one costs
 * nothing on a machine that never uses it.
 *
 * **No mode ever falls back to another.** A `sandbox` that quietly ran
 * `interactive` — or an `interactive` that quietly ran `headless` — would
 * report an isolation it never provided, and isolation is the whole reason to
 * ask for another mode. A machine without tmux or without a Docker daemon is
 * refused by `prepare()`, with a message naming what is missing and how to get
 * it; `headless` keeps working there exactly as it always did (ADR-03).
 */
export function createRuntime(mode: RuntimeMode): Runtime {
  switch (mode) {
    case 'headless':
      return createHeadlessRuntime();
    case 'interactive':
      return createInteractiveRuntime();
    case 'sandbox':
      return createSandboxRuntime();
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown runtime mode: ${String(exhaustive)}`);
    }
  }
}
