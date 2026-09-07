import { parseAgentRuntimeEvent } from '../agents/hooks/contract.js';
import {
  type AgentHookSession,
  type StartAgentHookSessionInput,
  startAgentHookSession,
} from '../agents/hooks/runtime.js';
import { resolveAgentSessionDeps } from '../agents/session/context.js';
import {
  type AgentSessionDeps,
  ensureSessionWorktree,
  interruptAgentSession,
  listAgentSessions,
  openAgentSession,
  sendToAgentSession,
  stopAgentSession,
} from '../agents/session/open.js';
import type { AgentSession } from '../agents/session/types.js';
import type {
  AgentEvent,
  AgentInvocation,
  AgentProviderId,
  AgentRunResult,
  ResolvedAgentSettings,
} from '../agents/types.js';
import { loadRuntimeConfig } from '../config/runtime.js';
import type { PlanRepositoryContext } from '../storage/db/repository.js';
import { listAgentEvents, type StoredAgentEvent } from '../storage/db/repository.js';
import { type SerializedIntervalDependencies, startSerializedInterval } from '../utils/async.js';
import { createAgentEventQueue } from './event-queue.js';
import { type RuntimeProfile, resolveProfileSystemPrompt } from './profiles.js';
import {
  allocateServicePorts,
  createPortProbe,
  type PortProbe,
  probeServices,
  type ServiceSpec,
} from './services.js';
import { buildProjectSessionName } from './tmux/names.js';
import type {
  AgentHandle,
  DisposeOptions,
  PrepareInput,
  Runtime,
  RuntimeCapabilities,
  RuntimeContext,
  RuntimeMode,
  RuntimeSessionBinding,
  ServiceRuntimeState,
} from './types.js';
import { withWorktreeBranchLock } from './worktree/lock.js';
import type { WorktreeRuntimeKind } from './worktree/meta.js';

/**
 * The `interactive` mode: a git worktree, a tmux window, an agent in a pane.
 *
 * It is an **adapter**, not a layer. Everything it does already exists
 * somewhere else and is called from here rather than rebuilt (§25, invariant
 * 13): the checkout is `runtime/worktree/lifecycle.ts`, the window is
 * `runtime/tmux/layout.ts`, the argv is `agents/tty.ts`, the whole
 * worktree+window+agent act is `agents/session/open.ts`, the ports are
 * `runtime/services.ts`, and the prompt delivery is
 * `runtime/terminal/input.ts`. What this file adds is the shape of
 * `Runtime` — and one thing that genuinely did not exist yet: how an
 * invocation that runs in a pane *ends*.
 *
 * ### How `result()` and `observe()` know what happened
 *
 * A TUI in a pane emits no stream-json, and ADR-05/ADR-06 forbid reading the
 * screen to find out anything: a parser over a TUI produces output that is
 * plausible and wrong, and it breaks on every harness release. So the outcome
 * comes from where the agent itself reports it — its lifecycle hooks
 * (`agents/hooks/`), persisted into `agent_events` and correlated by
 * `runId` + `phase`, which is the correlation §18 fixed for this project.
 * `launch()` starts the hook session for exactly that reason; without it the
 * table stays empty and there is nothing to wait for.
 *
 * `AgentRunResult` keeps its shape (ADR-02) and the fields a pane genuinely
 * cannot know are left empty rather than invented — see `paneRunResult`.
 *
 * ### What it will not do
 *
 * It never falls back to `headless`. A "session" that quietly ran headless
 * would report an isolation it never provided, and isolation is the only reason
 * to ask for another mode. `prepare()` therefore refuses with a message naming
 * what is missing and how to get it.
 */

/** Both worktree modes answer the same capability set. */
export const PANE_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  // The pane is a live TTY and `sendPrompt` reaches it, which is the whole
  // point of the mode.
  interactivePrompt: true,
  // Ctrl-C into the pane, exactly as a person sitting in front of it.
  interrupt: true,
  // The window survives `result()`: the agent keeps working with nobody
  // watching, and reopening reattaches instead of restarting (§27).
  livesBeyondInvocation: true,
  isolation: 'worktree',
};

/** How often the lifecycle table is asked whether the invocation has ended. */
export const DEFAULT_LIFECYCLE_POLL_MS = 250;

/**
 * Consecutive lifecycle reads that may fail before the invocation is given up
 * on. A transient database lock must not end a run; a broken one must not hang
 * it forever.
 */
export const LIFECYCLE_READ_FAILURE_LIMIT = 5;

