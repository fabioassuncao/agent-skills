import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaneTemplate } from '../../runtime/profiles.js';
import { createReconciler } from '../../runtime/reconcile.js';
import type { TmuxGateway } from '../../runtime/tmux/gateway.js';
import {
  buildProjectSessionName,
  buildWorktreeWindowName,
  type TmuxWindowSummary,
} from '../../runtime/tmux/names.js';
import type { CreatedWorktree, ManagedWorktree } from '../../runtime/worktree/lifecycle.js';
import {
  listStoredAgentSessions,
  type PlanRepositoryContext,
  resetPlanRepositories,
} from '../../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../../storage/paths.js';
import { sessionPayload } from '../../web/sessions-api.js';
import type { AgentPhase } from '../types.js';
import { type AgentSessionDeps, openAgentSession, stopAgentSession } from './open.js';
import { selectReusableSession } from './reuse.js';
import { createAgentSession, linkSessionToRun, listSessions, saveSession } from './store.js';
import { type AgentSession, isFreeSession } from './types.js';

/**
 * §49.5 of the absorption plan, S1 to S7 — the acceptance criteria of the free
 * session, each one named after the row it defends.
 *
 * They run against stubbed git and tmux ports on purpose: what these scenarios
 * assert is the *decision* — which columns end up empty, which session the
 * pipeline is allowed to adopt, what a restart concludes about a window that is
 * still there. The versions that need a real `git worktree add` and a real tmux
 * server live in `open.integration.test.ts`, and they exercise the same calls.
 */

/** A tmux server that only remembers which windows exist. */
function fakeTmux(windows: Map<string, number> = new Map()): TmuxGateway & {
  windows: Map<string, number>;
  commands: Array<{ target: string; command: string }>;
  buffers: Array<{ target: string; content: string }>;
} {
  const commands: Array<{ target: string; command: string }> = [];
  const buffers: Array<{ target: string; content: string }> = [];
  const pending = new Map<string, string>();
  let current: { session: string; window: string } | null = null;

  const key = (session: string, window: string): string => `${session}:${window}`;

  return {
    windows,
    commands,
    buffers,
    isAvailable: async () => true,
    ensureServer: async () => {},
    ensureSession: async () => {},
    hasWindow: async (session, window) => windows.has(key(session, window)),
    killWindow: async (session, window) => {
      windows.delete(key(session, window));
    },
    createWindow: async ({ sessionName, windowName }) => {
      windows.set(key(sessionName, windowName), 1);
      current = { session: sessionName, window: windowName };
    },
    splitWindow: async () => {
      if (current === null) return;
      const k = key(current.session, current.window);
      windows.set(k, (windows.get(k) ?? 0) + 1);
    },
    setWindowOption: async () => {},
    runCommand: async (target, command) => {
      commands.push({ target, command });
    },
    sendLiteral: async () => {},
    sendKeys: async () => {},
    sendHexKeys: async () => {},
    loadBuffer: async (name, content) => {
      pending.set(name, content);
    },
    pasteBuffer: async ({ bufferName, target }) => {
      buffers.push({ target, content: pending.get(bufferName) ?? '' });
      pending.delete(bufferName);
    },
    hasBuffer: async (name) => pending.has(name),
    selectPane: async () => {},
    listWindows: async (): Promise<TmuxWindowSummary[]> =>
      [...windows.entries()].map(([k, paneCount]) => {
        const [sessionName = '', windowName = ''] = k.split(':');
        return { sessionName, windowName, paneCount };
      }),
    getPaneId: async () => '%1',
    countPanes: async (session, window) => windows.get(key(session, window)) ?? 0,
    killPane: async () => {},
  };
}

const PANES: readonly PaneTemplate[] = [
  { id: 'agent', kind: 'agent', focus: true },
  { id: 'shell', kind: 'shell', split: 'right', sizePct: 25 },
];

