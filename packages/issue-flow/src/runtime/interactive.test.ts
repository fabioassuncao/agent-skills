import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentSessionDeps, AgentSessionError } from '../agents/session/open.js';
import { listSessions } from '../agents/session/store.js';
import type {
  AgentEvent,
  AgentInvocation,
  AgentPhase,
  ResolvedAgentSettings,
} from '../agents/types.js';
import type { StoredAgentEvent } from '../storage/db/repository.js';
import {
  type PlanRepositoryContext,
  resetPlanRepositories,
  saveWorktree,
} from '../storage/db/repository.js';
import { acquireRunLock } from '../storage/lock.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import {
  type AgentLifecycleEventSource,
  createInteractiveRuntime,
  type PaneRuntimeDeps,
} from './interactive.js';
import type { PaneTemplate } from './profiles.js';
import type { ServiceSpec } from './services.js';
import type { TmuxGateway } from './tmux/gateway.js';
import { buildProjectSessionName, type TmuxWindowSummary } from './tmux/names.js';
import type { CreatedWorktree, ManagedWorktree } from './worktree/lifecycle.js';
import { getWorktreeMutationLockPath } from './worktree/lock.js';

/**
 * The `interactive` runtime, with every port injected.
 *
 * What these cases defend is that the mode is an *adapter*: the worktree comes
 * from the worktree manager, the window from the tmux layout, the command from
 * the argv builder, and — the one that is easy to get wrong — the outcome from
 * the agent's own lifecycle events rather than from the screen. A test that
 * needs a real tmux server lives in `interactive.integration.test.ts`.
 */

const PANES: readonly PaneTemplate[] = [
  { id: 'agent', kind: 'agent', focus: true },
  { id: 'shell', kind: 'shell', split: 'right', sizePct: 25 },
];

const SETTINGS: ResolvedAgentSettings = {
  provider: 'claude',
  model: 'sonnet',
  claude: {},
  codex: {},
  cursor: {},
  antigravity: {},
  opencode: {},
  origin: { provider: 'default', model: 'default' },
};

function invocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    prompt: 'implement the parser',
    phase: 'execute',
    timeout: 0,
    permission: 'autonomous',
    ...overrides,
  };
}

