import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSessionDeps } from '../agents/session/open.js';
import { createAgentSession, saveSession } from '../agents/session/store.js';
import type { AgentSession } from '../agents/session/types.js';
import { createInitialSnapshot } from '../core/session-state.js';
import type { TmuxGateway } from '../runtime/tmux/gateway.js';
import type { CreatedWorktree, ManagedWorktree } from '../runtime/worktree/lifecycle.js';
import {
  type PlanRepositoryContext,
  resetPlanRepositories,
  saveSessionEvent,
  saveWorktree,
} from '../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import {
  createSessionRoute,
  interruptSessionRoute,
  linkSessionRoute,
  listSessionsRoute,
  matchSessionResource,
  type SessionsApiDeps,
  sendSessionInputRoute,
  stopSessionRoute,
} from './sessions-api.js';

/**
 * The HTTP half of §49.3.
 *
 * Handlers return `{ status, body }`, so every case here runs without a socket
 * — the same property `projects-api.test.ts` relies on.
 */

function fakeTmux(): TmuxGateway & { pasted: string[]; keys: string[][] } {
  const windows = new Set<string>();
  const panes = new Map<string, { sessionName: string; windowName: string }>();
  const paneByCoordinate = new Map<string, string>();
  const owners = new Map<string, { sessionName: string; token: string }>();
  let nextPane = 1;
  const pasted: string[] = [];
  const keys: string[][] = [];
  const pending = new Map<string, string>();
  return {
    pasted,
    keys,
    isAvailable: async () => true,
    ensureServer: async () => {},
    ensureSession: async () => {},
    hasWindow: async (session, window) => windows.has(`${session}:${window}`),
    hasWindowStrict: async (session, window) => windows.has(`${session}:${window}`),
    killWindow: async (session, window) => {
      windows.delete(`${session}:${window}`);
      for (const [pane, location] of panes) {
        if (location.sessionName === session && location.windowName === window) panes.delete(pane);
      }
    },
    killWindowStrict: async (session, window) => {
      windows.delete(`${session}:${window}`);
      for (const [pane, location] of panes) {
        if (location.sessionName === session && location.windowName === window) panes.delete(pane);
      }
    },
    createWindow: async ({ sessionName, windowName }) => {
      windows.add(`${sessionName}:${windowName}`);
      const pane = `%${nextPane++}`;
      panes.set(pane, { sessionName, windowName });
      paneByCoordinate.set(`${sessionName}:${windowName}.0`, pane);
    },
    splitWindow: async () => {},
    setWindowOption: async () => {},
    runCommand: async () => {},
    sendLiteral: async () => {},
    sendKeys: async (_target, sent) => {
      keys.push(sent);
    },
    sendHexKeys: async () => {},
    loadBuffer: async (name, content) => {
      pending.set(name, content);
    },
    pasteBuffer: async ({ bufferName }) => {
      pasted.push(pending.get(bufferName) ?? '');
      pending.delete(bufferName);
    },
    hasBuffer: async () => false,
    selectPane: async () => {},
    listWindows: async () => [],
    getPaneId: async (target) => paneByCoordinate.get(target) ?? target,
    getPaneIdentity: async (target) => {
      const location = panes.get(target);
      if (location === undefined) throw new Error(`missing pane ${target}`);
      const owner = owners.get(target);
      return {
        paneId: target,
        sessionName: owner?.sessionName ?? location.sessionName,
        windowName: location.windowName,
        ownerToken: owner?.token ?? null,
      };
    },
    tagPaneOwner: async (target, token, sessionName) => {
      owners.set(target, { sessionName, token });
    },
    hasPaneStrict: async (target) => panes.has(target),
    countPanes: async (session, window) =>
      [...panes.values()].filter(
        (location) => location.sessionName === session && location.windowName === window,
      ).length,
    killPane: async (target) => {
      panes.delete(target);
      owners.delete(target);
    },
    killPaneStrict: async (target) => {
      panes.delete(target);
      owners.delete(target);
    },
    swapPanes: async () => {},
    movePaneToWindow: async () => {},
  };
}

