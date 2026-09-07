import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from './shell.js';

vi.mock('./shell.js', () => ({ run: vi.fn() }));

const { run } = await import('./shell.js');
const {
  describePreflight,
  preflightRepository,
  getBaseBranch,
  getCommitsSince,
  getHeadCommit,
  getProjectRoot,
  getRemoteUrl,
  normalizeRemoteUrl,
  stripRemoteUrlCredentials,
} = await import('./git.js');

const mockRun = vi.mocked(run);

function result(overrides?: Partial<ExecResult>): ExecResult {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides };
}

beforeEach(() => {
  mockRun.mockReset();
});

describe('getProjectRoot', () => {
  it('trims the output of git rev-parse --show-toplevel', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: '/repo/root\n' }));
    await expect(getProjectRoot()).resolves.toBe('/repo/root');
    expect(mockRun).toHaveBeenCalledWith('git', ['rev-parse', '--show-toplevel']);
  });

  it('throws a clear error when not inside a git repository', async () => {
    mockRun.mockResolvedValueOnce(result({ exitCode: 128 }));
    await expect(getProjectRoot()).rejects.toThrow('Not inside a git repository');
  });
});

describe('getBaseBranch', () => {
  it('uses origin/HEAD when available, stripping the origin/ prefix', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'origin/main\n' }));
    await expect(getBaseBranch()).resolves.toBe('main');
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('falls back to the first existing local branch (main, then master)', async () => {
    mockRun.mockResolvedValueOnce(result({ exitCode: 1 })); // symbolic-ref fails
    mockRun.mockResolvedValueOnce(result({ exitCode: 1 })); // no refs/heads/main
    mockRun.mockResolvedValueOnce(result({ stdout: 'deadbeef\n' })); // master exists
    await expect(getBaseBranch()).resolves.toBe('master');
  });

  it('defaults to main when nothing can be resolved', async () => {
    mockRun.mockResolvedValue(result({ exitCode: 1 }));
    await expect(getBaseBranch()).resolves.toBe('main');
  });
});

describe('getRemoteUrl', () => {
  it('returns the trimmed url of origin', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'git@github.com:org/repo.git\n' }));
    await expect(getRemoteUrl()).resolves.toBe('git@github.com:org/repo.git');
    expect(mockRun).toHaveBeenCalledWith('git', ['remote', 'get-url', 'origin'], {
      cwd: undefined,
      diagnostics: false,
    });
  });

  it('queries the given cwd instead of process.cwd()', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'git@github.com:org/repo.git\n' }));
    await expect(getRemoteUrl('/some/project/root')).resolves.toBe('git@github.com:org/repo.git');
    expect(mockRun).toHaveBeenCalledWith('git', ['remote', 'get-url', 'origin'], {
      cwd: '/some/project/root',
      diagnostics: false,
    });
  });

  it('returns null when origin is not configured (non-zero exit)', async () => {
    mockRun.mockResolvedValueOnce(
      result({ exitCode: 2, stderr: "error: No such remote 'origin'" }),
    );
    await expect(getRemoteUrl()).resolves.toBeNull();
  });

  it('returns null when stdout is empty or blank', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: '   \n' }));
    await expect(getRemoteUrl()).resolves.toBeNull();
  });

  it('returns null instead of throwing when git cannot be spawned', async () => {
    mockRun.mockRejectedValueOnce(new Error('spawn git ENOENT'));
    await expect(getRemoteUrl()).resolves.toBeNull();
  });
});

describe('getHeadCommit', () => {
  it('returns the trimmed abbreviated hash of HEAD', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'c56b163\n' }));
    await expect(getHeadCommit()).resolves.toBe('c56b163');
    expect(mockRun).toHaveBeenCalledWith('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: undefined,
      diagnostics: false,
    });
  });

  it('queries the given cwd instead of process.cwd()', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'c56b163\n' }));
    await expect(getHeadCommit('/some/project/root')).resolves.toBe('c56b163');
    expect(mockRun).toHaveBeenCalledWith('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: '/some/project/root',
      diagnostics: false,
    });
  });

  it('returns null in a repository with no commits yet (non-zero exit)', async () => {
    mockRun.mockResolvedValueOnce(
      result({ exitCode: 128, stderr: "fatal: ambiguous argument 'HEAD'" }),
    );
    await expect(getHeadCommit()).resolves.toBeNull();
  });

  it('returns null when stdout is empty or blank', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: '  \n' }));
    await expect(getHeadCommit()).resolves.toBeNull();
  });

  it('returns null instead of throwing when git cannot be spawned', async () => {
    mockRun.mockRejectedValueOnce(new Error('spawn git ENOENT'));
    await expect(getHeadCommit()).resolves.toBeNull();
  });
});

