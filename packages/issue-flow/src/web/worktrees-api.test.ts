import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionDeps } from '../agents/session/open.js';
import { createAgentSession, saveSession } from '../agents/session/store.js';
import type { TmuxGateway } from '../runtime/tmux/gateway.js';
import type { CreatedWorktree, ManagedWorktree } from '../runtime/worktree/lifecycle.js';
import { type PlanRepositoryContext, resetPlanRepositories } from '../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import type { SessionsApiProject } from './sessions-api.js';
import {
  ciLogsRoute,
  formatElapsed,
  listWorktreesRoute,
  matchCiLogs,
  matchSyncPullRequests,
  syncWorktreePullRequestsRoute,
  type WorktreesApiDeps,
} from './worktrees-api.js';

/**
 * `GET /api/worktrees` — the sidebar's session group and a Task's own workspace
 * list (I1).
 *
 * The point of every case here is that the answer is a **projection of the
 * agent sessions**, not a second worktree registry: `executionId` is the
 * session's `runId`, and the run id is the dashboard's `sessionId`. That single
 * equality is what lets a Task list its own workspaces and what makes the
 * promotion of §49.2 show the workflow with no new component (I4).
 *
 * Nothing here touches a socket: `readGitWorktreeStatus` is mocked, the probe is
 * injected, and the handler returns `{ status, body }`.
 */

vi.mock('../runtime/worktree/git.js', async () => {
  const actual = await vi.importActual<typeof import('../runtime/worktree/git.js')>(
    '../runtime/worktree/git.js',
  );
  return {
    ...actual,
    readGitWorktreeStatus: vi.fn(async () => ({
      dirty: true,
      aheadCount: 2,
      currentCommit: 'abc1234',
    })),
  };
});

function fakeTmux(): TmuxGateway {
  return {
    isAvailable: async () => true,
    ensureServer: async () => {},
    ensureSession: async () => {},
    hasWindow: async () => false,
    killWindow: async () => {},
    createWindow: async () => {},
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
    getPaneId: async () => '%1',
    countPanes: async () => 1,
    killPane: async () => {},
  };
}

function managed(branch: string, allocatedPorts: Record<string, number> = {}): ManagedWorktree {
  const path = `/worktrees/${branch}`;
  return {
    branch,
    path,
    entry: { path, branch, head: null, bare: false, detached: false },
    binding: {
      worktreeId: `wt-${branch}`,
      branch,
      path,
      baseBranch: 'main',
      label: null,
      profile: 'default',
      agent: 'claude',
      runtime: 'host',
      startupEnvValues: {},
      allocatedPorts,
      source: null,
      conversationId: null,
      createdAt: '2026-09-06T10:00:00.000Z',
      updatedAt: '2026-09-06T10:00:00.000Z',
    },
    state: 'managed',
  };
}