/**
 * A mode asked for on a machine that cannot provide it.
 *
 * A distinct type because the caller's answer is different in kind: this is not
 * "the run failed", it is "this run cannot start here", and the message is
 * expected to name the missing tool and how to install it.
 */
export class RuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeUnavailableError';
  }
}

/** Lifecycle events of one invocation, oldest first. */
export interface AgentLifecycleEventSource {
  list(input: { runId: string; phase: string }): Promise<StoredAgentEvent[]>;
}

/**
 * The default source: the `agent_events` table.
 *
 * The rows are written by `applyAgentRuntimeEvent` the moment a hook posts, so
 * reading them is reading the hooks — one persisted copy of the fact, not a
 * second source for it. Correlation is `runId` **and** `phase`: hooks outlive an
 * invocation, and a stale `agent_stopped` from the previous phase would end
 * this one the instant it started.
 */
export function createStoredLifecycleEvents(
  storage: PlanRepositoryContext,
): AgentLifecycleEventSource {
  return {
    list: async ({ runId, phase }) => {
      const events = await listAgentEvents({
        projectId: storage.projectId,
        runId,
        ...(storage.databaseOptions === undefined
          ? {}
          : { databaseOptions: storage.databaseOptions }),
      });
      return events.filter((event) => event.phase === phase);
    },
  };
}

export interface PaneRuntimeDeps {
  /** Everything `openAgentSession` needs. The single wiring, never a second one. */
  session: AgentSessionDeps;
  /**
   * Provider recorded on the worktree binding.
   *
   * Not the one that runs: that arrives with the invocation's `settings`, which
   * `prepare()` has not seen yet. This is the label the binding and
   * `ISSUE_FLOW_AGENT` carry.
   */
  provider: AgentProviderId;
  /** Services the project declares. Empty means no port is allocated or probed. */
  services?: readonly ServiceSpec[];
  /** Values every pane and hook of a new worktree exports. */
  startupEnv?: Record<string, string>;
  /** Profile system prompt, already expanded. Only a fresh launch receives it. */
  systemPrompt?: string;
  probe?: PortProbe;
  lifecycle?: AgentLifecycleEventSource;
  /** Installs the hooks and binds the control endpoint for one invocation. */
  startHooks?: (input: StartAgentHookSessionInput) => Promise<AgentHookSession | null>;
  pollIntervalMs?: number;
  /** Injected so a test drives the ticks instead of waiting for them. */
  scheduler?: SerializedIntervalDependencies;
  now?: () => Date;
  warn?: (message: string) => void;
}

/** What separates the two worktree modes: a container, or nothing. */
export interface PaneRuntimeAdapter {
  mode: RuntimeMode;
  /**
   * How the mode wires itself from a repository on disk, when the caller
   * injected nothing. Defaults to {@link resolvePaneRuntimeDeps}.
   */
  resolveDeps?: (projectRoot: string) => Promise<PaneRuntimeDeps>;
  /** Recorded on the worktree binding, and what `disposeRuntime` dispatches on. */
  worktreeRuntime: WorktreeRuntimeKind;
  /** Refuse *before* anything is created when the mode's tools are missing. */
  assertAvailable(deps: PaneRuntimeDeps): Promise<void>;
  /**
   * The container the panes will run inside, or `null` on the host.
   *
   * `launched` distinguishes the container this call started from one it joined:
   * a container that was already running belongs to whoever started it, and
   * `release()` may not remove it.
   */
  provision(input: {
    deps: PaneRuntimeDeps;
    branch: string;
    worktreePath: string;
    runtimeEnv: Record<string, string>;
  }): Promise<{ container: string; launched: boolean } | null>;
  /** Undo whatever `provision` created. Never touches what it found. */
  release(input: { deps: PaneRuntimeDeps; session: RuntimeSessionBinding }): Promise<void>;
}

/**
 * What `launch()` recorded and `dispose()` needs, kept per branch.
 *
 * Per branch and not per runtime: one instance serves every branch of a
 * project, so a teardown that reached across them would stop the sessions — and
 * cancel the outcome watchers — of work nobody asked it to touch.
 */
interface LaunchRecord {
  sessionIds: Set<string>;
  watches: Set<OutcomeWatch>;
}

function requireBinding(context: RuntimeContext): RuntimeSessionBinding {
  if (context.session === undefined) {
    throw new Error(
      `A '${context.mode}' runtime needs the context prepare() returned; this one carries no worktree binding.`,
    );
  }
  return context.session;
}