/** A tmux server that remembers windows, and every command typed into a pane. */
function fakeTmux(): TmuxGateway & {
  windows: Map<string, number>;
  commands: Array<{ target: string; command: string }>;
  pastes: Array<{ target: string; content: string }>;
  keys: Array<{ target: string; keys: string[] }>;
  sessions: string[];
} {
  const windows = new Map<string, number>();
  const commands: Array<{ target: string; command: string }> = [];
  const pastes: Array<{ target: string; content: string }> = [];
  const keys: Array<{ target: string; keys: string[] }> = [];
  const sessions: string[] = [];
  const pending = new Map<string, string>();
  const paneLocations = new Map<string, { sessionName: string; windowName: string }>();
  const paneByCoordinate = new Map<string, string>();
  const paneOwners = new Map<string, { sessionName: string; token: string }>();
  let nextPane = 1;
  let current: { session: string; window: string } | null = null;
  const key = (session: string, window: string): string => `${session}:${window}`;

  return {
    windows,
    commands,
    pastes,
    keys,
    sessions,
    isAvailable: async () => true,
    ensureServer: async () => {},
    ensureSession: async (sessionName) => {
      sessions.push(sessionName);
    },
    hasWindow: async (session, window) => windows.has(key(session, window)),
    hasWindowStrict: async (session, window) => windows.has(key(session, window)),
    killWindow: async (session, window) => {
      windows.delete(key(session, window));
      for (const [pane, location] of paneLocations) {
        if (location.sessionName === session && location.windowName === window) {
          paneLocations.delete(pane);
          paneOwners.delete(pane);
        }
      }
    },
    killWindowStrict: async (session, window) => {
      windows.delete(key(session, window));
      for (const [pane, location] of paneLocations) {
        if (location.sessionName === session && location.windowName === window) {
          paneLocations.delete(pane);
          paneOwners.delete(pane);
        }
      }
    },
    createWindow: async ({ sessionName, windowName }) => {
      windows.set(key(sessionName, windowName), 1);
      current = { session: sessionName, window: windowName };
      const pane = `%${nextPane++}`;
      paneLocations.set(pane, { sessionName, windowName });
      paneByCoordinate.set(`${sessionName}:${windowName}.0`, pane);
    },
    splitWindow: async () => {
      if (current === null) return;
      const k = key(current.session, current.window);
      const index = windows.get(k) ?? 0;
      windows.set(k, index + 1);
      const pane = `%${nextPane++}`;
      paneLocations.set(pane, { sessionName: current.session, windowName: current.window });
      paneByCoordinate.set(`${current.session}:${current.window}.${index}`, pane);
    },
    setWindowOption: async () => {},
    runCommand: async (target, command) => {
      commands.push({ target, command });
    },
    sendLiteral: async () => {},
    sendKeys: async (target, sent) => {
      keys.push({ target, keys: sent });
    },
    sendHexKeys: async () => {},
    loadBuffer: async (name, content) => {
      pending.set(name, content);
    },
    pasteBuffer: async ({ bufferName, target }) => {
      pastes.push({ target, content: pending.get(bufferName) ?? '' });
      pending.delete(bufferName);
    },
    hasBuffer: async (name) => pending.has(name),
    selectPane: async () => {},
    listWindows: async (): Promise<TmuxWindowSummary[]> =>
      [...windows.entries()].map(([k, paneCount]) => {
        const [sessionName = '', windowName = ''] = k.split(':');
        return { sessionName, windowName, paneCount };
      }),
    getPaneId: async (target) => paneByCoordinate.get(target) ?? target,
    getPaneIdentity: async (target) => {
      const location = paneLocations.get(target);
      if (location === undefined) throw new Error(`missing pane ${target}`);
      const owner = paneOwners.get(target);
      return {
        paneId: target,
        sessionName: owner?.sessionName ?? location.sessionName,
        windowName: location.windowName,
        ownerToken: owner?.token ?? null,
      };
    },
    tagPaneOwner: async (target, token, sessionName) => {
      paneOwners.set(target, { sessionName, token });
    },
    hasPaneStrict: async (target) => paneLocations.has(target),
    countPanes: async (session, window) => windows.get(key(session, window)) ?? 0,
    killPane: async (target) => {
      paneLocations.delete(target);
      paneOwners.delete(target);
    },
    killPaneStrict: async (target) => {
      paneLocations.delete(target);
      paneOwners.delete(target);
    },
    swapPanes: async (source, destination) => {
      const left = paneLocations.get(source);
      const right = paneLocations.get(destination);
      if (left === undefined || right === undefined) throw new Error('missing swap pane');
      paneLocations.set(source, right);
      paneLocations.set(destination, left);
    },
    movePaneToWindow: async (source, destination) => {
      const colon = destination.indexOf(':');
      paneLocations.set(source, {
        sessionName: destination.slice(0, colon),
        windowName: destination.slice(colon + 1),
      });
    },
  };
}

