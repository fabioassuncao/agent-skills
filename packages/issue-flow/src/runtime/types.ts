import type {
  AgentEvent,
  AgentInvocation,
  AgentProviderId,
  AgentRunResult,
  ResolvedAgentSettings,
} from '../agents/types.js';

/**
 * One contract, three modes.
 *
 * The mode decides **where** an agent runs and **how** it is observed. It never
 * decides **what** runs: `AgentInvocation` and `AgentRunResult` keep their shape
 * (ADR-02), which is what lets failover, the watchdog, the resilience layer,
 * telemetry and the session reducer stay valid across all three.
 *
 * | Mode | Isolation | Process | Use |
 * |---|---|---|---|
 * | `headless` | branch in the repository | `execa`, stream-json | CI, the default, everything that works today |
 * | `interactive` | git worktree | tmux pane (TTY) | working with a human nearby |
 * | `sandbox` | worktree + container | `docker exec` in a tmux pane | untrusted code, conflicting dependencies |
 *
 * `headless` is the default and is never removed (ADR-03): a repository with no
 * tmux, no docker and no worktree must keep behaving exactly as it does today.
 */

export type RuntimeMode = 'headless' | 'interactive' | 'sandbox';

/** Where the agent's working directory comes from. */
export type RuntimeIsolation = 'branch' | 'worktree';

/** A long-running process the runtime keeps alongside the agent (§19). */
export interface ServiceRuntimeState {
  name: string;
  /** Allocated port, when the service declares one. */
  port: number | null;
  status: 'stopped' | 'starting' | 'ready' | 'failed';
  /** Human-readable reason, for `failed` and for a probe that timed out. */
  detail: string | null;
}

/**
 * What a worktree mode created, and therefore what its teardown owns.
 *
 * §27 calls this the `RuntimeSession` — worktree, env, ports, services,
 * container — and it is the one concept `headless` genuinely does not have, so
 * the field carrying it is optional and absent there. It exists because
 * `dispose()` receives a context rather than a handle, and "never remove what
 * you did not create" is only answerable if the context remembers which half of
 * what it points at this run brought into being.
 */
export interface RuntimeSessionBinding {
  branch: string;
  /** Run the invocation belongs to; how its lifecycle events are correlated. */
  runId: string;
  worktreeId: string | null;
  /** `runtime.env` of the worktree — what every pane sources before starting. */
  runtimeEnvPath: string;
  /** Whether `prepare()` created the checkout, or found one already there. */
  createdWorktree: boolean;
  /** Container the panes run inside. `null` on the host. */
  container: string | null;
  /** Whether `prepare()` started that container, or joined a running one. */
  containerLaunched: boolean;
  allocatedPorts: Record<string, number>;
}

/** What `prepare()` produced: everything `launch()` needs and nothing derivable. */
export interface RuntimeContext {
  mode: RuntimeMode;
  /** Repository root in `headless`; the worktree in the other two. */
  workdir: string;
  isolation: RuntimeIsolation;
  /**
   * Variables to add to the agent's environment. Empty means "inherit", which
   * is what `headless` does — it is the mode that must not change behaviour.
   */
  env: Record<string, string>;
  services: ServiceRuntimeState[];
  /**
   * What the worktree modes created. Absent in `headless`, which creates
   * nothing — an additive field, so the two modes that have no binding are
   * unchanged by its existence (ADR-02's rule, applied to this contract).
   */
  session?: RuntimeSessionBinding;
}

export interface PrepareInput {
  /** Repository root. The only input `headless` needs. */
  projectRoot: string;
  /** Branch the work belongs to. The worktree modes create it; `headless` assumes it. */
  branch?: string | null;
  /** Session id of the run, for correlating a runtime session to it. */
  runId?: string | null;
  /** Extra environment for the agent. */
  env?: Record<string, string>;
}

/** A launched agent. Opaque to the caller beyond what this interface exposes. */
export interface AgentHandle {
  readonly id: string;
  readonly context: RuntimeContext;
  readonly provider: AgentProviderId;
  /**
   * The invocation's result. Resolves exactly once; awaiting it repeatedly
   * yields the same value, and it rejects only for what would have thrown out
   * of the runner itself.
   */
  result(): Promise<AgentRunResult>;
}

export interface DisposeOptions {
  /** Remove the worktree. Ignored by a mode that did not create one. */
  removeWorktree?: boolean;
  /** Keep the branch after removing the worktree. */
  keepBranch?: boolean;
}

/**
 * What a mode can do, asked as a capability rather than by mode name.
 *
 * The same rule `AgentCapabilities` follows: a caller asks "can this runtime
 * deliver a subsequent prompt?", never "is this the headless one?". A fourth
 * mode would then add a file, not a set of conditionals.
 */
export interface RuntimeCapabilities {
  /** Whether `send()` reaches a live agent with a subsequent prompt. */
  interactivePrompt: boolean;
  /** Whether `interrupt()` reaches the running process. */
  interrupt: boolean;
  /** Whether `observe()` can yield after `result()` has resolved. */
  livesBeyondInvocation: boolean;
  isolation: RuntimeIsolation;
}

export interface Runtime {
  readonly mode: RuntimeMode;
  readonly capabilities: RuntimeCapabilities;
  /** Make the working directory (and, in the other modes, the session) ready. */
  prepare(input: PrepareInput): Promise<RuntimeContext>;
  launch(
    context: RuntimeContext,
    invocation: AgentInvocation,
    settings: ResolvedAgentSettings,
  ): Promise<AgentHandle>;
  /** Deliver a subsequent prompt. A no-op where `capabilities.interactivePrompt` is false. */
  send(handle: AgentHandle, text: string): Promise<void>;
  /** Ask the agent to stop. A no-op where `capabilities.interrupt` is false. */
  interrupt(handle: AgentHandle): Promise<void>;
  /** Normalised event stream. Ends when the invocation ends. */
  observe(handle: AgentHandle): AsyncIterable<AgentEvent>;
  dispose(context: RuntimeContext, options?: DisposeOptions): Promise<void>;
}
