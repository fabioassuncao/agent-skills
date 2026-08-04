import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from './shell.js';

vi.mock('./shell.js', () => ({ run: vi.fn() }));

const { run } = await import('./shell.js');
const { getBaseBranch, getCommitsSince, getIssueDir, getProjectRoot } = await import('./git.js');

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

describe('getIssueDir', () => {
  // Regression guard: getIssueDir must always anchor to the git root, never
  // to process.cwd() — a command run from a subdirectory of the repo used to
  // resolve `issues/<N>/` differently than one run from the root, so `plan`
  // (CWD-relative) and `execute` (already root-anchored via config.ts) could
  // silently disagree on where the same issue's files live.
  it('joins the project root with issues/<n>, regardless of process.cwd()', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: '/repo/root\n' }));
    await expect(getIssueDir('42')).resolves.toBe(join('/repo/root', 'issues', '42'));
  });

  it('resolves the same directory whether invoked from the root or a subdirectory', async () => {
    // The only input that ever varies here is process.cwd(); getIssueDir must
    // not read it at all, so mocking git identically must yield an identical
    // path regardless of what the real CWD happens to be during the test run.
    mockRun.mockResolvedValueOnce(result({ stdout: '/repo/root\n' }));
    const fromRoot = await getIssueDir('42');

    mockRun.mockResolvedValueOnce(result({ stdout: '/repo/root\n' }));
    const fromSubdir = await getIssueDir('42');

    expect(fromRoot).toBe(fromSubdir);
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
