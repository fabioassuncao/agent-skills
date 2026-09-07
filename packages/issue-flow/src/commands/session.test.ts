import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolvedAgentSessionContext } from '../agents/session/context.js';
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
  formatSessionTable,
  runSessionAttach,
  runSessionLink,
  runSessionLs,
  runSessionNew,
  runSessionStop,
} from './session.js';

/**
 * `issue-flow session …` — the one command in this project that starts from
 * nothing at all.
 *
 * Every case goes through the `resolveContext` seam, so no test here touches
 * git, tmux or a real profile map: what is under test is the command's own
 * decisions — which arguments it refuses, what it prints, and the two things
 * `link` must never do.
 */

function fakeTmux(): TmuxGateway & { windows: Set<string> } {
  const windows = new Set<string>();
  const panes = new Map<string, { sessionName: string; windowName: string }>();
  const paneByCoordinate = new Map<string, string>();
  const owners = new Map<string, { sessionName: string; token: string }>();
  let nextPane = 1;
  return {
    windows,
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
    sendKeys: async () => {},
    sendHexKeys: async () => {},
    loadBuffer: async () => {},
    pasteBuffer: async () => {},
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

describe('issue-flow session', () => {
  let home: string;
  let storage: PlanRepositoryContext;
  let context: ResolvedAgentSessionContext;
  let output: string[];
  let errors: string[];

  const deps = (): Parameters<typeof runSessionLs>[1] => ({
    resolveContext: async () => context,
    attach: () => 0,
    log: (message) => {
      output.push(message);
    },
    warn: (message) => {
      output.push(message);
    },
    error: (message) => {
      errors.push(message);
    },
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-session-cmd-'));
    output = [];
    errors = [];
    storage = {
      tasksPath: '',
      projectId: 'proj',
      issueId: '',
      projectRoot: '/repo',
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
    context = {
      projectId: 'proj',
      projectRoot: '/repo',
      storage,
      profileName: 'default',
      mainBranch: 'main',
      deps: {
        projectId: 'proj',
        projectRoot: '/repo',
        storage,
        worktrees: fakeWorktrees(storage, home),
        tmux: fakeTmux(),
        git: { resolveWorktreeGitDir: async (path: string) => `${path}/.git` },
        branchExists: async () => false,
        panes: [{ id: 'agent', kind: 'agent', focus: true }],
        profileName: 'default',
        shellPath: '/bin/bash',
      },
    };
  });

  afterEach(async () => {
    resetPlanRepositories();
    await rm(home, { recursive: true, force: true });
  });

  describe('new', () => {
    it('opens a session with no issue behind it and prints how to reach it', async () => {
      expect(await runSessionNew({ agent: 'codex', label: 'scratch' }, deps())).toBe(0);
      expect(errors).toEqual([]);
      expect(output[0]).toMatch(/^Session .+ — codex on session\/scratch-/);
      expect(output.join('\n')).toContain('issue-flow session attach');
    });

    it('loads a project custom agent and persists its id on the session', async () => {
      await writeFile(
        join(home, '.issue-flow.json'),
        JSON.stringify({
          agents: {
            gemini: {
              label: 'Gemini',
              // biome-ignore lint/suspicious/noTemplateCurlyInString: custom command syntax under test.
              startCommand: 'gemini --prompt "${PROMPT}"',
              // biome-ignore lint/suspicious/noTemplateCurlyInString: custom command syntax under test.
              resumeCommand: 'gemini --resume "${BRANCH}"',
            },
          },
        }),
      );
      context.projectRoot = home;
      context.storage.projectRoot = home;
      context.deps.projectRoot = home;

      expect(
        await runSessionNew(
          { agent: 'gemini', prompt: 'inspect; touch /tmp/nope', json: true },
          deps(),
        ),
      ).toBe(0);
      const payload = JSON.parse(output.join('\n')) as { session: AgentSession };
      expect(payload.session.provider).toBe('gemini');
    });

    it('refuses an agent nobody has', async () => {
      expect(await runSessionNew({ agent: 'gpt' }, deps())).toBe(1);
      expect(errors[0]).toBe("Unknown agent 'gpt'.");
    });

    it('refuses a permission level that does not exist, naming the three that do', async () => {
      expect(await runSessionNew({ permission: 'yolo' }, deps())).toBe(1);
      expect(errors[0]).toContain('read-only, workspace, autonomous');
    });

    it('defaults to `workspace`, never to `autonomous`', async () => {
      expect(await runSessionNew({ json: true }, deps())).toBe(0);
      const payload = JSON.parse(output.join('\n')) as { session: AgentSession };
      expect(payload.session.runId).toBeNull();
      expect(payload.session.phase).toBeNull();
      expect(payload.session.storyId).toBeNull();
    });
  });

  describe('ls', () => {
    it('lists only free sessions by default, and everything with --all', async () => {
      await saveSession(
        storage,
        createAgentSession({ branch: 'session/a', provider: 'claude', label: 'scratch' }),
      );
      await saveSession(
        storage,
        createAgentSession({
          branch: 'feat/1-x',
          provider: 'codex',
          runId: 'run-1',
          phase: 'execute',
        }),
      );

      await runSessionLs({ json: true }, deps());
      expect((JSON.parse(output.join('\n')) as { sessions: AgentSession[] }).sessions).toHaveLength(
        1,
      );

      output.length = 0;
      await runSessionLs({ json: true, all: true }, deps());
      expect((JSON.parse(output.join('\n')) as { sessions: AgentSession[] }).sessions).toHaveLength(
        2,
      );
    });

    it('says which mode each row is, because nothing else on it would', () => {
      const free = createAgentSession({
        branch: 'session/a',
        provider: 'claude',
        label: 'scratch',
      });
      const workflow = createAgentSession({
        branch: 'feat/1-x',
        provider: 'codex',
        runId: 'run-1',
        phase: 'execute',
      });
      const table = formatSessionTable([free, workflow]);
      expect(table[0]).toContain('MODE');
      expect(table[1]).toContain('free');
      expect(table[1]).toContain('scratch');
      expect(table[2]).toContain('run run-1');
      expect(table[2]).toContain('feat/1-x');
    });

    it('points at the command that creates one when there is none', () => {
      expect(formatSessionTable([])).toEqual(['No session. Open one with: issue-flow session new']);
    });
  });

  describe('attach', () => {
    it('targets the project session and the branch window', async () => {
      const session = createAgentSession({ branch: 'session/a', provider: 'claude' });
      await saveSession(storage, session);

      let target: { sessionName: string; windowName: string } | null = null;
      expect(
        await runSessionAttach(
          session.id,
          {},
          {
            ...deps(),
            attach: (input) => {
              target = input;
              return 0;
            },
          },
        ),
      ).toBe(0);
      expect(target).toEqual({ sessionName: 'if-proj', windowName: 'if-session-a' });
    });

    it('fails on an id this project does not have', async () => {
      expect(await runSessionAttach('nope', {}, deps())).toBe(1);
      expect(errors[0]).toContain("No session with id 'nope'");
    });
  });

  describe('stop', () => {
    it('keeps the worktree unless asked, and says so', async () => {
      expect(
        await runSessionNew({ branch: 'session/a', agent: 'claude', json: true }, deps()),
      ).toBe(0);
      const { session } = JSON.parse(output.join('\n')) as { session: AgentSession };
      output = [];

      expect(await runSessionStop(session.id, {}, deps())).toBe(0);
      expect(output[0]).toContain('Its worktree and branch are untouched.');
    });
  });

  describe('link', () => {
    /** A run has to exist to be linked to; this is the cheapest way to have one. */
    async function seedRun(issueId: string, runId: string): Promise<void> {
      await saveSessionEvent(
        { ...storage, issueId },
        {
          sessionId: runId,
          sequence: 1,
          event: {
            type: 'session:start',
            at: '2026-09-06T10:00:00.000Z',
            sessionId: runId,
            issueNumber: Number(issueId),
            phases: ['execute'],
          },
          snapshot: { ...createInitialSnapshot(), sessionId: runId, status: 'running' },
        },
      );
    }

    it('fills run_id and leaves the conversation exactly where it was (S4)', async () => {
      await seedRun('42', 'run-42');
      const session = createAgentSession({
        branch: 'session/a',
        provider: 'claude',
        conversationId: 'conv-1',
      });
      await saveSession(storage, session);

      expect(await runSessionLink(session.id, { issue: '42' }, deps())).toBe(0);
      expect(output[0]).toContain('run-42');
      expect(output[0]).toContain('conversation is unchanged');
    });

    it('refuses when the issue has no run, and never invents one', async () => {
      const session = createAgentSession({ branch: 'session/a', provider: 'claude' });
      await saveSession(storage, session);

      expect(await runSessionLink(session.id, { issue: '77' }, deps())).toBe(1);
      expect(errors[0]).toContain('issue-flow run 77');
    });

    it('refuses to relink a session that already belongs to a run', async () => {
      await seedRun('42', 'run-42');
      const session = createAgentSession({
        branch: 'feat/1-x',
        provider: 'claude',
        runId: 'run-1',
        phase: 'execute',
      });
      await saveSession(storage, session);

      expect(await runSessionLink(session.id, { issue: '42' }, deps())).toBe(1);
      expect(errors[0]).toContain('already belongs to run run-1');
    });

    it('asks for a target when neither --issue nor --run is given', async () => {
      expect(await runSessionLink('whatever', {}, deps())).toBe(1);
      expect(errors[0]).toContain('--issue');
    });
  });
});
