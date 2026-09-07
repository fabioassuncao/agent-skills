import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlanRepositoryContext } from '../../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../../storage/paths.js';
import type { ResolvedAgentSessionContext } from './context.js';
import { AgentSessionError, listAgentSessions, type OpenedAgentSession } from './open.js';
import { createAgentSession, saveSession } from './store.js';
import type { AgentSession } from './types.js';
import {
  autoRemoveManagedWorktree,
  mergeManagedWorktree,
  openManagedWorktrees,
  planClosedWorktreePrune,
  pruneClosedWorktrees,
  removeManagedWorktree,
  setManagedWorktreeArchived,
} from './worktree-control.js';

function opened(branch: string, worktreeCreated = true, branchCreated = true): OpenedAgentSession {
  const session = {
    id: `session-${branch}`,
    branch,
    status: 'starting',
    paneTarget: 'project:window.0',
  } as AgentSession;
  return {
    session,
    branch,
    worktreePath: `/worktrees/${branch}`,
    paneTarget: 'project:window.0',
    layout: {
      mode: 'fresh',
      sessionName: 'project',
      windowName: 'window',
      focusTarget: 'project:window.0',
    },
    launchMode: 'fresh',
    worktreeCreated,
    branchCreated,
  };
}

function context(remove = vi.fn(async () => {})): ResolvedAgentSessionContext {
  return {
    deps: {} as never,
    storage: {} as never,
    startupEnv: {},
    services: [],
    worktrees: { remove, list: async () => [] } as never,
  } as ResolvedAgentSessionContext;
}

