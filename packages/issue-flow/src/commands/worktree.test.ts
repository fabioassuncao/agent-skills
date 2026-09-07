import { describe, expect, it, vi } from 'vitest';
import type { ResolvedAgentSessionContext } from '../agents/session/context.js';
import {
  runWorktreeArchive,
  runWorktreeLabel,
  runWorktreeLs,
  runWorktreeMerge,
  runWorktreePrune,
  runWorktreeRefresh,
  runWorktreeRemove,
  runWorktreeUnarchive,
  type WorktreeCommandDeps,
  type WorktreeRow,
} from './worktree.js';

function context(): ResolvedAgentSessionContext {
  return {
    projectId: 'project-1',
    projectRoot: '/repo',
    mainBranch: 'main',
  } as ResolvedAgentSessionContext;
}

function harness(overrides: WorktreeCommandDeps = {}) {
  const log = vi.fn();
  const raw = vi.fn();
  const error = vi.fn();
  const resolved = context();
  return {
    log,
    raw,
    error,
    context: resolved,
    deps: {
      resolveContext: vi.fn(async () => resolved),
      log,
      raw,
      error,
      ...overrides,
    } satisfies WorktreeCommandDeps,
  };
}

const rows: WorktreeRow[] = [
  {
    branch: 'feature/open',
    label: 'Open work',
    path: '/worktrees/open',
    state: 'managed',
    archived: false,
    live: true,
  },
  {
    branch: 'feature/closed',
    label: null,
    path: '/worktrees/closed',
    state: 'managed',
    archived: false,
    live: false,
  },
  {
    branch: 'feature/archive',
    label: 'Old work',
    path: '/worktrees/archive',
    state: 'managed',
    archived: true,
    live: false,
  },
];

