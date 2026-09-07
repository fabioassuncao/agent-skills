import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TmuxGateway } from '../../runtime/tmux/gateway.js';
import { buildProjectSessionName, buildWorktreeWindowName } from '../../runtime/tmux/names.js';
import type { PlanRepositoryContext } from '../../storage/db/repository.js';
import { loadWorktree, type StoredWorktree, saveWorktree } from '../../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../../storage/paths.js';
import type { ResolvedAgentSessionContext } from './context.js';
import { stopAgentSession } from './open.js';
import { createAgentSession, listSessions, saveSession } from './store.js';
import {
  createAgentTab,
  deleteAgentTab,
  projectAgentSessionTabs,
  reconcileAgentTabPanes,
  refreshActiveAgentTab,
  selectAgentTab,
} from './tabs.js';
import { stopLiveSessions } from './worktree-control.js';

function fakeTmux(projectId: string, branch: string) {
  const sessionName = buildProjectSessionName(projectId);
  const mainWindow = buildWorktreeWindowName(branch);
  const panes = new Map<string, string>([['%1', mainWindow]]);
  const paneSessions = new Map<string, string>([['%1', sessionName]]);
  const owners = new Map<string, string>();
  const ownerSessions = new Map<string, string>();
  let next = 2;
  const killed: string[] = [];
  const commands: Array<{ target: string; command: string }> = [];
  const gateway: TmuxGateway = {
    isAvailable: async () => true,
    ensureServer: async () => {},
    ensureSession: async () => {},
    hasWindow: async (_session, window) => [...panes.values()].includes(window),
    hasWindowStrict: async (_session, window) => [...panes.values()].includes(window),
    killWindow: async (_session, window) => {
      for (const [pane, owner] of panes) {
        if (owner !== window) continue;
        panes.delete(pane);
        paneSessions.delete(pane);
        owners.delete(pane);
        ownerSessions.delete(pane);
      }
    },
    killWindowStrict: async (_session, window) => {
      for (const [pane, owner] of panes) {
        if (owner !== window) continue;
        panes.delete(pane);
        paneSessions.delete(pane);
        owners.delete(pane);
        ownerSessions.delete(pane);
      }
    },
    createWindow: async () => {},
    splitWindow: async () => {},
    setWindowOption: async () => {},
    runCommand: async (target, command) => void commands.push({ target, command }),
    sendLiteral: async () => {},
    sendKeys: async () => {},
    sendHexKeys: async () => {},
    loadBuffer: async () => {},
    pasteBuffer: async () => {},
    hasBuffer: async () => false,
    selectPane: async () => {},
    listWindows: async () =>
      [...new Set(panes.values())].map((windowName) => ({
        sessionName,
        windowName,
        paneCount: [...panes.values()].filter((owner) => owner === windowName).length,
      })),
    getPaneId: async (target) => target,
    getPaneWindow: async (target) => {
      const owner = panes.get(target);
      if (!owner) throw new Error(`missing ${target}`);
      return owner;
    },
    getPaneIdentity: async (target) => {
      const windowName = panes.get(target);
      if (!windowName) throw new Error(`missing ${target}`);
      return {
        paneId: target,
        sessionName: ownerSessions.get(target) ?? paneSessions.get(target) ?? sessionName,
        windowName,
        ownerToken: owners.get(target) ?? null,
      };
    },
    tagPaneOwner: async (target, token, ownerSessionName) => {
      owners.set(target, token);
      ownerSessions.set(target, ownerSessionName);
    },
    hasPaneStrict: async (target) => panes.has(target),
    createParkedPane: async ({ parkingWindow }) => {
      const pane = `%${next++}`;
      panes.set(pane, parkingWindow);
      paneSessions.set(pane, sessionName);
      return pane;
    },
    swapPanes: async (source, destination) => {
      const left = panes.get(source);
      const right = panes.get(destination);
      if (!left || !right) throw new Error('missing swap pane');
      panes.set(source, right);
      panes.set(destination, left);
    },
    movePaneToWindow: async (source, destination) => {
      panes.set(source, destination.split(':').at(-1) as string);
    },
    countPanes: async () => 1,
    killPane: async (target) => {
      panes.delete(target);
      paneSessions.delete(target);
      owners.delete(target);
      ownerSessions.delete(target);
    },
    killPaneStrict: async (target) => {
      killed.push(target);
      panes.delete(target);
      paneSessions.delete(target);
      owners.delete(target);
      ownerSessions.delete(target);
    },
    listPaneIds: async () => [...panes.keys()],
    listPaneLocations: async () =>
      [...panes].map(([paneId, windowName]) => ({
        paneId,
        sessionName: ownerSessions.get(paneId) ?? paneSessions.get(paneId) ?? sessionName,
        windowName,
        ownerToken: owners.get(paneId) ?? null,
      })),
  };
  return {
    gateway,
    panes,
    paneSessions,
    owners,
    ownerSessions,
    killed,
    commands,
    mainWindow,
  };
}

