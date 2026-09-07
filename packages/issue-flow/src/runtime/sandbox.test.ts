import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSessionDeps } from '../agents/session/open.js';
import type { AgentInvocation, ResolvedAgentSettings } from '../agents/types.js';
import {
  type PlanRepositoryContext,
  resetPlanRepositories,
  saveWorktree,
} from '../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { type PaneTemplate, parseRuntimeProfile, type RuntimeProfile } from './profiles.js';
import {
  buildDockerRunArgs,
  type DockerGateway,
  type LaunchContainerOpts,
} from './sandbox/docker.js';
import { createSandboxRuntime, requireDockerProfile, type SandboxRuntimeDeps } from './sandbox.js';
import type { TmuxGateway } from './tmux/gateway.js';
import type { TmuxWindowSummary } from './tmux/names.js';
import type { CreatedWorktree, ManagedWorktree } from './worktree/lifecycle.js';

/**
 * The `sandbox` runtime: the interactive one, inside a container.
 *
 * What is asserted here is only the difference — the container's lifecycle and
 * the two pane commands it changes. Everything else is `interactive.test.ts`,
 * because everything else is the same code (§25): a second copy of those cases
 * would assert the same lines twice and drift the moment one of them changed.
 *
 * The container never runs here. `buildDockerRunArgs` is a pure function with
 * its own suite (`sandbox/docker.test.ts`, C7), and a machine with no daemon
 * must still be able to prove that this adapter passes the profile through and
 * removes only what it started.
 */

const PANES: readonly PaneTemplate[] = [
  { id: 'agent', kind: 'agent', focus: true },
  { id: 'shell', kind: 'shell', split: 'right', sizePct: 25 },
];

const SETTINGS: ResolvedAgentSettings = {
  provider: 'codex',
  model: null,
  claude: {},
  codex: {},
  cursor: {},
  antigravity: {},
  opencode: {},
  origin: { provider: 'default', model: 'default' },
};

const INVOCATION: AgentInvocation = {
  prompt: 'run the suite',
  phase: 'execute',
  timeout: 0,
  permission: 'autonomous',
};

function fakeTmux(): TmuxGateway & {
  windowCommands: string[];
  paneCommands: string[];
  available: { value: boolean };
} {
  const windows = new Map<string, number>();
  const windowCommands: string[] = [];
  const paneCommands: string[] = [];
  const available = { value: true };
  let current: string | null = null;
  const paneLocations = new Map<string, { sessionName: string; windowName: string }>();
  const paneByCoordinate = new Map<string, string>();
  const paneOwners = new Map<string, { sessionName: string; token: string }>();
  let nextPane = 1;
  const key = (session: string, window: string): string => `${session}:${window}`;

  return {
    windowCommands,
    paneCommands,
    available,
    isAvailable: async () => available.value,
    ensureServer: async () => {},
    ensureSession: async () => {},
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
    createWindow: async ({ sessionName, windowName, command }) => {
      windows.set(key(sessionName, windowName), 1);
      current = key(sessionName, windowName);
      const pane = `%${nextPane++}`;
      paneLocations.set(pane, { sessionName, windowName });
      paneByCoordinate.set(`${sessionName}:${windowName}.0`, pane);
      if (command !== undefined) windowCommands.push(command);
    },
    splitWindow: async ({ command }) => {
      if (current !== null) {
        const index = windows.get(current) ?? 0;
        windows.set(current, index + 1);
        const colon = current.indexOf(':');
        const sessionName = current.slice(0, colon);
        const windowName = current.slice(colon + 1);
        const pane = `%${nextPane++}`;
        paneLocations.set(pane, { sessionName, windowName });
        paneByCoordinate.set(`${current}.${index}`, pane);
      }
      if (command !== undefined) windowCommands.push(command);
    },
    setWindowOption: async () => {},
    runCommand: async (_target, command) => {
      paneCommands.push(command);
    },
    sendLiteral: async () => {},
    sendKeys: async () => {},
    sendHexKeys: async () => {},
    loadBuffer: async () => {},
    pasteBuffer: async () => {},
    hasBuffer: async () => false,
    selectPane: async () => {},
    listWindows: async (): Promise<TmuxWindowSummary[]> => [],
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
    swapPanes: async () => {},
    movePaneToWindow: async () => {},
  };
}

