import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from './shell.js';

vi.mock('./shell.js', () => ({ run: vi.fn() }));

const { run } = await import('./shell.js');
const { getBaseBranch, getCommitsSince } = await import('./git.js');

const mockRun = vi.mocked(run);

function result(overrides?: Partial<ExecResult>): ExecResult {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides };
}

beforeEach(() => {
  mockRun.mockReset();
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