async function destructiveFixture(
  options: {
    state?: 'managed' | 'unmanaged' | 'orphaned';
    live?: boolean;
    dirty?: () => boolean;
    hasWindow?: () => boolean;
    killWindow?: () => Promise<void>;
    setArchived?: (archived: boolean) => Promise<void>;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'issue-flow-worktree-strict-'));
  const storage: PlanRepositoryContext = {
    tasksPath: '',
    projectId: 'project',
    issueId: '',
    projectRoot: '/repo',
    databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
  };
  const state = options.state ?? 'managed';
  const remove = vi.fn(async () => {});
  const merge = vi.fn(async () => {});
  const setArchived = vi.fn(async (_branch: string, archived: boolean) => {
    await options.setArchived?.(archived);
  });
  const killWindow = vi.fn(options.killWindow ?? (async () => {}));
  let path = '/worktrees/feature';
  let worktreeId = 'wt-feature';
  let bindingPresent = state !== 'unmanaged';
  const worktrees = {
    list: async () => [
      {
        branch: 'feature',
        path,
        entry:
          state === 'orphaned'
            ? null
            : { path, branch: 'feature', head: 'abc', detached: false, bare: false },
        binding: bindingPresent
          ? ({ branch: 'feature', worktreeId, archived: false } as never)
          : null,
        state,
      },
    ],
    status: async () => ({
      dirty: options.dirty?.() ?? false,
      aheadCount: 0,
      currentCommit: 'abc',
    }),
    remove,
    merge,
    setArchived,
  };
  const runtime = {
    projectId: 'project',
    storage,
    worktrees,
    deps: {
      projectId: 'project',
      storage,
      worktrees,
      tmux: {
        hasWindow: async () => options.hasWindow?.() ?? false,
        killWindow,
      },
    },
  } as unknown as ResolvedAgentSessionContext;
  if (options.live === true) {
    await saveSession(
      storage,
      createAgentSession({ branch: 'feature', provider: 'claude', status: 'running' }),
    );
  }
  return {
    runtime,
    storage,
    remove,
    merge,
    setArchived,
    killWindow,
    setPath: (next: string) => {
      path = next;
    },
    setWorktreeId: (next: string) => {
      worktreeId = next;
    },
    dropBinding: () => {
      bindingPresent = false;
    },
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

describe('canonical multi-agent worktree opening', () => {
  it('deduplicates agents and derives every target from one generated base', async () => {
    const calls: Array<{ provider: string; branch?: string }> = [];
    const open = vi.fn(async (_deps, input) => {
      calls.push({ provider: input.provider, branch: input.branch });
      return opened(input.branch as string);
    });
    const initial = context();

    const result = await openManagedWorktrees(
      { initial, resolveContext: async () => context(), open },
      { agents: ['claude', 'claude', 'codex'], prompt: 'shared task' },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.branch).toMatch(/^claude-session\/shared-task-/);
    expect(calls[1]?.branch).toBe((calls[0]?.branch as string).replace(/^claude-/, 'codex-'));
    expect(result.branches).toEqual(calls.map(({ branch }) => branch as string));
  });

  it('rejects multiple agents in existing mode before opening anything', async () => {
    const open = vi.fn();
    await expect(
      openManagedWorktrees(
        { initial: context(), resolveContext: async () => context(), open },
        { agents: ['claude', 'codex'], mode: 'existing', branch: 'feature' },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(open).not.toHaveBeenCalled();
  });

  it('allocates declared service ports for the new worktree', async () => {
    const initial = context();
    initial.services = [
      { name: 'web', portEnv: 'WEB_PORT', portStart: 5300, portStep: 10 },
      { name: 'api', portEnv: 'API_PORT', portStart: 7300, portStep: 10 },
    ];
    initial.worktrees.list = async () =>
      [{ binding: { allocatedPorts: { WEB_PORT: 5310, API_PORT: 7310 } } }] as never;
    const open = vi.fn(async (_deps, input) => opened(input.branch as string));

    await openManagedWorktrees(
      { initial, resolveContext: async () => initial, open },
      { agents: ['claude'], branch: 'feature' },
    );

    expect(open).toHaveBeenCalledWith(
      initial.deps,
      expect.objectContaining({ allocatedPorts: { WEB_PORT: 5320, API_PORT: 7320 } }),
    );
  });

  it('rolls back only created checkouts and preserves branches it did not create', async () => {
    const remove = vi.fn(async () => {});
    const initial = context(remove);
    const stop = vi.fn(async (_deps, session) => session);
    let call = 0;
    const open = vi.fn(async (_deps, input) => {
      call += 1;
      if (call === 1) return opened(input.branch as string, true, false);
      throw new AgentSessionError('second target failed', 409);
    });

    await expect(
      openManagedWorktrees(
        { initial, resolveContext: async () => initial, open, stop },
        { agents: ['claude', 'codex'], branch: 'feature' },
      ),
    ).rejects.toThrow('second target failed');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('claude-feature', { keepBranch: true });
  });

  it('never removes a pre-existing worktree while rolling back a later failure', async () => {
    const remove = vi.fn(async () => {});
    const initial = context(remove);
    const stop = vi.fn(async (_deps, session) => session);
    let call = 0;
    const open = vi.fn(async (_deps, input) => {
      call += 1;
      if (call === 1) return opened(input.branch as string, false, false);
      throw new AgentSessionError('second target failed', 409);
    });

    await expect(
      openManagedWorktrees(
        { initial, resolveContext: async () => initial, open, stop },
        { agents: ['claude', 'codex'], branch: 'feature' },
      ),
    ).rejects.toThrow('second target failed');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('canonical destructive ordering', () => {
  it('stops live sessions before merging or removing their checkout', async () => {
    const home = await mkdtemp(join(tmpdir(), 'issue-flow-worktree-control-'));
    const storage: PlanRepositoryContext = {
      tasksPath: '',
      projectId: 'project',
      issueId: '',
      projectRoot: '/repo',
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
    const events: string[] = [];
    const managed = (branch: string) => ({
      branch,
      path: `/worktrees/${branch}`,
      entry: {
        path: `/worktrees/${branch}`,
        branch,
        head: 'abc',
        detached: false,
        bare: false,
      },
      binding: { branch, worktreeId: `wt-${branch}` } as never,
      state: 'managed' as const,
    });
    const killed = new Set<string>();
    const worktrees = {
      list: async () => [managed('feature/merge'), managed('feature/remove')],
      create: async () => {
        throw new Error('not used');
      },
      status: async () => ({ dirty: false, aheadCount: 0, currentCommit: 'abc' }),
      remove: async (branch: string) => {
        events.push(`remove:${branch}`);
      },
      merge: async (branch: string) => {
        events.push(`merge:${branch}`);
      },
    };
    const runtime = {
      projectId: 'project',
      storage,
      worktrees,
      deps: {
        projectId: 'project',
        storage,
        worktrees,
        tmux: {
          hasWindow: async (_session: string, window: string) => !killed.has(window),
          killWindow: async (_session: string, window: string) => {
            events.push('stop');
            killed.add(window);
          },
        },
      },
    } as unknown as ResolvedAgentSessionContext;

    try {
      await saveSession(
        storage,
        createAgentSession({ branch: 'feature/merge', provider: 'claude', status: 'running' }),
      );
      await mergeManagedWorktree(runtime, 'feature/merge');
      await saveSession(
        storage,
        createAgentSession({ branch: 'feature/remove', provider: 'claude', status: 'running' }),
      );
      await removeManagedWorktree(runtime, 'feature/remove');

      expect(events).toEqual([
        'stop',
        'stop',
        'merge:feature/merge',
        'stop',
        'stop',
        'remove:feature/remove',
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('plans only closed worktrees owned by Issue Flow and applies that exact plan', async () => {
    const home = await mkdtemp(join(tmpdir(), 'issue-flow-worktree-prune-'));
    const storage: PlanRepositoryContext = {
      tasksPath: '',
      projectId: 'project',
      issueId: '',
      projectRoot: '/repo',
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
    const removed: string[] = [];
    const entry = (branch: string, state: 'managed' | 'unmanaged' | 'orphaned') => ({
      branch,
      path: `/worktrees/${branch}`,
      entry:
        state === 'orphaned'
          ? null
          : { path: `/worktrees/${branch}`, branch, head: 'abc', detached: false, bare: false },
      binding:
        state === 'managed' || state === 'orphaned'
          ? ({ branch, worktreeId: `wt-${branch}` } as never)
          : null,
      state,
    });
    const worktrees = {
      list: async () => [
        entry('feature/closed', 'managed'),
        entry('feature/live', 'managed'),
        entry('feature/dirty', 'managed'),
        entry('feature/external', 'unmanaged'),
        entry('feature/orphan', 'orphaned'),
      ],
      remove: async (branch: string) => {
        removed.push(branch);
      },
      status: async (branch: string) => ({
        dirty: branch === 'feature/dirty',
        aheadCount: 0,
        currentCommit: 'abc',
      }),
    };
    const runtime = {
      projectId: 'project',
      storage,
      worktrees,
      deps: {
        storage,
        worktrees,
        tmux: { hasWindow: async () => false, killWindow: async () => {} },
      },
    } as unknown as ResolvedAgentSessionContext;

    try {
      await saveSession(
        storage,
        createAgentSession({
          branch: 'feature/live',
          provider: 'claude',
          status: 'running',
          worktreeId: 'wt-feature/live',
        }),
      );
      const plan = await planClosedWorktreePrune(runtime);
      expect(plan).toEqual([
        {
          branch: 'feature/closed',
          path: '/worktrees/feature/closed',
          worktreeId: 'wt-feature/closed',
        },
      ]);

      await pruneClosedWorktrees(runtime, plan);
      expect(removed).toEqual(['feature/closed']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('strict destructive preconditions', () => {
  it('propagates killWindow failure and leaves git plus the live row untouched', async () => {
    const fixture = await destructiveFixture({
      live: true,
      hasWindow: () => true,
      killWindow: async () => {
        throw new Error('tmux refused');
      },
    });
    try {
      await expect(removeManagedWorktree(fixture.runtime, 'feature')).rejects.toThrow(
        'tmux refused',
      );
      expect(fixture.remove).not.toHaveBeenCalled();
      expect((await listAgentSessions(fixture.storage))[0]?.status).toBe('running');
    } finally {
      await fixture.cleanup();
    }
  });

  it('refuses git when the window still exists after killWindow returns', async () => {
    const fixture = await destructiveFixture({ live: true, hasWindow: () => true });
    try {
      await expect(mergeManagedWorktree(fixture.runtime, 'feature')).rejects.toThrow(
        'is still running',
      );
      expect(fixture.killWindow).toHaveBeenCalledOnce();
      expect(fixture.merge).not.toHaveBeenCalled();
      expect((await listAgentSessions(fixture.storage))[0]?.status).toBe('running');
    } finally {
      await fixture.cleanup();
    }
  });

  it('validates archive ownership before stopping a live session', async () => {
    const fixture = await destructiveFixture({
      state: 'unmanaged',
      live: true,
      hasWindow: () => true,
    });
    try {
      await expect(setManagedWorktreeArchived(fixture.runtime, 'feature', true)).rejects.toThrow(
        'not managed',
      );
      expect(fixture.killWindow).not.toHaveBeenCalled();
      expect(fixture.setArchived).not.toHaveBeenCalled();
      expect((await listAgentSessions(fixture.storage))[0]?.status).toBe('running');
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not archive when strict tmux shutdown fails', async () => {
    const fixture = await destructiveFixture({
      live: true,
      hasWindow: () => true,
      killWindow: async () => {
        throw new Error('cannot stop window');
      },
    });
    try {
      await expect(setManagedWorktreeArchived(fixture.runtime, 'feature', true)).rejects.toThrow(
        'cannot stop window',
      );
      expect(fixture.setArchived).toHaveBeenNthCalledWith(1, 'feature', true);
      expect(fixture.setArchived).toHaveBeenNthCalledWith(2, 'feature', false);
      expect((await listAgentSessions(fixture.storage))[0]?.status).toBe('running');
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not stop a live session when archive persistence fails', async () => {
    const fixture = await destructiveFixture({
      live: true,
      hasWindow: () => true,
      setArchived: async () => {
        throw new Error('database is unavailable');
      },
    });
    try {
      await expect(setManagedWorktreeArchived(fixture.runtime, 'feature', true)).rejects.toThrow(
        'database is unavailable',
      );
      expect(fixture.killWindow).not.toHaveBeenCalled();
      expect(fixture.setArchived).toHaveBeenCalledOnce();
      expect((await listAgentSessions(fixture.storage))[0]?.status).toBe('running');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('prune revalidation', () => {
  it('never plans or kills a worktree whose tmux window is physically open', async () => {
    const fixture = await destructiveFixture({ hasWindow: () => true });
    try {
      await expect(planClosedWorktreePrune(fixture.runtime)).resolves.toEqual([]);
      expect(fixture.killWindow).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects path and binding changes between plan and apply', async () => {
    const fixture = await destructiveFixture();
    try {
      const plan = await planClosedWorktreePrune(fixture.runtime);
      fixture.setPath('/worktrees/replaced');
      const pathChanged = await pruneClosedWorktrees(fixture.runtime, plan);
      expect(pathChanged.failed[0]?.error).toContain('identity changed');
      fixture.setPath('/worktrees/feature');
      fixture.setWorktreeId('wt-recreated');
      const identityChanged = await pruneClosedWorktrees(fixture.runtime, plan);
      expect(identityChanged.failed[0]?.error).toContain('identity changed');
      fixture.setWorktreeId('wt-feature');
      fixture.dropBinding();
      const bindingChanged = await pruneClosedWorktrees(fixture.runtime, plan);
      expect(bindingChanged.failed[0]?.error).toContain('not managed');
      expect(fixture.remove).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a worktree that reopened after the plan', async () => {
    const fixture = await destructiveFixture();
    try {
      const plan = await planClosedWorktreePrune(fixture.runtime);
      await saveSession(
        fixture.storage,
        createAgentSession({ branch: 'feature', provider: 'claude', status: 'running' }),
      );
      const result = await pruneClosedWorktrees(fixture.runtime, plan);
      expect(result.failed[0]?.error).toContain('is open');
      expect(fixture.remove).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('rechecks dirty state after strict shutdown immediately before git', async () => {
    let statusReads = 0;
    const fixture = await destructiveFixture({
      dirty: () => {
        statusReads += 1;
        return statusReads >= 3;
      },
    });
    try {
      const plan = await planClosedWorktreePrune(fixture.runtime);
      expect(plan).toHaveLength(1);
      const result = await pruneClosedWorktrees(fixture.runtime, plan);
      expect(result.failed[0]?.error).toContain('became dirty');
      expect(fixture.remove).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('scheduled auto-remove revalidation', () => {
  const merged = (headCommit = 'abc') =>
    new Map([['feature', [{ state: 'merged', headCommit, currentRepository: true }]]]);

  it('skips a write that lands between the planning check and removal', async () => {
    let reads = 0;
    const fixture = await destructiveFixture({
      dirty: () => {
        reads += 1;
        return reads >= 2;
      },
    });
    try {
      await expect(
        autoRemoveManagedWorktree(fixture.runtime, 'feature', {
          expected: { path: '/worktrees/feature', worktreeId: 'wt-feature' },
          pullRequestEvidence: async () => merged(),
        }),
      ).resolves.toBe('dirty');
      expect(fixture.remove).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not let an old merged PR authorize a reused branch at another HEAD', async () => {
    const fixture = await destructiveFixture();
    try {
      await expect(
        autoRemoveManagedWorktree(fixture.runtime, 'feature', {
          expected: { path: '/worktrees/feature', worktreeId: 'wt-feature' },
          pullRequestEvidence: async () => merged('old-merged-head'),
        }),
      ).resolves.toBe('head-mismatch');
      expect(fixture.remove).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });
});