describe('the worktree listing', () => {
  let home: string;
  let storage: PlanRepositoryContext;
  let project: SessionsApiProject;
  let deps: WorktreesApiDeps;
  let worktrees: ManagedWorktree[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-worktrees-api-'));
    storage = {
      tasksPath: '',
      projectId: 'proj',
      issueId: '',
      projectRoot: '/repo',
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
    worktrees = [];
    const sessionDeps: AgentSessionDeps = {
      projectId: 'proj',
      projectRoot: '/repo',
      storage,
      worktrees: {
        create: async () => ({}) as CreatedWorktree,
        list: async () => worktrees,
        remove: async () => {},
      },
      tmux: fakeTmux(),
      git: { resolveWorktreeGitDir: async (path: string) => `${path}/.git` },
      branchExists: async () => false,
      panes: [{ id: 'agent', kind: 'agent', focus: true }],
      profileName: 'default',
    };
    project = { projectId: 'proj', deps: sessionDeps, services: [] };
    deps = {
      resolveProject: async () => project,
      probe: { isListening: async () => true },
      now: () => Date.parse('2026-09-06T10:05:00.000Z'),
    };
  });

  afterEach(async () => {
    resetPlanRepositories();
    await rm(home, { recursive: true, force: true });
  });

  it('answers an empty list on a monitor with no session surface', async () => {
    expect(await listWorktreesRoute(null, null)).toEqual({ status: 200, body: { worktrees: [] } });
  });

  it('carries the run id as executionId, which is what links a Task to its workspaces', async () => {
    worktrees.push(managed('feat/42-x'), managed('session/scratch'));
    await saveSession(
      storage,
      createAgentSession({
        branch: 'feat/42-x',
        provider: 'claude',
        runId: 'run-42',
        phase: 'execute',
      }),
    );
    await saveSession(
      storage,
      createAgentSession({ branch: 'session/scratch', provider: 'codex', label: 'rascunho' }),
    );

    const response = await listWorktreesRoute(deps, 'proj');
    const rows = (response.body as { worktrees: Array<Record<string, unknown>> }).worktrees;

    const workflow = rows.find((row) => row.branch === 'feat/42-x');
    expect(workflow?.executionId).toBe('run-42');
    // A free session carries none — the three null columns of ADR-16 are what
    // make it free, and the panel reads exactly this field to decide whether to
    // show the workflow (I4).
    const free = rows.find((row) => row.branch === 'session/scratch');
    expect(free?.executionId).toBeNull();
    expect(free?.label).toBe('rascunho');
  });

  it('reports git state and probed service health per workspace', async () => {
    project = { ...project, services: [{ name: 'web', portEnv: 'PORT', command: 'npm start' }] };
    worktrees.push(managed('session/a', { PORT: 4321 }));
    await saveSession(storage, createAgentSession({ branch: 'session/a', provider: 'claude' }));

    const response = await listWorktreesRoute(deps, 'proj');
    const row = (response.body as { worktrees: Array<Record<string, unknown>> }).worktrees[0];

    expect(row?.dirty).toBe(true);
    expect(row?.unpushed).toBe(true);
    expect(row?.profile).toBe('default');
    expect(row?.services).toEqual([{ name: 'web', port: 4321, running: true, url: null }]);
  });

  it('leaves out a session that is no longer live, so no row offers a dead terminal', async () => {
    worktrees.push(managed('session/gone'));
    const stopped = {
      ...createAgentSession({ branch: 'session/gone', provider: 'claude' }),
      status: 'stopped' as const,
    };
    await saveSession(storage, stopped);

    const response = await listWorktreesRoute(deps, 'proj');
    expect((response.body as { worktrees: unknown[] }).worktrees).toHaveLength(0);
  });

  it('never claims a pull request state nobody observed', async () => {
    worktrees.push(managed('session/a'));
    await saveSession(storage, createAgentSession({ branch: 'session/a', provider: 'claude' }));

    const withoutSync = await listWorktreesRoute(deps, 'proj');
    expect(
      (
        (withoutSync.body as { worktrees: Array<Record<string, unknown>> }).worktrees[0] as {
          prs: unknown[];
        }
      ).prs,
    ).toEqual([]);

    const withSync = await listWorktreesRoute(
      {
        ...deps,
        pullRequestsFor: (projectId, branch) =>
          projectId === 'proj' && branch === 'session/a'
            ? [
                {
                  repo: '',
                  number: 7,
                  state: 'open',
                  isDraft: false,
                  url: 'https://example.test/pr/7',
                  updatedAt: '2026-09-06T09:00:00.000Z',
                  ciStatus: 'success',
                  ciChecks: [],
                  comments: [],
                },
              ]
            : [],
      },
      'proj',
    );
    const row = (withSync.body as { worktrees: Array<Record<string, unknown>> }).worktrees[0];
    expect((row?.prs as Array<{ number: number }>)[0]?.number).toBe(7);
  });
});

describe('the §20 read surfaces', () => {
  it('matches the two paths and nothing else', () => {
    expect(matchSyncPullRequests('/api/worktrees/feat%2F1/sync-prs')).toBe('feat/1');
    expect(matchSyncPullRequests('/api/worktrees/feat/sync-prs/x')).toBeNull();
    expect(matchCiLogs('/api/ci-logs/12345')).toBe(12345);
    expect(matchCiLogs('/api/ci-logs/abc')).toBeNull();
  });

  it('refuses both on a monitor that serves neither', async () => {
    expect((await syncWorktreePullRequestsRoute(null, null, 'x')).status).toBe(501);
    expect((await ciLogsRoute(null, null, 1)).status).toBe(501);
  });

  it('answers the failed-run log as a body, so the dialog can say why there is none', async () => {
    const response = await ciLogsRoute(
      {
        resolveProject: async () =>
          ({ projectId: 'proj', deps: {}, services: [] }) as unknown as SessionsApiProject,
        ciLog: async () => 'gh run view failed for run 9: not found',
      },
      'proj',
      9,
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ logs: 'gh run view failed for run 9: not found' });
  });
});

describe('elapsed', () => {
  it('is coarse, and says nothing at all about an unparseable timestamp', () => {
    const now = Date.parse('2026-09-06T12:00:00.000Z');
    expect(formatElapsed('2026-09-06T11:59:30.000Z', now)).toBe('30s');
    expect(formatElapsed('2026-09-06T11:30:00.000Z', now)).toBe('30m');
    expect(formatElapsed('2026-09-06T09:00:00.000Z', now)).toBe('3h');
    expect(formatElapsed('2026-09-04T12:00:00.000Z', now)).toBe('2d');
    expect(formatElapsed('not a date', now)).toBe('');
  });
});
