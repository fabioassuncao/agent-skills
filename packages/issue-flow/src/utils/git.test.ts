import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from './shell.js';

vi.mock('./shell.js', () => ({ run: vi.fn() }));

const { run } = await import('./shell.js');
const { getBaseBranch, getCommitsSince, getProjectRoot, getRemoteUrl, normalizeRemoteUrl } =
  await import('./git.js');

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
    });
  });

  it('queries the given cwd instead of process.cwd()', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'git@github.com:org/repo.git\n' }));
    await expect(getRemoteUrl('/some/project/root')).resolves.toBe('git@github.com:org/repo.git');
    expect(mockRun).toHaveBeenCalledWith('git', ['remote', 'get-url', 'origin'], {
      cwd: '/some/project/root',
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

describe('getCommitsSince', () => {
  it('parses tab-separated hash and subject, preserving tabs in subjects', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'abc1234\tfeat: first\ndef5678\tfix: a\tb' }));
    await expect(getCommitsSince('main')).resolves.toEqual([
      { hash: 'abc1234', subject: 'feat: first' },
      { hash: 'def5678', subject: 'fix: a\tb' },
    ]);
    expect(mockRun).toHaveBeenCalledWith('git', ['log', '--pretty=format:%h%x09%s', 'main..HEAD']);
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