/** A worktree manager backed by a map, so no `git worktree add` is involved. */
function fakeWorktrees(seed: ManagedWorktree[] = []): AgentSessionDeps['worktrees'] & {
  created: Array<{ branch: string; allocatedPorts?: Record<string, number>; runtime?: string }>;
  removed: Array<{ branch: string; keepBranch?: boolean }>;
} {
  const created: Array<{
    branch: string;
    allocatedPorts?: Record<string, number>;
    runtime?: string;
  }> = [];
  const removed: Array<{ branch: string; keepBranch?: boolean }> = [];
  const live = new Map(seed.map((worktree) => [worktree.branch, worktree]));

  return {
    created,
    removed,
    create: async (input): Promise<CreatedWorktree> => {
      created.push({
        branch: input.branch,
        ...(input.allocatedPorts === undefined ? {} : { allocatedPorts: input.allocatedPorts }),
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      });
      const path = `/worktrees/${input.branch}`;
      live.set(input.branch, {
        branch: input.branch,
        path,
        entry: { path, branch: input.branch, head: null, bare: false, detached: false },
        binding: null,
        state: 'unmanaged',
      } as ManagedWorktree);
      return {
        branch: input.branch,
        worktreeId: `wt-${input.branch}`,
        path,
        meta: {
          branch: input.branch,
          allocatedPorts: input.allocatedPorts ?? {},
        } as CreatedWorktree['meta'],
        runtimeEnvPath: `${path}/.git/issue-flow/runtime.env`,
      };
    },
    list: async () => [...live.values()],
    remove: async (branch, options) => {
      removed.push({
        branch,
        ...(options?.keepBranch === undefined ? {} : { keepBranch: options.keepBranch }),
      });
      live.delete(branch);
    },
  };
}

/** A lifecycle source a test appends to, standing in for `agent_events`. */
function fakeLifecycle(): AgentLifecycleEventSource & {
  emit: (event: {
    runId: string;
    phase: string;
    type: string;
    lifecycle?: string;
    message?: string;
  }) => void;
  reads: number;
} {
  const rows: StoredAgentEvent[] = [];
  const source = {
    reads: 0,
    emit: (event: {
      runId: string;
      phase: string;
      type: string;
      lifecycle?: string;
      message?: string;
    }): void => {
      const at = new Date().toISOString();
      rows.push({
        runId: event.runId,
        phase: event.phase,
        type: event.type,
        lifecycle: event.lifecycle ?? null,
        payload: { ...event, occurredAt: at },
        occurredAt: at,
        recordedAt: at,
      });
    },
    list: async ({ runId, phase }: { runId: string; phase: string }) => {
      source.reads += 1;
      return rows.filter((row) => row.runId === runId && row.phase === phase);
    },
  };
  return source;
}