/**
 * The result of an invocation that ran in a pane.
 *
 * Three fields are deliberately empty, and each one is a fact the pane does not
 * have rather than a value worth guessing:
 *
 * - **`result` and `rawOutput`** — the agent's text is on the terminal, and the
 *   terminal is the one thing this runtime may not read (ADR-06). What the
 *   agent produced is in the files it wrote and in the events it reported.
 * - **`usage`** — tokens and cost are reported by the harness on the
 *   stream-json channel `headless` consumes. A TUI never emits them, and no
 *   hook carries them. `null` is the value the type already has for "not
 *   reported"; a zero would be a measurement nobody took.
 *
 * `exitCode` is a projection, not an observation: the pane's process exit code
 * is the shell's, not the agent's. `0`/`1` mirrors `success`, which is what
 * every consumer of this field actually reads.
 */
function paneRunResult(input: {
  success: boolean;
  error: string | null;
  provider: AgentProviderId;
  model: string | null;
}): AgentRunResult {
  return {
    success: input.success,
    result: '',
    rawOutput: '',
    exitCode: input.success ? 0 : 1,
    usage: null,
    error: input.error,
    agent: { provider: input.provider, model: input.model },
  };
}

/**
 * A lifecycle event, as the normalised stream every mode publishes.
 *
 * Nothing here ever produces `kind: 'text'`. Text is what a model wrote, and
 * this runtime has none of it: what it has is the agent telling it what it is
 * doing. Publishing a lifecycle transition as model output would put words in
 * the agent's mouth, so each one becomes an activity — which is exactly how the
 * existing consumer renders a `tool` event (`core/headless.ts`).
 */
function toAgentEvent(stored: StoredAgentEvent): AgentEvent | null {
  const event = parseAgentRuntimeEvent(stored.payload);
  // A row written by a newer release, or one that does not survive its own
  // validator, is skipped rather than guessed at.
  if (event === null) return null;

  switch (event.type) {
    case 'agent_status_changed':
      return { kind: 'tool', name: 'agent', detail: event.lifecycle };
    case 'agent_stopped':
      return { kind: 'tool', name: 'agent', detail: 'stopped' };
    case 'pr_opened':
      return {
        kind: 'tool',
        name: 'pr',
        ...(event.url === undefined ? {} : { detail: event.url }),
      };
    case 'runtime_error':
      return { kind: 'tool', name: 'error', detail: event.message };
  }
}

interface OutcomeWatch {
  events: AsyncIterable<AgentEvent>;
  result: Promise<AgentRunResult>;
  /** Stops polling without settling. Used when the runtime is torn down. */
  cancel: () => void;
}

/**
 * Wait for the invocation to end, publishing what happens on the way.
 *
 * The loop is `startSerializedInterval` — the project's single periodic
 * primitive — so two ticks never overlap on a slow read, and the tick itself
 * never rejects: this promise is not always awaited, and a rejection escaping
 * here would become an unhandled one.
 */
