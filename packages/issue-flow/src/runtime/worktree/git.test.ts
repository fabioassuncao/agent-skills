import { describe, expect, it } from 'vitest';
import {
  filterLiveWorktreeEntries,
  type GitCommandResult,
  type GitWorktreeEntry,
  parseGitWorktreePorcelain,
  removeGitWorktree,
  worktreeAddArgs,
} from './git.js';

/**
 * Ported from WebMux `backend/src/__tests__/git-adapter.test.ts` @ d8c9d5f —
 * the cases that do not need a real repository. The ones that do are in
 * `lifecycle.integration.test.ts`, because a test that shells out to git
 * belongs in the integration configuration, never in the default suite.
 */
describe('parseGitWorktreePorcelain', () => {
  it('parses branch and detached entries', () => {
    const output = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo__worktrees/feature',
      'HEAD def456',
      'detached',
      '',
    ].join('\n');

    expect(parseGitWorktreePorcelain(output)).toEqual([
      { path: '/repo', head: 'abc123', branch: 'main', detached: false, bare: false },
      {
        path: '/repo__worktrees/feature',
        head: 'def456',
        branch: null,
        detached: true,
        bare: false,
      },
    ]);
  });

  // The last stanza has no blank line after it, so a parser that only flushes
  // on the separator silently drops the final worktree.
  it('keeps the trailing entry, which has no terminating blank line', () => {
    const output = ['worktree /repo', 'HEAD abc123', 'branch refs/heads/main'].join('\n');
    expect(parseGitWorktreePorcelain(output)).toHaveLength(1);
  });

  it('recognises a bare repository and strips the refs/heads prefix', () => {
    const output = [
      'worktree /repo.git',
      'bare',
      '',
      'worktree /wt',
      'branch refs/heads/a/b',
      '',
    ].join('\n');
    expect(parseGitWorktreePorcelain(output)).toEqual([
      { path: '/repo.git', head: null, branch: null, detached: false, bare: true },
      { path: '/wt', head: null, branch: 'a/b', detached: false, bare: false },
    ]);
  });

  it('ignores stray lines that belong to no worktree', () => {
    expect(parseGitWorktreePorcelain('branch refs/heads/orphan\n')).toEqual([]);
    expect(parseGitWorktreePorcelain('')).toEqual([]);
  });
});

describe('filterLiveWorktreeEntries', () => {
  function entry(path: string): GitWorktreeEntry {
    return { path, branch: null, head: null, detached: false, bare: false };
  }

  // git keeps the administrative record of a worktree whose directory was
  // deleted by hand until someone prunes it, so `worktree list` is not the same
  // question as "which worktrees exist".
  it('drops entries whose directory is gone and keeps the rest', async () => {
    const live = entry(process.cwd());
    const stale = entry('/definitely/not/a/directory/anywhere');
    await expect(filterLiveWorktreeEntries([live, stale])).resolves.toEqual([live]);
  });
});

describe('worktreeAddArgs', () => {
  it('creates a new branch from a base', () => {
    expect(
      worktreeAddArgs({
        mode: 'new',
        repoRoot: '/repo',
        worktreePath: '/wt/feature',
        branch: 'feature',
        baseBranch: 'main',
      }),
    ).toEqual(['worktree', 'add', '-b', 'feature', '/wt/feature', 'main']);
  });

  it('omits the base when none was given', () => {
    expect(
      worktreeAddArgs({
        mode: 'new',
        repoRoot: '/repo',
        worktreePath: '/wt/feature',
        branch: 'feature',
      }),
    ).toEqual(['worktree', 'add', '-b', 'feature', '/wt/feature']);
  });

  it('checks out an existing local branch', () => {
    expect(
      worktreeAddArgs({
        mode: 'existing',
        repoRoot: '/repo',
        worktreePath: '/wt/feature',
        branch: 'feature',
      }),
    ).toEqual(['worktree', 'add', '/wt/feature', 'feature']);
  });

  // A branch that exists only on the remote has to be created locally from it,
  // which is a different argv — not the same command with an extra flag.
  it('creates a local branch from a remote start point', () => {
    expect(
      worktreeAddArgs({
        mode: 'existing',
        repoRoot: '/repo',
        worktreePath: '/wt/feature',
        branch: 'feature',
        startPoint: 'origin/feature',
      }),
    ).toEqual(['worktree', 'add', '-b', 'feature', '/wt/feature', 'origin/feature']);
  });
});

describe('removeGitWorktree', () => {
  const failing = async (): Promise<GitCommandResult> => ({ ok: false, stderr: 'not a worktree' });

  it('cleans up the leftover directory when git already unregistered the worktree', async () => {
    const removed: string[] = [];
    await removeGitWorktree(
      { repoRoot: '/repo', worktreePath: '/wt/feature' },
      {
        tryGit: failing,
        listWorktrees: async () => [
          { path: '/repo', branch: 'main', head: null, detached: false, bare: false },
        ],
        removeDirectory: async (path) => {
          removed.push(path);
        },
      },
    );
    expect(removed).toEqual(['/wt/feature']);
  });

  // Deleting a directory git still considers a live worktree would corrupt its
  // view of the repository, so the fallback only runs once git says otherwise.
  it('surfaces the git error when the worktree is still registered', async () => {
    const removed: string[] = [];
    await expect(
      removeGitWorktree(
        { repoRoot: '/repo', worktreePath: '/wt/feature' },
        {
          tryGit: failing,
          listWorktrees: async () => [
            { path: '/wt/feature', branch: 'feature', head: null, detached: false, bare: false },
          ],
          removeDirectory: async (path) => {
            removed.push(path);
          },
        },
      ),
    ).rejects.toThrow('not a worktree');
    expect(removed).toEqual([]);
  });

  it('reports a cleanup failure alongside the original git error', async () => {
    await expect(
      removeGitWorktree(
        { repoRoot: '/repo', worktreePath: '/wt/feature' },
        {
          tryGit: failing,
          listWorktrees: async () => [],
          removeDirectory: async () => {
            throw new Error('permission denied');
          },
        },
      ),
    ).rejects.toThrow(/not a worktree; cleanup failed: permission denied/);
  });

  it('passes --force through when asked', async () => {
    const seen: string[][] = [];
    await removeGitWorktree(
      { repoRoot: '/repo', worktreePath: '/wt/feature', force: true },
      {
        tryGit: async (args) => {
          seen.push(args);
          return { ok: true, stdout: '' };
        },
      },
    );
    expect(seen).toEqual([['worktree', 'remove', '--force', '/wt/feature']]);
  });
});