/** A worktree manager backed by a map, so no `git worktree add` is involved. */
function fakeWorktrees(): AgentSessionDeps['worktrees'] & { created: string[] } {
  const created: string[] = [];
  const live = new Map<string, ManagedWorktree>();
  return {
    created,
    create: async ({ branch }): Promise<CreatedWorktree> => {
      created.push(branch);
      const path = `/worktrees/${branch}`;
      live.set(branch, {
        branch,
        path,
        entry: { path, branch, head: null, bare: false, detached: false },
        binding: null,
        state: 'unmanaged',
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

function deps(
  storage: PlanRepositoryContext,
  projectId: string,
  tmux = fakeTmux(),
  worktrees = fakeWorktrees(),
): AgentSessionDeps & {
  tmux: ReturnType<typeof fakeTmux>;
  worktrees: ReturnType<typeof fakeWorktrees>;
} {
  return {
    projectId,
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
}

describe('§49.5 — the free session', () => {
  let home: string;
  let storage: PlanRepositoryContext;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-free-session-'));
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

  /* ── S1 ───────────────────────────────────────────────────────────────── */

  describe('S1 — `session new --agent codex` in a project with no issues', () => {
    it('creates the session, leaves run/phase/story empty and opens a pane', async () => {
      const context = deps(storage, 'proj-a');
      const opened = await openAgentSession(context, {
        provider: 'codex',
        permission: 'workspace',
        label: 'poke at the parser',
      });

      expect(opened.session.runId).toBeNull();
      expect(opened.session.phase).toBeNull();
      expect(opened.session.storyId).toBeNull();
      expect(isFreeSession(opened.session)).toBe(true);
      expect(opened.session.label).toBe('poke at the parser');

      // The branch was generated: not naming one is the whole point.
      expect(opened.branch).toMatch(/^session\/poke-at-the-parser-[0-9a-f]{8}$/);
      expect(context.worktrees.created).toEqual([opened.branch]);

      // A pane exists, and it is the agent's own — not merely the focused one.
      expect(opened.layout.mode).toBe('fresh');
      expect(opened.paneTarget).toBe(
        `${buildProjectSessionName('proj-a')}:${buildWorktreeWindowName(opened.branch)}.0`,
      );
      const agentCommand = context.tmux.commands.find((entry) => entry.command.includes('codex'));
      expect(agentCommand?.target).toBe(opened.paneTarget);
      // ADR-04: the argv is serialized once, at the tmux boundary, and the
      // hooks flag is what keeps agent state knowable (ADR-05).
      expect(agentCommand?.command).toContain("'codex' '--enable' 'hooks'");
    });

    it('never writes a run, so it cannot have started the pipeline', async () => {
      await openAgentSession(deps(storage, 'proj-a'), {
        provider: 'claude',
        permission: 'workspace',
      });

      const rows = await listStoredAgentSessions(storage);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.runId).toBeNull();
      // The row the pipeline would have created does not exist.
      expect(await listSessions(storage, { runId: 'anything' })).toEqual([]);
    });
  });

  /* ── S2 ───────────────────────────────────────────────────────────────── */

  describe('S2 — three free sessions and one workflow run in the same project', () => {
    it('keeps four live sessions in four distinct windows', async () => {
      const context = deps(storage, 'proj-a');
      const free = [];
      for (const label of ['one', 'two', 'three']) {
        free.push(
          await openAgentSession(context, { provider: 'claude', permission: 'workspace', label }),
        );
      }
      const workflow = await openAgentSession(context, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'feat/42-thing',
        runId: 'run-42',
        phase: 'execute',
      });

      const all = await listSessions(storage);
      expect(all).toHaveLength(4);
      expect(all.filter(isFreeSession)).toHaveLength(3);

      const windows = new Set([...free, workflow].map((opened) => opened.paneTarget));
      expect(windows.size).toBe(4);
      expect(context.tmux.windows.size).toBe(4);
    });
  });

  /* ── S3 ───────────────────────────────────────────────────────────────── */

  describe('S3 — a free session in two projects at once', () => {
    it('isolates them by the per-project tmux session name', async () => {
      const other: PlanRepositoryContext = { ...storage, projectId: 'proj-b' };
      const tmux = fakeTmux();

      const a = await openAgentSession(deps(storage, 'proj-a', tmux), {
        provider: 'claude',
        permission: 'workspace',
        branch: 'session/shared-name',
      });
      const b = await openAgentSession(deps(other, 'proj-b', tmux), {
        provider: 'claude',
        permission: 'workspace',
        branch: 'session/shared-name',
      });

      // Same branch, same window name — different tmux *session*, which is the
      // isolation boundary (§13): one session per project.
      expect(a.paneTarget.startsWith(buildProjectSessionName('proj-a'))).toBe(true);
      expect(b.paneTarget.startsWith(buildProjectSessionName('proj-b'))).toBe(true);
      expect(a.paneTarget).not.toBe(b.paneTarget);
      expect(tmux.windows.size).toBe(2);

      // And each database context only ever sees its own.
      expect(await listSessions(storage)).toHaveLength(1);
      expect(await listSessions(other)).toHaveLength(1);
    });
  });

  /* ── S4 ───────────────────────────────────────────────────────────────── */

  describe('S4 — `session link <id> --issue 42`', () => {
    it('fills run_id and preserves everything that carries the history', async () => {
      const opened = await openAgentSession(deps(storage, 'proj-a'), {
        provider: 'claude',
        permission: 'workspace',
        label: 'became issue 42',
      });
      // The provider reported a conversation; that is what must survive.
      const withConversation: AgentSession = { ...opened.session, conversationId: 'conv-1' };
      await saveSession(storage, withConversation);

      const linked = await linkSessionToRun(storage, withConversation, 'run-42');

      expect(linked.runId).toBe('run-42');
      expect(isFreeSession(linked)).toBe(false);
      expect(linked.id).toBe(opened.session.id);
      expect(linked.conversationId).toBe('conv-1');
      expect(linked.branch).toBe(opened.branch);
      expect(linked.paneTarget).toBe(opened.paneTarget);
      expect(linked.createdAt).toBe(opened.session.createdAt);

      // One row, promoted — not a second row alongside the first.
      expect(await listSessions(storage)).toHaveLength(1);
    });
  });

  /* ── S5 ───────────────────────────────────────────────────────────────── */

  describe('S5 — a `review` phase with a live free session on the same worktree', () => {
    it('never continues the free conversation, whichever phase asks (ADR-07)', async () => {
      const context = deps(storage, 'proj-a');
      const free = await openAgentSession(context, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'feat/42-thing',
      });
      await saveSession(storage, { ...free.session, conversationId: 'conv-free' });

      const sessions = await listSessions(storage, { branch: 'feat/42-thing' });
      for (const phase of ['review', 'pr-review'] as AgentPhase[]) {
        expect(selectReusableSession({ phase, branch: 'feat/42-thing', sessions })).toBeNull();
      }
    });

    it('refuses to seat a reviewer in the person\u2019s pane rather than sharing it', async () => {
      const context = deps(storage, 'proj-a');
      const free = await openAgentSession(context, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'feat/42-thing',
      });
      await saveSession(storage, { ...free.session, conversationId: 'conv-free' });

      // A reattach does not re-run the agent argv, so putting a `review` into
      // that window would hand it the very conversation ADR-07 forbids —
      // through the pane instead of through `--resume`. Refusing is the only
      // answer that keeps the verdict meaning anything.
      await expect(
        openAgentSession(context, {
          provider: 'claude',
          permission: 'read-only',
          branch: 'feat/42-thing',
          runId: 'run-42',
          phase: 'review',
        }),
      ).rejects.toMatchObject({ name: 'AgentSessionError', status: 409 });

      // And the free session is untouched: refusing costs the person nothing.
      const [still] = await listSessions(storage, { branch: 'feat/42-thing' });
      expect(still?.id).toBe(free.session.id);
      expect(still?.conversationId).toBe('conv-free');
    });

    it('opens a brand-new session for a review on a branch nobody is sitting in', async () => {
      const context = deps(storage, 'proj-a');
      const reviewer = await openAgentSession(context, {
        provider: 'claude',
        permission: 'read-only',
        branch: 'feat/42-thing',
        runId: 'run-42',
        phase: 'review',
      });

      expect(reviewer.launchMode).toBe('fresh');
      expect(reviewer.session.conversationId).toBeNull();
      expect(reviewer.session.phase).toBe('review');
      expect(isFreeSession(reviewer.session)).toBe(false);
    });

    it('also refuses to adopt a free session for a phase that may reuse one', async () => {
      const context = deps(storage, 'proj-a');
      const free = await openAgentSession(context, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'feat/42-thing',
      });
      await saveSession(storage, { ...free.session, conversationId: 'conv-free' });

      const sessions = await listSessions(storage, { branch: 'feat/42-thing' });
      // `execute` *is* allowed to continue a conversation — just never a
      // person's own. This is the guard that is easy to lose.
      expect(
        selectReusableSession({ phase: 'execute', branch: 'feat/42-thing', sessions }),
      ).toBeNull();
    });

    it('lets a free session continue its own conversation', async () => {
      const context = deps(storage, 'proj-a');
      const first = await openAgentSession(context, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'session/keep-going',
      });
      await saveSession(storage, { ...first.session, conversationId: 'conv-free' });
      // The window died; the conversation did not.
      context.tmux.windows.clear();

      const second = await openAgentSession(context, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'session/keep-going',
      });

      expect(second.session.id).toBe(first.session.id);
      expect(second.launchMode).toBe('resume');
      expect(context.tmux.commands.at(-1)?.command.includes("'--resume' 'conv-free'")).toBe(true);
    });
  });

  /* ── S6 ───────────────────────────────────────────────────────────────── */

  describe('S6 — a server restart with free sessions open', () => {
    it('finds them again from what is alive, and reattaches rather than rebuilds', async () => {
      const context = deps(storage, 'proj-a');
      const opened = await openAgentSession(context, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'session/survivor',
      });
      await saveSession(storage, { ...opened.session, conversationId: 'conv-1' });

      // A fresh process: nothing in memory, only the database and the world.
      const reconciler = createReconciler({
        projectId: 'proj-a',
        worktrees: {
          list: async () => [
            {
              branch: 'session/survivor',
              path: '/worktrees/session/survivor',
              entry: {
                path: '/worktrees/session/survivor',
                branch: 'session/survivor',
                head: null,
                bare: false,
                detached: false,
              },
              binding: null,
              state: 'unmanaged',
            } as ManagedWorktree,
          ],
        },
        tmux: context.tmux,
        storage,
      });

      const result = await reconciler.reconcile();
      const session = result.worktrees[0]?.agentSessions[0];
      expect(session?.id).toBe(opened.session.id);
      expect(session?.runId).toBeNull();
      expect(session?.status).toBe('starting');
      // The window survived the restart, so the agent inside it did too —
      // rebuilding would kill it (§27).
      expect(session?.recovery).toBe('reattach');
      expect(result.orphanedSessionIds).toEqual([]);
    });

    it('marks a free session orphaned when its window is gone, and offers a resume', async () => {
      const context = deps(storage, 'proj-a');
      const opened = await openAgentSession(context, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'session/gone',
      });
      await saveSession(storage, { ...opened.session, conversationId: 'conv-1' });
      context.tmux.windows.clear();

      const reconciler = createReconciler({
        projectId: 'proj-a',
        worktrees: {
          list: async () => [
            {
              branch: 'session/gone',
              path: '/worktrees/session/gone',
              entry: {
                path: '/worktrees/session/gone',
                branch: 'session/gone',
                head: null,
                bare: false,
                detached: false,
              },
              binding: null,
              state: 'unmanaged',
            } as ManagedWorktree,
          ],
        },
        tmux: context.tmux,
        storage,
      });

      const result = await reconciler.reconcile();
      expect(result.orphanedSessionIds).toEqual([opened.session.id]);
      expect(result.worktrees[0]?.agentSessions[0]?.recovery).toBe('resume');
    });
  });

  /* ── S7 ───────────────────────────────────────────────────────────────── */

  describe('S7 — a free session has no verification', () => {
    it('invents no verdict: the wire payload carries none at all', async () => {
      const opened = await openAgentSession(deps(storage, 'proj-a'), {
        provider: 'claude',
        permission: 'workspace',
        label: 'scratch',
      });

      const payload = sessionPayload(opened.session);
      expect(payload.free).toBe(true);
      // Not "unverified", not "passed", not "pending" — absent. There is no
      // acceptance contract behind a session nobody wrote a contract for, and
      // a field with a default value is how a default becomes a claim.
      for (const key of ['verification', 'verdict', 'verified', 'review', 'acceptance']) {
        expect(payload).not.toHaveProperty(key);
      }
      expect(payload.runId).toBeNull();
      expect(payload.phase).toBeNull();
      expect(payload.storyId).toBeNull();
    });

    it('says "sem verificação" through the absence of a run, not a fabricated one', async () => {
      // The dashboard's rule: no run behind the session means there is nothing
      // to look a verdict up by. `runId === null` is the whole signal.
      const free = createAgentSession({ branch: 'session/x', provider: 'claude' });
      await saveSession(storage, free);
      const [row] = await listSessions(storage);
      expect(row?.runId).toBeNull();
      expect(isFreeSession(row as AgentSession)).toBe(true);
    });
  });

  /* ── the invariant that binds them ────────────────────────────────────── */

  describe('one model, two modes (ADR-16)', () => {
    it('stores both modes in the same table, told apart only by empty columns', async () => {
      const context = deps(storage, 'proj-a');
      await openAgentSession(context, { provider: 'claude', permission: 'workspace' });
      await openAgentSession(context, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'feat/1-x',
        runId: 'run-1',
        phase: 'execute',
        storyId: 'US-001',
      });

      const rows = await listStoredAgentSessions(storage);
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.runId === null)).toHaveLength(1);
      expect(rows.filter((row) => row.runId !== null)).toHaveLength(1);
    });

    it('stopping one free session leaves the others on other branches alone', async () => {
      const context = deps(storage, 'proj-a');
      const first = await openAgentSession(context, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'session/a',
      });
      await openAgentSession(context, {
        provider: 'claude',
        permission: 'workspace',
        branch: 'session/b',
      });

      const stopped = await stopAgentSession(context, first.session);
      expect(stopped.status).toBe('stopped');
      expect(stopped.endedAt).not.toBeNull();
      expect(context.tmux.windows.size).toBe(1);
      // The worktree survives unless it was asked for explicitly: the work in
      // it is the reason the session existed.
      expect(context.worktrees.created).toContain('session/a');
    });
  });
});