function watchOutcome(
  deps: PaneRuntimeDeps,
  lifecycle: AgentLifecycleEventSource,
  input: {
    runId: string;
    phase: string;
    provider: AgentProviderId;
    model: string | null;
    /** ms; `0` disables the ceiling, exactly as `AgentInvocation.timeout` does. */
    timeoutMs: number;
  },
): OutcomeWatch {
  const queue = createAgentEventQueue();
  const now = deps.now ?? ((): Date => new Date());
  const startedAt = now().getTime();

  let consumed = 0;
  let failures = 0;
  let lastError: string | null = null;
  let settled = false;
  let stop: (() => void) | null = null;

  let publish: (result: AgentRunResult) => void = () => {};
  const result = new Promise<AgentRunResult>((resolve) => {
    publish = resolve;
  });

  const finish = (outcome: { success: boolean; error: string | null }): void => {
    if (settled) return;
    settled = true;
    queue.close();
    stop?.();
    publish(paneRunResult({ ...outcome, provider: input.provider, model: input.model }));
  };

  const tick = async (): Promise<void> => {
    let events: StoredAgentEvent[];
    try {
      events = await lifecycle.list({ runId: input.runId, phase: input.phase });
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= LIFECYCLE_READ_FAILURE_LIMIT) {
        finish({
          success: false,
          error: `Could not read the agent's lifecycle events ${failures} times in a row: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      return;
    }

    for (const stored of events.slice(consumed)) {
      consumed += 1;
      const event = toAgentEvent(stored);
      if (event !== null) queue.push(event);

      if (stored.type === 'runtime_error') {
        const parsed = parseAgentRuntimeEvent(stored.payload);
        lastError = parsed?.type === 'runtime_error' ? parsed.message : 'runtime error';
        // A reported error ends the invocation: the agent said it could not
        // continue, and waiting for a `agent_stopped` that may never come would
        // turn a known failure into a timeout.
        finish({ success: false, error: lastError });
        return;
      }
      if (stored.type === 'agent_stopped') {
        finish({ success: lastError === null, error: lastError });
        return;
      }
    }

    if (input.timeoutMs > 0 && now().getTime() - startedAt >= input.timeoutMs) {
      // The pane is left alone on purpose. `livesBeyondInvocation` is true, so
      // an agent that is simply slow keeps its window, its conversation and its
      // work; ending it is `interrupt()` or `dispose()`, both of which are the
      // caller's explicit act.
      finish({
        success: false,
        error: `The agent did not report finishing '${input.phase}' within ${input.timeoutMs} ms. Its pane is still open.`,
      });
    }
  };

  stop = startSerializedInterval(
    tick,
    deps.pollIntervalMs ?? DEFAULT_LIFECYCLE_POLL_MS,
    deps.scheduler ?? {},
  );

  return {
    events: queue.iterable,
    result,
    cancel: () => {
      stop?.();
      queue.close();
    },
  };
}

interface PaneAgentHandle extends AgentHandle {
  readonly sessionId: string;
  readonly paneTarget: string | null;
  readonly events: AsyncIterable<AgentEvent>;
}

function paneHandle(handle: AgentHandle): PaneAgentHandle {
  const candidate = handle as Partial<PaneAgentHandle>;
  if (typeof candidate.sessionId !== 'string') {
    throw new Error('This handle was not produced by a worktree runtime.');
  }
  return handle as PaneAgentHandle;
}

/**
 * The shared implementation of both worktree modes.
 *
 * `interactive` and `sandbox` differ by a container and nothing else, so they
 * are one implementation with two adapters rather than two files that drift.
 * §36 asks for both files; this is what each of them is a few lines of.
 */
export function createPaneRuntime(
  adapter: PaneRuntimeAdapter,
  provided?: PaneRuntimeDeps,
): Runtime {
  const launched = new Map<string, LaunchRecord>();
  let resolved: PaneRuntimeDeps | null = provided ?? null;

  async function depsFor(projectRoot: string): Promise<PaneRuntimeDeps> {
    resolved ??= await (adapter.resolveDeps ?? resolvePaneRuntimeDeps)(projectRoot);
    return resolved;
  }

  function depsOrThrow(): PaneRuntimeDeps {
    if (resolved === null) {
      throw new Error(
        `A '${adapter.mode}' runtime must be prepared before it is used; call prepare() first.`,
      );
    }
    return resolved;
  }

  return {
    mode: adapter.mode,
    capabilities: PANE_RUNTIME_CAPABILITIES,

    prepare: async (input: PrepareInput): Promise<RuntimeContext> => {
      const deps = await depsFor(input.projectRoot);
      const branch = input.branch?.trim();
      if (branch === undefined || branch === '') {
        throw new Error(
          `A '${adapter.mode}' runtime needs the branch to work on: it is what the worktree, the tmux window and the container are all named after.`,
        );
      }
      const runId = input.runId?.trim();
      if (runId === undefined || runId === '') {
        throw new Error(
          `A '${adapter.mode}' runtime needs the run id: the agent reports what it is doing through its hooks, and those are correlated by run and phase (ADR-05). Without one an invocation could be started but never observed.`,
        );
      }

      // Before anything is created, so a machine without the tools does not end
      // up with a half-prepared worktree it never asked for.
      await adapter.assertAvailable(deps);

      const services = deps.services ?? [];
      const existing = await deps.session.worktrees.list();
      const allocatedPorts = allocateServicePorts(
        existing.map((worktree) => ({ allocatedPorts: worktree.binding?.allocatedPorts ?? {} })),
        services,
      );

      const worktree = await ensureSessionWorktree(deps.session, {
        branch,
        agent: deps.provider,
        runtime: adapter.worktreeRuntime,
        allocatedPorts,
        ...(deps.startupEnv === undefined ? {} : { startupEnvValues: deps.startupEnv }),
      });

      const portEnv = Object.fromEntries(
        Object.entries(worktree.allocatedPorts).map(([key, port]) => [key, String(port)]),
      );
      const env = { ...(deps.startupEnv ?? {}), ...portEnv, ...(input.env ?? {}) };

      const provisioned = await adapter.provision({
        deps,
        branch,
        worktreePath: worktree.path,
        runtimeEnv: env,
      });

      // The project's tmux session, which every window of every worktree hangs
      // off. `ensureSessionLayout` would do it too; doing it here is what makes
      // "prepare created the session" true even before an agent is launched.
      await deps.session.tmux.ensureServer();
      await deps.session.tmux.ensureSession(
        buildProjectSessionName(deps.session.projectId),
        worktree.path,
      );

      const serviceStates: ServiceRuntimeState[] =
        services.length === 0
          ? []
          : (
              await probeServices(
                services,
                worktree.allocatedPorts,
                deps.probe ?? createPortProbe(),
                env,
              )
            ).map(({ name, port, status, detail }) => ({ name, port, status, detail }));

      return {
        mode: adapter.mode,
        workdir: worktree.path,
        isolation: 'worktree',
        env,
        services: serviceStates,
        session: {
          branch,
          runId,
          worktreeId: worktree.worktreeId,
          runtimeEnvPath: worktree.runtimeEnvPath,
          createdWorktree: worktree.created,
          container: provisioned?.container ?? null,
          containerLaunched: provisioned?.launched ?? false,
          allocatedPorts: worktree.allocatedPorts,
        },
      };
    },

    launch: async (
      context: RuntimeContext,
      invocation: AgentInvocation,
      settings: ResolvedAgentSettings,
    ): Promise<AgentHandle> => {
      const deps = depsOrThrow();
      const binding = requireBinding(context);

      // Installs the hook files in the worktree and binds the control endpoint
      // the agent posts to. It is what makes `result()` answerable at all —
      // and it returns `null` when reporting is disabled, which is a degraded
      // but legitimate state the caller is told about through the timeout.
      const hooks = await (deps.startHooks ?? startAgentHookSession)({
        phase: invocation.phase,
        runId: binding.runId,
        workingDirectory: context.workdir,
        ...(deps.warn === undefined ? {} : { onWarn: deps.warn }),
      });

      const opened = await openAgentSession(
        {
          ...deps.session,
          ...(binding.container === null ? {} : { container: binding.container }),
        },
        {
          provider: settings.provider,
          permission: invocation.permission,
          branch: binding.branch,
          prompt: invocation.prompt,
          model: settings.model,
          runId: binding.runId,
          phase: invocation.phase,
          ...(deps.systemPrompt === undefined ? {} : { systemPrompt: deps.systemPrompt }),
        },
      );

      const record = launched.get(binding.branch) ?? {
        sessionIds: new Set<string>(),
        watches: new Set<OutcomeWatch>(),
      };
      record.sessionIds.add(opened.session.id);
      launched.set(binding.branch, record);

      const watch = watchOutcome(
        deps,
        deps.lifecycle ?? createStoredLifecycleEvents(deps.session.storage),
        {
          runId: binding.runId,
          phase: invocation.phase,
          provider: settings.provider,
          model: settings.model,
          timeoutMs: invocation.timeout,
        },
      );
      record.watches.add(watch);
      // The hooks live exactly as long as the invocation: their files are in the
      // user's working tree, and a leftover hook would fire into an endpoint
      // that no longer exists.
      void watch.result.finally(() => {
        record.watches.delete(watch);
        void hooks?.close();
      });

      const handle: PaneAgentHandle = {
        id: opened.session.id,
        sessionId: opened.session.id,
        paneTarget: opened.paneTarget,
        context,
        provider: settings.provider,
        events: watch.events,
        result: () => watch.result,
      };
      return handle;
    },

    send: async (handle: AgentHandle, text: string): Promise<void> => {
      const deps = depsOrThrow();
      const session = await requireSession(deps, paneHandle(handle).sessionId);
      await sendToAgentSession(deps.session, session, text);
    },

    interrupt: async (handle: AgentHandle): Promise<void> => {
      const deps = depsOrThrow();
      const session = await requireSession(deps, paneHandle(handle).sessionId);
      await interruptAgentSession(deps.session, session);
    },

    observe: (handle: AgentHandle): AsyncIterable<AgentEvent> => paneHandle(handle).events,

    /**
     * Tear down what this runtime created, and nothing else.
     *
     * The order is the reverse of `prepare`: the sessions this runtime started
     * stop first (which kills the window only when no other live session is
     * still on the branch — the rule lives in `stopAgentSession` and is not
     * restated here), then the container this prepare launched, then — only
     * when asked, and only when this prepare created it — the worktree.
     */
    dispose: async (context: RuntimeContext, options: DisposeOptions = {}): Promise<void> => {
      const deps = depsOrThrow();
      const binding = requireBinding(context);
      const warn = deps.warn ?? ((): void => {});
      const disposeBranch = async (): Promise<void> => {
        const record = launched.get(binding.branch);
        for (const watch of record?.watches ?? []) watch.cancel();

        for (const id of record?.sessionIds ?? []) {
          const session = await findSession(deps, id);
          if (session === null) continue;
          await stopAgentSession(deps.session, session);
        }
        launched.delete(binding.branch);

        await adapter.release({ deps, session: binding });

        if (options.removeWorktree !== true) return;
        if (!binding.createdWorktree) {
          // ADR-08 in its smallest form: this runtime did not bring the worktree
          // into existence, so it is not the one that gets to end it. Somebody
          // else's checkout — and whatever is uncommitted in it — is not ours to
          // delete because a teardown asked politely.
          warn(
            `Leaving the worktree for ${binding.branch} in place: this run found it rather than creating it.`,
          );
          return;
        }
        await deps.session.worktrees.remove(binding.branch, {
          force: true,
          ...(options.keepBranch === true ? { keepBranch: true } : {}),
        });
      };

      if (options.removeWorktree !== true || !binding.createdWorktree) {
        await disposeBranch();
        return;
      }
      await withWorktreeBranchLock(deps.session.projectId, binding.branch, disposeBranch, {
        lockDir: deps.session.worktreeLockDir,
      });
    },
  };
}

/**
 * The session row a handle points at.
 *
 * Read back rather than captured: the row carries the pane target, and a
 * reconciliation pass may have moved or orphaned it since the launch. The
 * handle holds the id, which is the thing that does not change.
 */
async function findSession(deps: PaneRuntimeDeps, sessionId: string): Promise<AgentSession | null> {
  const sessions = await listAgentSessions(deps.session.storage);
  return sessions.find((session) => session.id === sessionId) ?? null;
}

async function requireSession(deps: PaneRuntimeDeps, sessionId: string): Promise<AgentSession> {
  const session = await findSession(deps, sessionId);
  if (session === null) {
    throw new Error(
      `Session ${sessionId} is no longer recorded, so there is nothing to type into.`,
    );
  }
  return session;
}

/**
 * The default wiring, resolved from a repository on disk.
 *
 * It reuses `resolveAgentSessionDeps` rather than assembling a second worktree
 * manager, tmux gateway and profile lookup: two entry points with their own
 * wiring is how they start disagreeing about which profile a session used
 * (§25).
 */
export async function resolvePaneRuntimeDeps(
  projectRoot: string,
  options: { profile?: string } = {},
): Promise<PaneRuntimeDeps> {
  const { loadAgentConfig } = await import('../config.js');
  const context = await resolveAgentSessionDeps({
    projectRoot,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
  });
  const runtime = await loadRuntimeConfig({ projectRoot });
  const profile: RuntimeProfile | undefined = runtime.profiles[context.profileName];
  const systemPrompt =
    profile === undefined ? undefined : resolveProfileSystemPrompt(profile, runtime.startupEnv);

  return {
    session: context.deps,
    provider: (await loadAgentConfig()).provider,
    services: runtime.services,
    startupEnv: runtime.startupEnv,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  };
}

/**
 * The host adapter — and the base the sandbox one extends.
 *
 * Exported so `sandbox.ts` can reuse the tmux requirement instead of restating
 * it: the sandbox is the interactive mode plus a container, so tmux missing is
 * still the first thing that goes wrong there.
 */
export function createInteractiveRuntimeAdapter(): PaneRuntimeAdapter {
  return {
    mode: 'interactive',
    worktreeRuntime: 'host',
    assertAvailable: async (runtimeDeps) => {
      if (await runtimeDeps.session.tmux.isAvailable()) return;
      throw new RuntimeUnavailableError(
        "The 'interactive' runtime needs tmux, which is not installed. Install it (`brew install tmux`, `apt install tmux`) or run headless: `issue-flow run` needs neither tmux nor a worktree.",
      );
    },
    // Nothing to provision on the host: the worktree *is* the isolation.
    provision: async () => null,
    release: async () => {},
  };
}

/** The `interactive` mode: worktree + tmux, on the host. */
export function createInteractiveRuntime(deps?: PaneRuntimeDeps): Runtime {
  return createPaneRuntime(createInteractiveRuntimeAdapter(), deps);
}