/** A scheduler whose ticks the test drives, so nothing waits on a clock. */
function fakeScheduler(): {
  scheduleEvery: (handler: () => void, intervalMs: number) => number;
  cancelSchedule: (handle: number) => void;
  tick: () => Promise<void>;
  cancelled: number;
} {
  const handlers: Array<() => void> = [];
  const state = { cancelled: 0 };
  return {
    scheduleEvery: (handler) => {
      handlers.push(handler);
      return handlers.length;
    },
    cancelSchedule: () => {
      state.cancelled += 1;
    },
    get cancelled() {
      return state.cancelled;
    },
    tick: async () => {
      for (const handler of handlers) handler();
      // Two turns of the microtask queue: one for the read, one for whatever
      // the read settles.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

interface Harness {
  deps: PaneRuntimeDeps;
  tmux: ReturnType<typeof fakeTmux>;
  worktrees: ReturnType<typeof fakeWorktrees>;
  lifecycle: ReturnType<typeof fakeLifecycle>;
  scheduler: ReturnType<typeof fakeScheduler>;
  hooks: Array<{ phase: string; runId: string | null; workingDirectory: string }>;
  closedHooks: number;
  warnings: string[];
  clock: { now: Date };
}

function harness(
  storage: PlanRepositoryContext,
  overrides: {
    tmuxAvailable?: boolean;
    services?: readonly ServiceSpec[];
    worktrees?: ReturnType<typeof fakeWorktrees>;
  } = {},
): Harness {
  const tmux = fakeTmux();
  if (overrides.tmuxAvailable === false) tmux.isAvailable = async () => false;
  const worktrees = overrides.worktrees ?? fakeWorktrees();
  const createWorktree = worktrees.create.bind(worktrees);
  worktrees.create = async (options) => {
    const created = await createWorktree(options);
    const timestamp = new Date().toISOString();
    await saveWorktree(storage, {
      worktreeId: created.worktreeId,
      branch: created.branch,
      path: created.path,
      baseBranch: options.baseBranch ?? 'main',
      label: null,
      profile: options.profile ?? 'default',
      agent: options.agent ?? 'claude',
      runtime: options.runtime ?? 'host',
      startupEnvValues: options.startupEnvValues ?? {},
      allocatedPorts: options.allocatedPorts ?? {},
      source: options.source ?? null,
      conversationId: null,
      archived: false,
      activeAgentSessionId: null,
      tabSequenceCounter: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return created;
  };
  const lifecycle = fakeLifecycle();
  const scheduler = fakeScheduler();
  const hooks: Array<{ phase: string; runId: string | null; workingDirectory: string }> = [];
  const warnings: string[] = [];
  const clock = { now: new Date('2026-09-06T10:00:00.000Z') };
  const state = { closedHooks: 0 };

  const session: AgentSessionDeps = {
    projectId: 'proj-a',
    projectRoot: '/repo',
    storage,
    worktrees,
    tmux,
    git: { resolveWorktreeGitDir: async (path: string) => `${path}/.git` },
    branchExists: async () => false,
    panes: PANES,
    profileName: 'default',
    shellPath: '/bin/bash',
  };

  return {
    tmux,
    worktrees,
    lifecycle,
    scheduler,
    hooks,
    warnings,
    clock,
    get closedHooks() {
      return state.closedHooks;
    },
    deps: {
      session,
      provider: 'claude',
      lifecycle,
      scheduler,
      warn: (message) => warnings.push(message),
      now: () => clock.now,
      ...(overrides.services === undefined ? {} : { services: overrides.services }),
      startHooks: async (input) => {
        hooks.push({
          phase: input.phase,
          runId: input.runId,
          workingDirectory: input.workingDirectory,
        });
        return {
          url: 'http://127.0.0.1:1/agent',
          accepted: () => 0,
          close: async () => {
            state.closedHooks += 1;
          },
        };
      },
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('the interactive runtime', () => {
  let home: string;
  let storage: PlanRepositoryContext;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-interactive-'));
    storage = {
      tasksPath: '',
      projectId: 'proj-a',
      issueId: '',
      projectRoot: '/repo',
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
  });

  afterEach(async () => {
    resetPlanRepositories();
    await rm(home, { recursive: true, force: true });
  });

  describe('capabilities', () => {
    it('declares what a pane can actually do', () => {
      const runtime = createInteractiveRuntime(harness(storage).deps);
      expect(runtime.mode).toBe('interactive');
      expect(runtime.capabilities).toEqual({
        interactivePrompt: true,
        interrupt: true,
        livesBeyondInvocation: true,
        isolation: 'worktree',
      });
    });
  });

  describe('prepare', () => {
    it('creates the worktree, opens the project session and reports the binding', async () => {
      const context = harness(storage);
      const runtime = createInteractiveRuntime(context.deps);

      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });

      expect(prepared.mode).toBe('interactive');
      expect(prepared.isolation).toBe('worktree');
      expect(prepared.workdir).toBe('/worktrees/feat/parser');
      expect(context.worktrees.created).toEqual([{ branch: 'feat/parser', runtime: 'host' }]);
      expect(context.tmux.sessions).toEqual([buildProjectSessionName('proj-a')]);
      expect(prepared.session).toMatchObject({
        branch: 'feat/parser',
        runId: 'run-1',
        createdWorktree: true,
        container: null,
        containerLaunched: false,
      });
    });

    it('reuses a worktree that already exists, and says it did not create it', async () => {
      const existing = fakeWorktrees([
        {
          branch: 'feat/parser',
          path: '/worktrees/feat/parser',
          entry: {
            path: '/worktrees/feat/parser',
            branch: 'feat/parser',
            head: null,
            bare: false,
            detached: false,
          },
          binding: { worktreeId: 'wt-1', allocatedPorts: { PORT: 5122 } },
          state: 'managed',
        } as ManagedWorktree,
      ]);
      const context = harness(storage, { worktrees: existing });
      const runtime = createInteractiveRuntime(context.deps);

      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });

      expect(existing.created).toEqual([]);
      expect(prepared.session?.createdWorktree).toBe(false);
      // The ports it already owns, never a fresh allocation: something may be
      // listening on them.
      expect(prepared.session?.allocatedPorts).toEqual({ PORT: 5122 });
    });

    it('allocates the declared services and publishes their state', async () => {
      const services: ServiceSpec[] = [
        { name: 'web', portEnv: 'PORT', portStart: 5120, portStep: 1 },
      ];
      const context = harness(storage, { services });
      const runtime = createInteractiveRuntime({
        ...context.deps,
        probe: { isListening: async () => false },
      });

      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });

      // Slot 1, never slot 0: slot 0 is the repository's own port.
      expect(context.worktrees.created[0]?.allocatedPorts).toEqual({ PORT: 5121 });
      expect(prepared.env.PORT).toBe('5121');
      expect(prepared.services).toEqual([
        { name: 'web', port: 5121, status: 'stopped', detail: null },
      ]);
    });

    it('refuses without tmux, names what is missing, and creates nothing', async () => {
      const context = harness(storage, { tmuxAvailable: false });
      const runtime = createInteractiveRuntime(context.deps);

      await expect(
        runtime.prepare({ projectRoot: '/repo', branch: 'feat/parser', runId: 'run-1' }),
      ).rejects.toThrow(/needs tmux/);
      // Never a silent fallback to headless, and never a half-prepared worktree.
      expect(context.worktrees.created).toEqual([]);
    });

    it('refuses without a branch and without a run id', async () => {
      const context = harness(storage);
      const runtime = createInteractiveRuntime(context.deps);

      await expect(runtime.prepare({ projectRoot: '/repo', runId: 'run-1' })).rejects.toThrow(
        /needs the branch/,
      );
      await expect(
        runtime.prepare({ projectRoot: '/repo', branch: 'feat/parser' }),
      ).rejects.toThrow(/needs the run id/);
    });
  });

  describe('launch', () => {
    it('types the agent argv into the pane and starts the lifecycle hooks', async () => {
      const context = harness(storage);
      const runtime = createInteractiveRuntime(context.deps);
      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });

      const handle = await runtime.launch(prepared, invocation(), SETTINGS);

      expect(handle.provider).toBe('claude');
      expect(context.hooks).toEqual([
        { phase: 'execute', runId: 'run-1', workingDirectory: '/worktrees/feat/parser' },
      ]);

      const agentCommand = context.tmux.commands[0]?.command ?? '';
      // Assembled as argv and serialized once, at the tmux boundary (ADR-04):
      // every element is quoted, including the ones that look harmless.
      expect(agentCommand).toContain("'claude' '--dangerously-skip-permissions'");
      expect(agentCommand).toContain("'--model' 'sonnet'");
      expect(agentCommand).toContain("'--' 'implement the parser'");
      // The host, so no container and no docker anywhere in the command.
      expect(agentCommand).not.toContain('docker');
    });

    it('never lets a review continue the session an execute is running', async () => {
      const context = harness(storage);
      const runtime = createInteractiveRuntime(context.deps);
      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });

      await runtime.launch(prepared, invocation(), SETTINGS);
      // ADR-07 lives in `reuse.ts`; what this asserts is that the adapter feeds
      // it the phase and never works around the answer.
      await expect(
        runtime.launch(prepared, invocation({ phase: 'review' as AgentPhase }), SETTINGS),
      ).rejects.toBeInstanceOf(AgentSessionError);
    });
  });

  describe('result and observe', () => {
    it('resolves from the agent lifecycle events, never from the screen', async () => {
      const context = harness(storage);
      const runtime = createInteractiveRuntime(context.deps);
      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });
      const handle = await runtime.launch(prepared, invocation(), SETTINGS);
      const observed = collect(runtime.observe(handle));

      context.lifecycle.emit({
        runId: 'run-1',
        phase: 'execute',
        type: 'agent_status_changed',
        lifecycle: 'running',
      });
      context.lifecycle.emit({ runId: 'run-1', phase: 'execute', type: 'agent_stopped' });
      await context.scheduler.tick();

      const result = await handle.result();
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.agent).toEqual({ provider: 'claude', model: 'sonnet' });
      // The three fields a pane genuinely does not have. Empty, never invented.
      expect(result.result).toBe('');
      expect(result.rawOutput).toBe('');
      expect(result.usage).toBeNull();
      expect(result.error).toBeNull();

      // The stream is the same source, normalised — and it ends with the
      // invocation.
      expect(await observed).toEqual([
        { kind: 'tool', name: 'agent', detail: 'running' },
        { kind: 'tool', name: 'agent', detail: 'stopped' },
      ]);
      // The hooks are retracted the moment the invocation ends: their files
      // live in the user's working tree.
      await new Promise((resolve) => setImmediate(resolve));
      expect(context.closedHooks).toBe(1);
    });

    it('ignores an event belonging to another run or another phase', async () => {
      const context = harness(storage);
      const runtime = createInteractiveRuntime(context.deps);
      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });
      const handle = await runtime.launch(prepared, invocation(), SETTINGS);

      context.lifecycle.emit({ runId: 'run-2', phase: 'execute', type: 'agent_stopped' });
      context.lifecycle.emit({ runId: 'run-1', phase: 'plan', type: 'agent_stopped' });
      await context.scheduler.tick();

      let settled = false;
      void handle.result().then(() => {
        settled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
    });

    it('reports a runtime error as a failed result carrying its message', async () => {
      const context = harness(storage);
      const runtime = createInteractiveRuntime(context.deps);
      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });
      const handle = await runtime.launch(prepared, invocation(), SETTINGS);

      context.lifecycle.emit({
        runId: 'run-1',
        phase: 'execute',
        type: 'runtime_error',
        message: 'the harness exited',
      });
      await context.scheduler.tick();

      const result = await handle.result();
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.error).toBe('the harness exited');
    });

    it('gives up after the invocation timeout without killing the pane', async () => {
      const context = harness(storage);
      const runtime = createInteractiveRuntime(context.deps);
      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });
      const handle = await runtime.launch(prepared, invocation({ timeout: 60_000 }), SETTINGS);
      const windowsBefore = context.tmux.windows.size;

      context.clock.now = new Date('2026-09-06T10:02:00.000Z');
      await context.scheduler.tick();

      const result = await handle.result();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/did not report finishing 'execute' within 60000 ms/);
      // `livesBeyondInvocation` is true: a slow agent keeps its window and its
      // work. Ending it is an explicit act.
      expect(context.tmux.windows.size).toBe(windowsBefore);
    });
  });

  describe('send and interrupt', () => {
    it('pastes a subsequent turn into the agent pane and interrupts with C-c', async () => {
      const context = harness(storage);
      const runtime = createInteractiveRuntime(context.deps);
      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });
      const handle = await runtime.launch(prepared, invocation(), SETTINGS);

      await runtime.send(handle, 'also handle the empty case');
      await runtime.interrupt(handle);

      const sessions = await listSessions(storage, { branch: 'feat/parser' });
      const paneTarget = sessions[0]?.paneTarget;
      expect(paneTarget).toBeTruthy();
      expect(context.tmux.pastes).toEqual([
        { target: paneTarget, content: 'also handle the empty case' },
      ]);
      expect(context.tmux.keys.at(-1)).toEqual({ target: paneTarget, keys: ['C-c'] });
    });

    it('refuses a handle another runtime produced', async () => {
      const context = harness(storage);
      const runtime = createInteractiveRuntime(context.deps);
      await expect(
        runtime.send(
          {
            id: 'x',
            context: {
              mode: 'headless',
              workdir: '/repo',
              isolation: 'branch',
              env: {},
              services: [],
            },
            provider: 'claude',
            result: async () => {
              throw new Error('unused');
            },
          },
          'hello',
        ),
      ).rejects.toThrow(/not produced by a worktree runtime/);
    });
  });

  describe('dispose', () => {
    it('leaves a worktree it did not create, and says so', async () => {
      const existing = fakeWorktrees([
        {
          branch: 'feat/parser',
          path: '/worktrees/feat/parser',
          entry: {
            path: '/worktrees/feat/parser',
            branch: 'feat/parser',
            head: null,
            bare: false,
            detached: false,
          },
          binding: null,
          state: 'unmanaged',
        } as ManagedWorktree,
      ]);
      const context = harness(storage, { worktrees: existing });
      const runtime = createInteractiveRuntime(context.deps);
      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });

      await runtime.dispose(prepared, { removeWorktree: true });

      expect(existing.removed).toEqual([]);
      expect(context.warnings.join('\n')).toMatch(/found it rather than creating it/);
    });

    it('removes the worktree it created, keeping the branch when asked', async () => {
      const context = harness(storage);
      const runtime = createInteractiveRuntime(context.deps);
      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });

      await runtime.dispose(prepared, { removeWorktree: true, keepBranch: true });

      expect(context.worktrees.removed).toEqual([{ branch: 'feat/parser', keepBranch: true }]);
    });

    it('locks the entire dispose teardown before stopping or removing anything', async () => {
      const context = harness(storage);
      const lockDir = join(home, 'worktree-locks');
      context.deps.session.worktreeLockDir = lockDir;
      const runtime = createInteractiveRuntime(context.deps);
      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });
      await runtime.launch(prepared, invocation(), SETTINGS);
      const acquired = await acquireRunLock(getWorktreeMutationLockPath(lockDir, 'feat/parser'), {
        target: 'worktree:feat/parser',
        pid: process.ppid,
        heartbeat: false,
      });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;

      try {
        await expect(runtime.dispose(prepared, { removeWorktree: true })).rejects.toThrow(
          'is being changed by',
        );
        expect((await listSessions(storage, { branch: 'feat/parser' }))[0]?.status).toBe(
          'starting',
        );
        expect(context.tmux.windows.size).toBe(1);
        expect(context.worktrees.removed).toEqual([]);
      } finally {
        await acquired.handle.release();
      }
    });

    it('stops only the branch it was given, and leaves the other one working', async () => {
      const context = harness(storage);
      const runtime = createInteractiveRuntime(context.deps);
      const first = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/one',
        runId: 'run-1',
      });
      const second = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/two',
        runId: 'run-2',
      });
      await runtime.launch(first, invocation(), SETTINGS);
      await runtime.launch(second, invocation(), SETTINGS);

      await runtime.dispose(first);

      // One runtime instance serves every branch of a project, so a teardown
      // that reached across them would stop work nobody asked it to touch.
      const one = await listSessions(storage, { branch: 'feat/one' });
      const two = await listSessions(storage, { branch: 'feat/two' });
      expect(one.map((session) => session.status)).toEqual(['stopped']);
      expect(two.map((session) => session.status)).toEqual(['starting']);
    });

    it('keeps the worktree when nobody asked for it to go, and stops the session', async () => {
      const context = harness(storage);
      const runtime = createInteractiveRuntime(context.deps);
      const prepared = await runtime.prepare({
        projectRoot: '/repo',
        branch: 'feat/parser',
        runId: 'run-1',
      });
      await runtime.launch(prepared, invocation(), SETTINGS);

      await runtime.dispose(prepared);

      expect(context.worktrees.removed).toEqual([]);
      const sessions = await listSessions(storage, { branch: 'feat/parser' });
      expect(sessions.map((session) => session.status)).toEqual(['stopped']);
      // The window goes with the last live session on the branch.
      expect(context.tmux.windows.size).toBe(0);
    });
  });
});