describe('normalizeRemoteUrl', () => {
  // The whole point of normalization is that every way of addressing one
  // repository collapses to a single identity — this table is the contract.
  it.each([
    ['https://github.com/org/repo.git', 'github.com/org/repo'],
    ['git@github.com:org/repo.git', 'github.com/org/repo'],
    ['ssh://git@github.com:22/org/repo.git', 'github.com/org/repo'],
    ['https://user:token@github.com/org/repo', 'github.com/org/repo'],
    ['https://github.com/Org/Repo/', 'github.com/org/repo'],
    ['https://github.com/org/repo', 'github.com/org/repo'],
    ['ssh://git@github.com/org/repo.git', 'github.com/org/repo'],
    ['git://github.com/org/repo.git', 'github.com/org/repo'],
    ['GIT@GitHub.com:Org/Repo.GIT', 'github.com/org/repo'],
    ['https://gitlab.com/group/sub/repo.git', 'gitlab.com/group/sub/repo'],
    ['  https://github.com/org/repo.git  ', 'github.com/org/repo'],
    ['https://github.com//org//repo.git//', 'github.com/org/repo'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeRemoteUrl(input)).toBe(expected);
  });

  it('produces the same identity for the https and ssh forms of one repo', () => {
    expect(normalizeRemoteUrl('https://github.com/org/repo.git')).toBe(
      normalizeRemoteUrl('git@github.com:org/repo.git'),
    );
  });

  it.each([
    ['', 'empty string'],
    ['   ', 'blank string'],
    ['not a url', 'no scheme and no colon'],
    ['https://github.com', 'host without a path'],
    ['https://github.com/', 'host with an empty path'],
    ['git@github.com:', 'scp form with an empty path'],
    ['https:///org/repo.git', 'missing host'],
    ['https://github.com/.git', 'path that is only the .git suffix'],
  ])('returns null for %s (%s)', (input) => {
    expect(normalizeRemoteUrl(input)).toBeNull();
  });

  it('returns null for null and undefined', () => {
    expect(normalizeRemoteUrl(null)).toBeNull();
    expect(normalizeRemoteUrl(undefined)).toBeNull();
  });
});

describe('stripRemoteUrlCredentials', () => {
  it.each([
    ['https://user:token@github.com/org/repo.git', 'https://github.com/org/repo.git'],
    ['https://x-access-token:ghp_abc123@github.com/org/repo', 'https://github.com/org/repo'],
    ['https://token@github.com/org/repo.git', 'https://github.com/org/repo.git'],
    ['HTTPS://user:token@github.com/org/repo.git', 'HTTPS://github.com/org/repo.git'],
    ['http://user:token@internal.example/org/repo.git', 'http://internal.example/org/repo.git'],
  ])('strips the embedded credentials from %s', (input, expected) => {
    expect(stripRemoteUrlCredentials(input)).toBe(expected);
  });

  // SSH has no password-in-URL syntax; the user segment is a required,
  // non-secret protocol field (almost always "git") that the remote would
  // stop working without — so it must survive untouched.
  it.each([
    'https://github.com/org/repo.git',
    'https://github.com/Org/Repo/',
    'git://github.com/org/repo.git',
    'ssh://git@github.com:22/org/repo.git',
    'ssh://user:pass@github.com:22/org/repo.git',
    'git@github.com:org/repo.git',
    '/local/path/to/repo',
  ])('leaves %s unchanged', (input) => {
    expect(stripRemoteUrlCredentials(input)).toBe(input);
  });

  it('trims surrounding whitespace like normalizeRemoteUrl does', () => {
    expect(stripRemoteUrlCredentials('  https://user:token@github.com/org/repo.git  ')).toBe(
      'https://github.com/org/repo.git',
    );
  });

  it('returns null for empty, blank, null and undefined', () => {
    expect(stripRemoteUrlCredentials('')).toBeNull();
    expect(stripRemoteUrlCredentials('   ')).toBeNull();
    expect(stripRemoteUrlCredentials(null)).toBeNull();
    expect(stripRemoteUrlCredentials(undefined)).toBeNull();
  });
});

