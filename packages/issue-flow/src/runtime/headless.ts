import { randomUUID } from 'node:crypto';
import { runnerFor } from '../agents/registry.js';
import type {
  AgentEvent,
  AgentInvocation,
  AgentRunResult,
  ResolvedAgentSettings,
} from '../agents/types.js';
import { createAgentEventQueue } from './event-queue.js';
import type {
  AgentHandle,
  DisposeOptions,
  PrepareInput,
  Runtime,
  RuntimeCapabilities,
  RuntimeContext,
} from './types.js';

/**
 * The default mode, and the one that must never change.
 *
 * It runs the agent exactly the way every release before the runtime contract
 * did: the registered runner, in the repository itself, on the branch the
 * pipeline already checked out. There is no worktree, no tmux, no container and
 * no daemon — a repository with none of those keeps working (ADR-03), which is
 * also what keeps CI working.
 *
 * This file is deliberately thin. It is a seam, not a layer: everything it adds
 * over calling the runner directly is the shape the other two modes need.
 */

const HEADLESS_CAPABILITIES: RuntimeCapabilities = {
  // The prompt travels in the argv of the agent's own process (ADR-04), and a
  // headless invocation is one process with no second channel into it. A
  // subsequent prompt is a new invocation, which is what the pipeline does.
  interactivePrompt: false,
  // The runner owns the child process and ends it on its own timeout; the
  // watchdog is what ends a silent one. Claiming an interrupt this mode cannot
  // deliver would be worse than declaring it absent.
  interrupt: false,
  livesBeyondInvocation: false,
  isolation: 'branch',
};

interface HeadlessHandle extends AgentHandle {
  /** Events collected from the runner, drained by `observe()`. */
  readonly events: AsyncIterable<AgentEvent>;
}

export function createHeadlessRuntime(): Runtime {
  return {
    mode: 'headless',
    capabilities: HEADLESS_CAPABILITIES,

    prepare: async (input: PrepareInput): Promise<RuntimeContext> => ({
      mode: 'headless',
      // The repository itself. The pipeline already put the branch in place;
      // preparing here must not touch git, or `headless` would start depending
      // on repository state it never depended on.
      workdir: input.projectRoot,
      isolation: 'branch',
      env: input.env ?? {},
      services: [],
    }),

    launch: async (
      context: RuntimeContext,
      invocation: AgentInvocation,
      settings: ResolvedAgentSettings,
    ): Promise<AgentHandle> => {
      const runner = runnerFor(settings.provider);
      const queue = createAgentEventQueue();

      // The invocation reaches the runner exactly as the caller built it —
      // `workingDirectory` included. This mode does not relocate the agent, so
      // pinning the directory to `context.workdir` would put an explicit `cwd`
      // on a spawn that never had one, which is a behaviour change however
      // equivalent the value looks. Relocation belongs to the modes whose
      // `prepare` actually created a different directory.
      const promise = runner
        .run(
          {
            ...invocation,
            onEvent: (event) => {
              queue.push(event);
              invocation.onEvent?.(event);
            },
          },
          settings,
        )
        .finally(() => queue.close());

      // Nobody is required to await the result, so an unobserved rejection must
      // not become an unhandled rejection. `result()` still rejects for the
      // caller that does await.
      promise.catch(() => {});

      const handle: HeadlessHandle = {
        id: randomUUID(),
        context,
        provider: settings.provider,
        events: queue.iterable,
        result: (): Promise<AgentRunResult> => promise,
      };
      return handle;
    },

    send: async () => {
      // No second channel into a headless process. Declared in `capabilities`
      // so a caller can ask before trying, rather than discovering it here.
    },

    interrupt: async () => {
      // Same: the runner's own timeout and the watchdog end a headless run.
    },

    observe: (handle: AgentHandle): AsyncIterable<AgentEvent> => (handle as HeadlessHandle).events,

    dispose: async (_context: RuntimeContext, _options?: DisposeOptions) => {
      // Nothing was created, so nothing is torn down. A `headless` dispose that
      // touched the repository would be exactly the dependency ADR-03 forbids.
    },
  };
}