describe('worktree list', () => {
  it('refreshes through the shared tab domain and emits pure JSON', async () => {
    const refreshTerminal = vi.fn(async () => ({
      sessionId: 'session-1',
      mode: 'resume' as const,
    }));
    const run = harness({ refreshTerminal });
    expect(await runWorktreeRefresh('feature/open', { json: true }, run.deps)).toBe(0);
    expect(refreshTerminal).toHaveBeenCalledWith(run.context, 'feature/open');
    expect(run.log).not.toHaveBeenCalled();
    expect(JSON.parse(String(run.raw.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      branch: 'feature/open',
      sessionId: 'session-1',
      mode: 'resume',
    });
  });

  it('shows a closed worktree even though there is no live session', async () => {
    const run = harness({ listRows: vi.fn(async () => rows) });
    expect(await runWorktreeLs({}, run.deps)).toBe(0);
    expect(run.log.mock.calls.flat().join('\n')).toContain('feature/closed');
    expect(run.log.mock.calls.flat().join('\n')).not.toContain('feature/archive');
  });

  it('can select archived worktrees and emits the canonical rows as JSON', async () => {
    const run = harness({ listRows: vi.fn(async () => rows) });
    expect(await runWorktreeLs({ archived: true, json: true }, run.deps)).toBe(0);
    const parsed = JSON.parse(run.raw.mock.calls[0]?.[0] as string) as {
      worktrees: WorktreeRow[];
    };
    expect(parsed.worktrees.map((row) => row.branch)).toEqual(['feature/archive']);
    expect(run.log).not.toHaveBeenCalled();
  });

  it('writes valid JSON to raw process stdout with no logger prefix', async () => {
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const resolved = context();
    try {
      expect(
        await runWorktreeLs(
          { all: true, json: true },
          {
            resolveContext: async () => resolved,
            listRows: async () => rows,
            log: () => {
              throw new Error('JSON passed through the human logger');
            },
          },
        ),
      ).toBe(0);
      const parsed = JSON.parse(output) as { worktrees: WorktreeRow[] };
      expect(parsed.worktrees).toHaveLength(3);
      expect(output.startsWith('{')).toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  it('rejects ambiguous list modes before resolving the repository', async () => {
    const run = harness();
    expect(await runWorktreeLs({ all: true, archived: true }, run.deps)).toBe(1);
    expect(run.deps.resolveContext).not.toHaveBeenCalled();
  });
});

describe('worktree curation', () => {
  it.each([
    ['archive', runWorktreeArchive, true],
    ['unarchive', runWorktreeUnarchive, false],
  ] as const)('%s delegates to the canonical archived-state operation', async (_name, run, value) => {
    const setArchived = vi.fn(async () => {});
    const test = harness({ setArchived });
    expect(await run('feature/a', {}, test.deps)).toBe(0);
    expect(setArchived).toHaveBeenCalledWith(test.context, 'feature/a', value);
  });

  it('sets a trimmed label and clears it through the same operation', async () => {
    const setLabel = vi.fn(async () => {});
    const run = harness({ setLabel });
    expect(await runWorktreeLabel('feature/a', '  Release prep  ', {}, run.deps)).toBe(0);
    expect(await runWorktreeLabel('feature/a', undefined, { clear: true }, run.deps)).toBe(0);
    expect(setLabel.mock.calls).toEqual([
      [run.context, 'feature/a', 'Release prep'],
      [run.context, 'feature/a', null],
    ]);
  });

  it('rejects an absent, conflicting or oversized label without mutation', async () => {
    const setLabel = vi.fn(async () => {});
    const run = harness({ setLabel });
    expect(await runWorktreeLabel('feature/a', undefined, {}, run.deps)).toBe(1);
    expect(await runWorktreeLabel('feature/a', 'caption', { clear: true }, run.deps)).toBe(1);
    expect(await runWorktreeLabel('feature/a', 'x'.repeat(81), {}, run.deps)).toBe(1);
    expect(setLabel).not.toHaveBeenCalled();
  });
});

describe('destructive worktree commands', () => {
  it('refuses remove without --yes when the terminal is not interactive', async () => {
    const remove = vi.fn(async () => {});
    const run = harness({ interactive: false, remove });
    expect(await runWorktreeRemove('feature/a', {}, run.deps)).toBe(1);
    expect(remove).not.toHaveBeenCalled();
    expect(run.error.mock.calls.flat().join('\n')).toContain('--yes');
  });

  it('accepts an interactive confirmation before removing', async () => {
    const remove = vi.fn(async () => {});
    const confirm = vi.fn(async () => true);
    const run = harness({ confirm, remove });
    expect(await runWorktreeRemove('feature/a', {}, run.deps)).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(run.context, 'feature/a');
  });

  it('allows --yes and delegates merge to the canonical operation', async () => {
    const merge = vi.fn(async () => {});
    const run = harness({ merge });
    expect(await runWorktreeMerge('feature/a', { yes: true }, run.deps)).toBe(0);
    expect(merge).toHaveBeenCalledWith(run.context, 'feature/a');
    expect(run.log.mock.calls.flat().join('\n')).toContain('main');
  });

  it('prints a prune plan without mutating by default', async () => {
    const plan = [{ branch: 'feature/closed', path: '/worktrees/closed', worktreeId: 'wt-closed' }];
    const applyPrune = vi.fn(async () => ({ removed: ['feature/closed'], failed: [] }));
    const run = harness({ planPrune: vi.fn(async () => plan), applyPrune });
    expect(await runWorktreePrune({}, run.deps)).toBe(0);
    expect(applyPrune).not.toHaveBeenCalled();
    expect(run.log.mock.calls.flat().join('\n')).toContain('Dry run');
    expect(run.log.mock.calls.flat().join('\n')).toContain('feature/closed');
  });

  it('accepts explicit --dry-run and rejects combining it with --yes', async () => {
    const plan = [{ branch: 'feature/closed', path: '/worktrees/closed', worktreeId: 'wt-closed' }];
    const applyPrune = vi.fn(async () => ({ removed: [], failed: [] }));
    const run = harness({ planPrune: vi.fn(async () => plan), applyPrune });
    expect(await runWorktreePrune({ dryRun: true }, run.deps)).toBe(0);
    expect(applyPrune).not.toHaveBeenCalled();
    expect(await runWorktreePrune({ dryRun: true, yes: true }, run.deps)).toBe(1);
    expect(run.error.mock.calls.flat().join('\n')).toContain('--dry-run');
  });

  it('applies exactly the displayed prune plan with --yes and reports failures', async () => {
    const plan = [
      { branch: 'feature/a', path: '/worktrees/a', worktreeId: 'wt-a' },
      { branch: 'feature/b', path: '/worktrees/b', worktreeId: 'wt-b' },
    ];
    const applyPrune = vi.fn(async () => ({
      removed: ['feature/a'],
      failed: [{ branch: 'feature/b', error: 'dirty' }],
    }));
    const run = harness({ planPrune: vi.fn(async () => plan), applyPrune });
    expect(await runWorktreePrune({ yes: true }, run.deps)).toBe(1);
    expect(applyPrune).toHaveBeenCalledWith(run.context, plan);
    expect(run.error.mock.calls.flat().join('\n')).toContain('feature/b: dirty');
  });
});