describe('getCommitsSince', () => {
  it('parses tab-separated hash and subject, preserving tabs in subjects', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'abc1234\tfeat: first\ndef5678\tfix: a\tb' }));
    await expect(getCommitsSince('main')).resolves.toEqual([
      { hash: 'abc1234', subject: 'feat: first' },
      { hash: 'def5678', subject: 'fix: a\tb' },
    ]);
    expect(mockRun).toHaveBeenCalledWith('git', [
      'log',
      '--pretty=format:%h%x09%cI%x09%s%x09%b%x1e',
      'main..HEAD',
    ]);
  });

  it('collects timestamp and story association from structured commit metadata', async () => {
    mockRun.mockResolvedValueOnce(
      result({
        stdout:
          'abc1234\t2026-08-30T10:00:00-03:00\tfeat: observability\tRefs #42\nStory: US-010\x1e',
      }),
    );
    await expect(getCommitsSince('start-sha')).resolves.toEqual([
      {
        hash: 'abc1234',
        subject: 'feat: observability',
        committedAt: '2026-08-30T10:00:00-03:00',
        storyId: 'US-010',
      },
    ]);
  });

  it('returns [] when there are no commits ahead of base', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: '' }));
    await expect(getCommitsSince('main')).resolves.toEqual([]);
  });

  it('returns [] when git fails (unknown base, shallow clone)', async () => {
    mockRun.mockResolvedValueOnce(result({ exitCode: 128, stderr: 'unknown revision' }));
    await expect(getCommitsSince('nope')).resolves.toEqual([]);
  });
});