describe('AgentSession tabs', () => {
  let home: string;
  let storage: PlanRepositoryContext;
  let context: ResolvedAgentSessionContext;
  let binding: StoredWorktree;
  let rootId: string;
  let tmux: ReturnType<typeof fakeTmux>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-tabs-'));
    storage = {
      tasksPath: '',
      projectId: 'project-tabs',
      issueId: '',
      projectRoot: '/repo',
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
    binding = {
      worktreeId: 'wt-current',
      branch: 'feature/tabs',
      path: '/worktrees/tabs',
      baseBranch: 'main',
      label: null,
      profile: 'default',
      agent: 'claude',
      runtime: 'host',
      startupEnvValues: {},
      allocatedPorts: {},
      source: null,
      conversationId: null,
      archived: false,
      activeAgentSessionId: null,
      tabSequenceCounter: 0,
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
    };
    await saveWorktree(storage, binding);
    const root = createAgentSession({
      branch: binding.branch,
      worktreeId: binding.worktreeId,
      provider: 'claude',
      permission: 'read-only',
      conversationId: 'root-conversation',
      paneTarget: '%1',
      tabSequence: 0,
      status: 'running',
    });
    rootId = root.id;
    await saveSession(storage, root);
    binding = { ...binding, activeAgentSessionId: root.id };
    await saveWorktree(storage, binding);
    tmux = fakeTmux(storage.projectId, binding.branch);
    tmux.owners.set('%1', root.paneToken as string);
    tmux.ownerSessions.set('%1', buildProjectSessionName(storage.projectId));
    context = {
      projectId: storage.projectId,
      projectRoot: '/repo',
      storage,
      profileName: 'default',
      mainBranch: 'main',
      worktrees: {
        create: async () => {
          throw new Error('not used');
        },
        list: async () => [
          {
            branch: binding.branch,
            path: binding.path,
            entry: {
              path: binding.path,
              branch: binding.branch,
              head: null,
              bare: false,
              detached: false,
            },
            binding: await loadWorktree(storage, binding.branch),
            state: 'managed',
          },
        ],
        remove: async () => {},
      },
      git: { resolveWorktreeGitDir: async () => '/worktrees/tabs/.git' },
      profileNames: ['default'],
      profileConfigs: [{ name: 'default' }],
      startupEnv: {},
      services: [],
      deps: {
        projectId: storage.projectId,
        projectRoot: '/repo',
        storage,
        worktrees: null as never,
        tmux: tmux.gateway,
        git: { resolveWorktreeGitDir: async () => '/worktrees/tabs/.git' },
        branchExists: async () => true,
        panes: [{ id: 'agent', kind: 'agent', focus: true }],
        profileName: 'default',
        worktreeLockDir: join(home, 'locks'),
        shellPath: '/bin/bash',
      },
    } as ResolvedAgentSessionContext;
    context.deps.worktrees = context.worktrees;
  });

  afterEach(async () => rm(home, { recursive: true, force: true }));

  it('serializes concurrent creates, preserves AgentSession ids on the wire and never recycles sequence', async () => {
    const [one, two] = await Promise.all([
      createAgentTab(context, binding.branch),
      createAgentTab(context, binding.branch),
    ]);
    expect([one.label, two.label].sort()).toEqual(['Fork 1', 'Fork 2']);
    const stored = await listSessions(storage, { branch: binding.branch });
    const latestBinding = await loadWorktree(storage, binding.branch);
    const projected = projectAgentSessionTabs(stored, latestBinding);
    expect(projected.tabs[0]?.tabId).toBe(rootId);
    expect(new Set(projected.tabs.map((tab) => tab.tabId))).toEqual(
      new Set(
        stored.filter((session) => session.tabSequence !== null).map((session) => session.id),
      ),
    );
    expect(latestBinding?.tabSequenceCounter).toBe(2);

    await deleteAgentTab(context, binding.branch, one.tabId);
    const three = await createAgentTab(context, binding.branch);
    expect(three.label).toBe('Fork 3');
  });

  it('refuses root deletion and review forks', async () => {
    await expect(deleteAgentTab(context, binding.branch, rootId)).rejects.toMatchObject({
      status: 400,
    });
    const root = (await listSessions(storage, { branch: binding.branch })).find(
      (s) => s.id === rootId,
    )!;
    await saveSession(storage, { ...root, phase: 'review' });
    await expect(createAgentTab(context, binding.branch)).rejects.toMatchObject({ status: 409 });
  });

  it('persists stopped fork evidence when parking creation fails and never recycles its sequence', async () => {
    const createParkedPane = tmux.gateway.createParkedPane;
    tmux.gateway.createParkedPane = async () => {
      throw new Error('parking unavailable');
    };
    await expect(createAgentTab(context, binding.branch)).rejects.toThrow('parking unavailable');

    const afterFailure = await listSessions(storage, { branch: binding.branch });
    expect(afterFailure).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentSessionId: rootId,
          tabSequence: 1,
          paneTarget: null,
          status: 'stopped',
        }),
      ]),
    );
    expect(await loadWorktree(storage, binding.branch)).toEqual(
      expect.objectContaining({ activeAgentSessionId: rootId, tabSequenceCounter: 1 }),
    );

    tmux.gateway.createParkedPane = createParkedPane;
    expect((await createAgentTab(context, binding.branch)).label).toBe('Fork 2');
  });

  it('swaps against the physically visible tab when the active pointer is stale', async () => {
    const first = await createAgentTab(context, binding.branch);
    await saveWorktree(storage, {
      ...(await loadWorktree(storage, binding.branch))!,
      activeAgentSessionId: rootId,
    });

    const second = await createAgentTab(context, binding.branch);
    const sessions = await listSessions(storage, { branch: binding.branch });
    const secondPane = sessions.find((session) => session.id === second.tabId)?.paneTarget;
    expect(secondPane).toBeDefined();
    expect(tmux.panes.get(secondPane as string)).toBe(tmux.mainWindow);
    expect([...tmux.panes.values()].filter((window) => window === tmux.mainWindow)).toHaveLength(1);
    expect(sessions.find((session) => session.id === first.tabId)?.paneTarget).not.toBe(secondPane);
  });

  it('selects an orphaned tab by resuming its exact conversation without killing another process', async () => {
    const fork = await createAgentTab(context, binding.branch);
    await selectAgentTab(context, binding.branch, rootId);
    const child = (await listSessions(storage, { branch: binding.branch })).find(
      (s) => s.id === fork.tabId,
    )!;
    tmux.panes.delete(child.paneTarget as string);
    await saveSession(storage, { ...child, status: 'orphaned' });
    const killedBefore = [...tmux.killed];
    await selectAgentTab(context, binding.branch, fork.tabId);
    expect(tmux.commands.at(-1)?.command).toContain(`'--resume' '${child.conversationId}'`);
    expect(tmux.killed).toEqual(killedBefore);
    expect((await loadWorktree(storage, binding.branch))?.activeAgentSessionId).toBe(fork.tabId);
  });

  it('refreshes a root with no prior pane by resuming its exact conversation', async () => {
    const root = (await listSessions(storage, { branch: binding.branch })).find(
      (session) => session.id === rootId,
    )!;
    tmux.panes.delete('%1');
    tmux.panes.set('%service', tmux.mainWindow);
    await saveSession(storage, { ...root, paneTarget: null, status: 'orphaned' });

    await expect(refreshActiveAgentTab(context, binding.branch)).resolves.toEqual({
      sessionId: rootId,
      mode: 'resume',
    });
    expect(tmux.commands.at(-1)?.command).toContain(`'--resume' '${root.conversationId}'`);
    expect(tmux.killed).toEqual([]);
  });

  it('does not orphan live rows when an aggregate tmux read is unknown', async () => {
    tmux.gateway.listPaneLocations = async () => {
      throw new Error('transient socket failure');
    };
    const before = await listSessions(storage);
    const after = await reconcileAgentTabPanes(context, before);
    expect(after.find((session) => session.id === rootId)?.status).toBe('running');
    expect((await listSessions(storage)).find((session) => session.id === rootId)?.status).toBe(
      'running',
    );
  });

  it('never kills a reused pane id whose durable owner token changed', async () => {
    const fork = await createAgentTab(context, binding.branch);
    const child = (await listSessions(storage, { branch: binding.branch })).find(
      (candidate) => candidate.id === fork.tabId,
    )!;
    tmux.owners.set(child.paneTarget as string, 'new-tmux-server-owner');

    await expect(deleteAgentTab(context, binding.branch, child.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(tmux.killed).not.toContain(child.paneTarget);
    expect(
      (await listSessions(storage)).find((candidate) => candidate.id === child.id)?.status,
    ).toBe('starting');
  });

  it('dismisses an orphaned fork whose pane is authoritatively absent', async () => {
    const fork = await createAgentTab(context, binding.branch);
    await selectAgentTab(context, binding.branch, rootId);
    const child = (await listSessions(storage)).find((candidate) => candidate.id === fork.tabId)!;
    tmux.panes.delete(child.paneTarget as string);
    tmux.owners.delete(child.paneTarget as string);
    tmux.ownerSessions.delete(child.paneTarget as string);
    await saveSession(storage, { ...child, status: 'orphaned' });
    const killedBefore = [...tmux.killed];

    await deleteAgentTab(context, binding.branch, child.id);

    expect(tmux.killed).toEqual(killedBefore);
    expect(
      (await listSessions(storage)).find((candidate) => candidate.id === child.id)?.status,
    ).toBe('stopped');
  });

  it('preserves a same-id pane in another tmux session and resumes into a new owned pane', async () => {
    const fork = await createAgentTab(context, binding.branch);
    await selectAgentTab(context, binding.branch, rootId);
    const child = (await listSessions(storage, { branch: binding.branch })).find(
      (candidate) => candidate.id === fork.tabId,
    )!;
    const reusedId = child.paneTarget as string;
    tmux.ownerSessions.set(reusedId, 'if-another-project');

    await selectAgentTab(context, binding.branch, child.id);

    const resumed = (await listSessions(storage)).find((candidate) => candidate.id === child.id)!;
    expect(resumed.paneTarget).not.toBe(reusedId);
    expect(tmux.panes.has(reusedId)).toBe(true);
    expect(tmux.killed).not.toContain(reusedId);
    expect(tmux.owners.get(resumed.paneTarget as string)).toBe(resumed.paneToken);
  });

  it('promotes the authenticated root before stopping the active fork', async () => {
    const fork = await createAgentTab(context, binding.branch);
    const child = (await listSessions(storage)).find((candidate) => candidate.id === fork.tabId)!;

    await stopAgentSession(context.deps, child);

    expect((await loadWorktree(storage, binding.branch))?.activeAgentSessionId).toBe(rootId);
    expect(tmux.killed).toContain(child.paneTarget);
    const root = (await listSessions(storage)).find((candidate) => candidate.id === rootId)!;
    expect(tmux.panes.get(root.paneTarget as string)).toBe(tmux.mainWindow);
  });

  it('atomically stops every sibling when removing a tabbed worktree', async () => {
    const fork = await createAgentTab(context, binding.branch);
    const child = (await listSessions(storage)).find((candidate) => candidate.id === fork.tabId)!;

    await stopAgentSession(context.deps, child, { removeWorktree: true });

    const rows = (await listSessions(storage)).filter(
      (candidate) => candidate.worktreeId === binding.worktreeId,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((candidate) => candidate.status === 'stopped')).toBe(true);
    expect(tmux.panes.size).toBe(0);
  });

  it('serializes stop with create and never stops a newly reused foreign pane id', async () => {
    const fork = await createAgentTab(context, binding.branch);
    const child = (await listSessions(storage)).find((candidate) => candidate.id === fork.tabId)!;
    let releaseKill: (() => void) | undefined;
    let blocked = false;
    const killStarted = new Promise<void>((resolve) => {
      const originalKill = tmux.gateway.killPaneStrict;
      tmux.gateway.killPaneStrict = async (target) => {
        if (!blocked) {
          blocked = true;
          resolve();
          await new Promise<void>((release) => {
            releaseKill = release;
          });
        }
        await originalKill?.(target);
      };
    });

    const stopping = stopAgentSession(context.deps, child);
    await killStarted;
    let createSettled = false;
    const creating = createAgentTab(context, binding.branch).finally(() => {
      createSettled = true;
    });
    await Promise.resolve();
    expect(createSettled).toBe(false);
    releaseKill?.();

    await stopping;
    const next = await creating;
    expect(next.label).toBe('Fork 2');
    expect((await loadWorktree(storage, binding.branch))?.activeAgentSessionId).toBe(next.tabId);
  });

  it('holds the branch lock across a close snapshot, every stop and its postcondition', async () => {
    await createAgentTab(context, binding.branch);
    let releaseKill: (() => void) | undefined;
    let blocked = false;
    const killStarted = new Promise<void>((resolve) => {
      const originalKill = tmux.gateway.killPaneStrict;
      tmux.gateway.killPaneStrict = async (target) => {
        if (!blocked) {
          blocked = true;
          resolve();
          await new Promise<void>((release) => {
            releaseKill = release;
          });
        }
        await originalKill?.(target);
      };
    });

    const closing = stopLiveSessions(context, binding.branch);
    await killStarted;
    let createSettled = false;
    const creating = createAgentTab(context, binding.branch).finally(() => {
      createSettled = true;
    });
    await Promise.resolve();
    expect(createSettled).toBe(false);
    releaseKill?.();

    await closing;
    await expect(creating).rejects.toMatchObject({ status: 409 });
    expect(
      (await listSessions(storage)).filter(
        (candidate) =>
          candidate.worktreeId === binding.worktreeId && candidate.status !== 'stopped',
      ),
    ).toEqual([]);
  });
});