function fakeWorktrees(
  storage: PlanRepositoryContext,
  root = '/worktrees',
): AgentSessionDeps['worktrees'] {
  const live = new Map<string, ManagedWorktree>();
  return {
    create: async (options): Promise<CreatedWorktree> => {
      const { branch } = options;
      const path = join(root, branch);
      const timestamp = new Date().toISOString();
      const binding = {
        worktreeId: `wt-${branch}`,
        branch,
        path,
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
      } as const;
      await saveWorktree(storage, binding);
      live.set(branch, {
        branch,
        path,
        entry: { path, branch, head: null, bare: false, detached: false },
        binding,
        state: 'managed',
      } as ManagedWorktree);
      return {
        branch,
        worktreeId: `wt-${branch}`,
        path,
        meta: { branch } as CreatedWorktree['meta'],
        runtimeEnvPath: `${path}/.git/issue-flow/runtime.env`,
      };
    },
    list: async () => [...live.values()],
    remove: async (branch) => {
      live.delete(branch);
    },
  };
}

describe('agent-session routes', () => {
  let home: string;
  let storage: PlanRepositoryContext;
  let tmux: ReturnType<typeof fakeTmux>;
  let deps: SessionsApiDeps;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-sessions-api-'));
    storage = {
      tasksPath: '',
      projectId: 'proj',
      issueId: '',
      projectRoot: home,
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
    tmux = fakeTmux();
    const sessionDeps: AgentSessionDeps = {
      projectId: 'proj',
      projectRoot: home,
      storage,
      worktrees: fakeWorktrees(storage, home),
      tmux,
      git: { resolveWorktreeGitDir: async (path: string) => `${path}/.git` },
      branchExists: async () => false,
      panes: [{ id: 'agent', kind: 'agent', focus: true }],
      profileName: 'default',
      shellPath: '/bin/bash',
    };
    deps = {
      writable: true,
      resolveProject: async () => ({ projectId: 'proj', deps: sessionDeps, services: [] }),
    };
  });

  afterEach(async () => {
    resetPlanRepositories();
    await rm(home, { recursive: true, force: true });
  });

  describe('the path grammar', () => {
    it('matches both spellings, with and without an action', () => {
      expect(matchSessionResource('/api/sessions/abc')).toEqual({
        sessionId: 'abc',
        action: null,
      });
      expect(matchSessionResource('/api/agent-sessions/abc/input')).toEqual({
        sessionId: 'abc',
        action: 'input',
      });
      expect(matchSessionResource('/api/sessions')).toBeNull();
      expect(matchSessionResource('/api/projects/abc')).toBeNull();
    });
  });

  describe('GET /api/agent-sessions', () => {
    it('answers an empty list on a monitor with no session surface at all', async () => {
      expect(await listSessionsRoute(null, null)).toEqual({ status: 200, body: [] });
    });

    it('marks each row with the mode it is, and can filter to the free ones', async () => {
      await saveSession(storage, createAgentSession({ branch: 'session/a', provider: 'claude' }));
      await saveSession(
        storage,
        createAgentSession({
          branch: 'feat/1-x',
          provider: 'codex',
          runId: 'run-1',
          phase: 'execute',
        }),
      );

      const all = await listSessionsRoute(deps, 'proj');
      expect(all.status).toBe(200);
      expect(all.body as unknown[]).toHaveLength(2);

      const free = await listSessionsRoute(deps, 'proj', { freeOnly: true });
      const rows = free.body as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.free).toBe(true);
      expect(rows[0]?.runId).toBeNull();
    });
  });

  describe('POST /api/sessions', () => {
    it('opens a free session and says how to reach its terminal', async () => {
      const response = await createSessionRoute(deps, 'proj', {
        agent: 'codex',
        label: 'scratch',
      });
      expect(response.status).toBe(201);
      const body = response.body as {
        session: AgentSession & { free: boolean };
        branch: string;
        terminal: { path: string; branch: string };
      };
      expect(body.session.free).toBe(true);
      expect(body.session.runId).toBeNull();
      expect(body.terminal).toEqual({ path: '/ws/terminal', branch: body.branch });
    });

    it('resolves a persisted custom agent instead of rejecting its open id', async () => {
      await writeFile(
        join(home, '.issue-flow.json'),
        JSON.stringify({ agents: { gemini: { label: 'Gemini', startCommand: 'gemini' } } }),
      );
      const response = await createSessionRoute(deps, 'proj', {
        agent: 'gemini',
        permission: 'read-only',
      });
      expect(response.status).toBe(201);
      expect((response.body as { session: AgentSession }).session.provider).toBe('gemini');
    });

    it('refuses on a binding that is not loopback (ADR-10)', async () => {
      const response = await createSessionRoute({ ...deps, writable: false }, 'proj', {});
      expect(response.status).toBe(403);
    });

    it('refuses an issueRef with no run rather than quietly opening a free session', async () => {
      const response = await createSessionRoute(deps, 'proj', { issueRef: '42' });
      expect(response.status).toBe(409);
      expect(String((response.body as { error: string }).error)).toContain('no run');
    });

    it('binds to the issue run when there is one, which is mode 1 on the same route', async () => {
      await saveSessionEvent(
        { ...storage, issueId: '42' },
        {
          sessionId: 'run-42',
          sequence: 1,
          event: {
            type: 'session:start',
            at: '2026-09-06T10:00:00.000Z',
            sessionId: 'run-42',
            issueNumber: 42,
            phases: ['execute'],
          },
          snapshot: { ...createInitialSnapshot(), sessionId: 'run-42', status: 'running' },
        },
      );

      const response = await createSessionRoute(deps, 'proj', { issueRef: '42' });
      expect(response.status).toBe(201);
      const body = response.body as { session: AgentSession & { free: boolean } };
      expect(body.session.runId).toBe('run-42');
      expect(body.session.free).toBe(false);
    });

    it('refuses an agent and a permission it does not have', async () => {
      expect((await createSessionRoute(deps, 'proj', { agent: 'gpt' })).status).toBe(400);
      expect((await createSessionRoute(deps, 'proj', { permission: 'yolo' })).status).toBe(400);
    });
  });

  describe('input and interrupt', () => {
    it('pastes a subsequent turn as one block', async () => {
      const created = await createSessionRoute(deps, 'proj', {});
      const { session } = created.body as { session: AgentSession };

      const response = await sendSessionInputRoute(deps, 'proj', session.id, {
        text: 'keep going',
      });
      expect(response.status).toBe(202);
      expect(tmux.pasted).toEqual(['keep going']);
    });

    it('refuses an empty body instead of sending a bare Enter', async () => {
      const created = await createSessionRoute(deps, 'proj', {});
      const { session } = created.body as { session: AgentSession };
      expect((await sendSessionInputRoute(deps, 'proj', session.id, {})).status).toBe(400);
    });

    it('interrupts with Ctrl-C and nothing else', async () => {
      const created = await createSessionRoute(deps, 'proj', {});
      const { session } = created.body as { session: AgentSession };
      expect((await interruptSessionRoute(deps, 'proj', session.id)).status).toBe(202);
      expect(tmux.keys).toEqual([['C-c']]);
    });

    it('404s on a session this project does not have', async () => {
      expect((await interruptSessionRoute(deps, 'proj', 'nope')).status).toBe(404);
    });
  });

  describe('DELETE /api/sessions/:id', () => {
    it('stops the session and reports the stopped row', async () => {
      const created = await createSessionRoute(deps, 'proj', {});
      const { session } = created.body as { session: AgentSession };

      const response = await stopSessionRoute(deps, 'proj', session.id);
      expect(response.status).toBe(200);
      expect((response.body as AgentSession).status).toBe('stopped');
      expect((response.body as AgentSession).endedAt).not.toBeNull();
    });
  });

  describe('POST /api/sessions/:id/link', () => {
    it('promotes a free session to an existing run', async () => {
      await saveSessionEvent(
        { ...storage, issueId: '42' },
        {
          sessionId: 'run-42',
          sequence: 1,
          event: {
            type: 'session:start',
            at: '2026-09-06T10:00:00.000Z',
            sessionId: 'run-42',
            issueNumber: 42,
            phases: ['execute'],
          },
          snapshot: { ...createInitialSnapshot(), sessionId: 'run-42', status: 'running' },
        },
      );
      const created = await createSessionRoute(deps, 'proj', {});
      const { session } = created.body as { session: AgentSession };

      const response = await linkSessionRoute(deps, 'proj', session.id, { issueRef: '42' });
      expect(response.status).toBe(200);
      const linked = response.body as AgentSession & { free: boolean };
      expect(linked.runId).toBe('run-42');
      expect(linked.free).toBe(false);
      expect(linked.id).toBe(session.id);
    });

    it('never invents the run it is asked to link to', async () => {
      const created = await createSessionRoute(deps, 'proj', {});
      const { session } = created.body as { session: AgentSession };
      const response = await linkSessionRoute(deps, 'proj', session.id, { issueRef: '99' });
      expect(response.status).toBe(409);
    });

    it('refuses to relink a session that already belongs to a run', async () => {
      const existing = createAgentSession({
        branch: 'feat/1-x',
        provider: 'claude',
        runId: 'run-1',
        phase: 'execute',
      });
      await saveSession(storage, existing);
      const response = await linkSessionRoute(deps, 'proj', existing.id, { runId: 'run-2' });
      expect(response.status).toBe(409);
    });
  });
});