function fakeWorktrees(): AgentSessionDeps['worktrees'] & {
  created: Array<{ branch: string; runtime?: string }>;
} {
  const created: Array<{ branch: string; runtime?: string }> = [];
  const live = new Map<string, ManagedWorktree>();
  return {
    created,
    create: async (input): Promise<CreatedWorktree> => {
      created.push({
        branch: input.branch,
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
        meta: { branch: input.branch, allocatedPorts: {} } as CreatedWorktree['meta'],
        runtimeEnvPath: `${path}/.git/issue-flow/runtime.env`,
      };
    },
    list: async () => [...live.values()],
    remove: async (branch) => {
      live.delete(branch);
    },
  };
}

function fakeDocker(
  options: { existing?: string | null; available?: boolean } = {},
): DockerGateway & {
  launches: LaunchContainerOpts[];
  removed: string[];
} {
  const launches: LaunchContainerOpts[] = [];
  const removed: string[] = [];
  let existing = options.existing ?? null;
  return {
    launches,
    removed,
    isAvailable: async () => options.available ?? true,
    findContainer: async () => existing,
    launchContainer: async (opts) => {
      launches.push(opts);
      existing ??= `if-${opts.branch.replace(/\W/g, '-')}-1`;
      return existing;
    },
    removeContainer: async (branch) => {
      removed.push(branch);
      existing = null;
    },
  };
}

const DOCKER_PROFILE = { runtime: 'docker' as const, image: 'issue-flow/sandbox:local' };

function harness(
  storage: PlanRepositoryContext,
  overrides: { docker?: ReturnType<typeof fakeDocker>; tmux?: ReturnType<typeof fakeTmux> } = {},
): {
  deps: SandboxRuntimeDeps;
  tmux: ReturnType<typeof fakeTmux>;
  docker: ReturnType<typeof fakeDocker>;
  worktrees: ReturnType<typeof fakeWorktrees>;
} {
  const tmux = overrides.tmux ?? fakeTmux();
  const docker = overrides.docker ?? fakeDocker();
  const worktrees = fakeWorktrees();
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
      profile: options.profile ?? 'sandbox',
      agent: options.agent ?? 'codex',
      runtime: options.runtime ?? 'docker',
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
  return {
    tmux,
    docker,
    worktrees,
    deps: {
      session: {
        projectId: 'proj-a',
        projectRoot: '/repo',
        storage,
        worktrees,
        tmux,
        git: { resolveWorktreeGitDir: async (path: string) => `${path}/.git` },
        branchExists: async () => false,
        panes: PANES,
        profileName: 'sandbox',
      },
      provider: 'codex',
      profile: DOCKER_PROFILE,
      docker,
      lifecycle: { list: async () => [] },
      scheduler: { scheduleEvery: () => 1, cancelSchedule: () => {} },
      startHooks: async () => null,
    },
  };
}

describe('the sandbox runtime', () => {
  let home: string;
  let storage: PlanRepositoryContext;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-sandbox-runtime-'));
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

  it('declares the same capabilities as the interactive mode, under its own name', () => {
    const runtime = createSandboxRuntime(harness(storage).deps);
    expect(runtime.mode).toBe('sandbox');
    expect(runtime.capabilities).toEqual({
      interactivePrompt: true,
      interrupt: true,
      livesBeyondInvocation: true,
      isolation: 'worktree',
    });
  });

  it('launches the container for the branch and binds the worktree to docker', async () => {
    const context = harness(storage);
    const runtime = createSandboxRuntime(context.deps);

    const prepared = await runtime.prepare({
      projectRoot: '/repo',
      branch: 'feat/parser',
      runId: 'run-1',
    });

    expect(context.docker.launches).toHaveLength(1);
    expect(context.docker.launches[0]).toMatchObject({
      branch: 'feat/parser',
      wtDir: '/worktrees/feat/parser',
      mainRepoDir: '/repo',
      sandboxConfig: DOCKER_PROFILE,
    });
    expect(context.worktrees.created).toEqual([{ branch: 'feat/parser', runtime: 'docker' }]);
    expect(prepared.session).toMatchObject({
      container: 'if-feat-parser-1',
      containerLaunched: true,
    });
  });

  it('joins a container that is already running and never removes it', async () => {
    const docker = fakeDocker({ existing: 'if-feat-parser-earlier' });
    const context = harness(storage, { docker });
    const runtime = createSandboxRuntime(context.deps);

    const prepared = await runtime.prepare({
      projectRoot: '/repo',
      branch: 'feat/parser',
      runId: 'run-1',
    });
    expect(prepared.session?.containerLaunched).toBe(false);

    await runtime.dispose(prepared);
    expect(docker.removed).toEqual([]);
  });

  it('removes the container it started', async () => {
    const context = harness(storage);
    const runtime = createSandboxRuntime(context.deps);
    const prepared = await runtime.prepare({
      projectRoot: '/repo',
      branch: 'feat/parser',
      runId: 'run-1',
    });

    await runtime.dispose(prepared);
    expect(context.docker.removed).toEqual(['feat/parser']);
  });

  it('opens every pane inside the container, and types an agent command that does not', async () => {
    const context = harness(storage);
    const runtime = createSandboxRuntime(context.deps);
    const prepared = await runtime.prepare({
      projectRoot: '/repo',
      branch: 'feat/parser',
      runId: 'run-1',
    });

    await runtime.launch(prepared, INVOCATION, SETTINGS);

    // The pane's *shell* is what enters the container.
    const shell = context.tmux.windowCommands[0] ?? '';
    expect(shell).toContain(
      "docker exec -it -w '/worktrees/feat/parser' 'if-feat-parser-1' /bin/sh -c",
    );
    expect(shell).toContain('/bin/bash');
    expect(shell).toContain('elif [ -x /bin/sh ]; then exec /bin/sh -i;');

    // The agent command is typed into a shell that is already inside, so it
    // must not wrap itself in a second `docker exec` — the upstream asserts the
    // same thing.
    const agent = context.tmux.paneCommands[0] ?? '';
    expect(agent).not.toContain('docker exec');
    expect(agent).toContain('export PATH="$PATH:/root/.local/bin:/usr/local/bin"');
    expect(agent).toContain("'codex' '--enable' 'hooks' '--yolo'");
    expect(agent).toContain("'--' 'run the suite'");
  });

  it('refuses without a Docker daemon, names what is missing, and creates nothing', async () => {
    const context = harness(storage, { docker: fakeDocker({ available: false }) });
    const runtime = createSandboxRuntime(context.deps);

    await expect(
      runtime.prepare({ projectRoot: '/repo', branch: 'feat/parser', runId: 'run-1' }),
    ).rejects.toThrow(/needs a running Docker daemon/);
    expect(context.worktrees.created).toEqual([]);
  });

  it('reports the missing tmux before the missing daemon', async () => {
    const tmux = fakeTmux();
    tmux.available.value = false;
    const context = harness(storage, { tmux, docker: fakeDocker({ available: false }) });
    const runtime = createSandboxRuntime(context.deps);

    await expect(
      runtime.prepare({ projectRoot: '/repo', branch: 'feat/parser', runId: 'run-1' }),
    ).rejects.toThrow(/needs tmux/);
  });

  /**
   * The upper half of the seam `profiles.security.test.ts` proves the lower
   * half of.
   *
   * That file goes from the raw configuration value to the argument list; this
   * one goes from the raw value through the *runtime* — the profile the adapter
   * narrows, the container it asks for — and then to the same argument list.
   * The two halves together are what keeps `security` from being dropped
   * silently again: every default is the safe one, so a lost `sshAgent` or
   * `network` looks exactly like a healthy launch.
   */
  it('carries a profile security block from configuration into the docker run args', async () => {
    const declared = parseRuntimeProfile(
      {
        runtime: 'docker',
        image: 'issue-flow/sandbox:local',
        security: { sshAgent: true, network: 'none', capAdd: ['NET_ADMIN'] },
      },
      'host',
    );
    const context = harness(storage);
    const runtime = createSandboxRuntime({
      ...context.deps,
      profile: requireDockerProfile(declared, 'sandbox'),
    });

    await runtime.prepare({ projectRoot: '/repo', branch: 'feat/parser', runId: 'run-1' });

    // It survived the narrowing and reached the container request untouched.
    const launched = context.docker.launches[0];
    expect(launched?.sandboxConfig.security).toEqual({
      sshAgent: true,
      network: 'none',
      capAdd: ['NET_ADMIN'],
    });

    // And it is what docker is actually given. `buildDockerRunArgs` is pure, so
    // this needs no daemon.
    const args = buildDockerRunArgs(launched as LaunchContainerOpts, {
      existingPaths: new Set(['/run/ssh-agent.sock']),
      home: '/home/u',
      name: 'if-feat-parser-1',
      sshAuthSock: '/run/ssh-agent.sock',
      hostUid: 501,
      hostGid: 20,
      hostEnv: {},
      hostTotalMemoryBytes: 8 * 1024 ** 3,
    });

    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).toContain('--cap-add');
    expect(args[args.indexOf('--cap-add') + 1]).toBe('NET_ADMIN');
    expect(args).toContain('--mount');
    expect(args).toContain('type=bind,source=/run/ssh-agent.sock,target=/run/ssh-agent.sock');
    expect(args).toContain('SSH_AUTH_SOCK=/run/ssh-agent.sock');
  });

  it('refuses a profile with no image instead of falling back to the host', () => {
    const profile: RuntimeProfile = { runtime: 'docker', envPassthrough: [], panes: [...PANES] };
    expect(() => requireDockerProfile(profile, 'sandbox')).toThrow(/declares no image/);
  });

  it('passes the profile through to the container untouched', () => {
    const profile: RuntimeProfile = {
      runtime: 'docker',
      image: 'issue-flow/sandbox:local',
      envPassthrough: ['GITHUB_TOKEN'],
      mounts: [{ hostPath: '/cache', guestPath: '/cache', writable: true }],
      security: { network: 'none', implicitMounts: false },
      panes: [...PANES],
    };
    expect(requireDockerProfile(profile, 'sandbox')).toEqual({
      runtime: 'docker',
      image: 'issue-flow/sandbox:local',
      envPassthrough: ['GITHUB_TOKEN'],
      mounts: [{ hostPath: '/cache', guestPath: '/cache', writable: true }],
      security: { network: 'none', implicitMounts: false },
    });
  });
});