describe('preflightRepository (US-019)', () => {
  /**
   * Answers for the read-only probes the preflight runs, keyed by the argv it
   * uses. Anything not listed answers "clean", so each test states only what
   * it is actually about.
   */
  function repository(overrides: Record<string, Partial<ExecResult>> = {}) {
    mockRun.mockImplementation(async (_command: string, args: string[] = []) => {
      const key = args.join(' ');
      const preset = overrides[key];
      if (preset !== undefined) return result(preset);

      if (args[0] === 'rev-parse') return result({ exitCode: 1 });
      if (args[0] === 'symbolic-ref') return result({ stdout: 'refs/heads/feat/63-x\n' });
      return result({ stdout: '' });
    });
  }

  /** Every git invocation the preflight made, as `git <argv>`. */
  function invocations(): string[] {
    return mockRun.mock.calls.map(([command, args]) => `${command} ${(args ?? []).join(' ')}`);
  }

  beforeEach(() => {
    mockRun.mockReset();
  });

  it('reports a clean repository as safe', async () => {
    repository();

    const preflight = await preflightRepository({ expectedBranch: 'feat/63-x' });

    expect(preflight.ok).toBe(true);
    expect(preflight.blocks).toEqual([]);
    expect(preflight.branch).toBe('feat/63-x');
    expect(preflight.dirty).toBe(false);
  });

  it.each([
    ['REBASE_HEAD', 'rebase_in_progress', 'git rebase'],
    ['MERGE_HEAD', 'merge_in_progress', 'git merge'],
    ['CHERRY_PICK_HEAD', 'cherry_pick_in_progress', 'git cherry-pick'],
    ['REVERT_HEAD', 'revert_in_progress', 'git revert'],
  ])('blocks on %s and names the way out', async (ref, kind, suggestion) => {
    repository({ [`rev-parse --verify --quiet ${ref}`]: { exitCode: 0, stdout: 'abc123' } });

    const preflight = await preflightRepository();

    expect(preflight.ok).toBe(false);
    const block = preflight.blocks.find((entry) => entry.kind === kind);
    expect(block).toBeDefined();
    expect(block?.suggestion).toContain(suggestion);
  });

  it('runs nothing destructive while blocking on a merge', async () => {
    repository({ 'rev-parse --verify --quiet MERGE_HEAD': { exitCode: 0, stdout: 'abc123' } });

    await preflightRepository({ expectedBranch: 'feat/63-x' });

    // The whole contract in one assertion: every git call is a read.
    const forbidden = [
      'merge --abort',
      'rebase --abort',
      'cherry-pick --abort',
      'reset',
      'checkout',
      'switch',
      'stash',
      'clean',
      'restore',
    ];
    for (const call of invocations()) {
      for (const verb of forbidden) {
        expect(call).not.toContain(verb);
      }
    }
    expect(invocations().every((call) => call.startsWith('git '))).toBe(true);
  });

  it('blocks on unresolved conflicts, naming the files', async () => {
    repository({ 'diff --name-only --diff-filter=U': { stdout: 'src/a.ts\nsrc/b.ts\n' } });

    const preflight = await preflightRepository();

    const block = preflight.blocks.find((entry) => entry.kind === 'unmerged_paths');
    expect(block?.message).toContain('src/a.ts');
    expect(block?.message).toContain('src/b.ts');
  });

  it('blocks on a detached HEAD', async () => {
    repository({ 'symbolic-ref -q HEAD': { exitCode: 1, stdout: '' } });

    const preflight = await preflightRepository({ expectedBranch: 'feat/63-x' });

    expect(preflight.branch).toBeNull();
    expect(preflight.blocks.some((entry) => entry.kind === 'detached_head')).toBe(true);
  });

  it('blocks when the repository is on a branch the plan does not know', async () => {
    repository({ 'symbolic-ref -q HEAD': { stdout: 'refs/heads/main\n' } });

    const preflight = await preflightRepository({ expectedBranch: 'feat/63-x' });

    const block = preflight.blocks.find((entry) => entry.kind === 'branch_mismatch');
    // Both names, because either one alone leaves the user guessing.
    expect(block?.message).toContain('feat/63-x');
    expect(block?.message).toContain('main');
  });

  it('does not check the branch when the plan has none yet', async () => {
    repository({ 'symbolic-ref -q HEAD': { stdout: 'refs/heads/main\n' } });

    const preflight = await preflightRepository({ expectedBranch: null });

    expect(preflight.blocks.some((entry) => entry.kind === 'branch_mismatch')).toBe(false);
  });

  it('tolerates a dirty tree when resuming the phase that dirtied it', async () => {
    repository({ 'status --porcelain': { stdout: ' M src/a.ts\n' } });

    const preflight = await preflightRepository({
      expectedBranch: 'feat/63-x',
      intent: 'resume-same-phase',
    });

    expect(preflight.dirty).toBe(true);
    expect(preflight.ok).toBe(true);
  });

  it('blocks on a dirty tree when moving on to something else', async () => {
    repository({ 'status --porcelain': { stdout: ' M src/a.ts\n' } });

    const preflight = await preflightRepository({
      expectedBranch: 'feat/63-x',
      intent: 'new-phase',
    });

    expect(preflight.ok).toBe(false);
    expect(preflight.blocks.some((entry) => entry.kind === 'dirty_tree')).toBe(true);
  });

  it('reports every problem at once instead of one per run', async () => {
    repository({
      'rev-parse --verify --quiet MERGE_HEAD': { exitCode: 0, stdout: 'abc' },
      'diff --name-only --diff-filter=U': { stdout: 'src/a.ts\n' },
      'symbolic-ref -q HEAD': { stdout: 'refs/heads/main\n' },
      'status --porcelain': { stdout: ' M src/a.ts\n' },
    });

    const preflight = await preflightRepository({ expectedBranch: 'feat/63-x' });

    expect(preflight.blocks.map((block) => block.kind).sort()).toEqual([
      'branch_mismatch',
      'dirty_tree',
      'merge_in_progress',
      'unmerged_paths',
    ]);
    expect(describePreflight(preflight)).toHaveLength(4);
  });
});
