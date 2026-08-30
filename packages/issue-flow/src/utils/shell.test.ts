import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedBackoffPolicy } from '../resilience/retry.js';

vi.mock('execa', () => ({ execa: vi.fn() }));

// The backoff is the real curve; only the wait is faked, so a test asserting
// the delays stays honest without sleeping for them.
vi.mock('../resilience/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resilience/policy.js')>();
  return { ...actual, abortableDelay: vi.fn(async () => true) };
});

const { execa } = await import('execa');
const { abortableDelay } = await import('../resilience/policy.js');
const { isRetryableInvocation, run } = await import('./shell.js');

const mockExeca = vi.mocked(execa);
const mockDelay = vi.mocked(abortableDelay);

/** An execa result, in the shape execa returns it under `reject: false`. */
function execaResult(overrides: Record<string, unknown> = {}) {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides } as unknown as ReturnType<
    typeof execa
  >;
}

/** A network failure as execa reports one: no exit code, errno on `code`. */
function spawnFailure(code: string) {
  return execaResult({
    exitCode: undefined,
    stdout: '',
    stderr: '',
    code,
    failed: true,
    originalMessage: `spawn ${code}`,
  });
}

// A fast, un-jittered policy: three attempts, a 1s base. The delays are
// asserted in ms, so the curve is the assertion rather than the wall clock.
const policy = fixedBackoffPolicy(3, 1, 60);

beforeEach(() => {
  mockExeca.mockReset();
  mockDelay.mockClear();
  mockDelay.mockImplementation(async () => true);
});

describe('run — without a retry policy', () => {
  it('runs the command exactly once, with reject: false', async () => {
    mockExeca.mockResolvedValueOnce(execaResult({ stdout: 'out\n', stderr: 'err' }));

    await expect(run('git', ['status'])).resolves.toEqual({
      stdout: 'out\n',
      stderr: 'err',
      exitCode: 0,
    });
    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(mockExeca).toHaveBeenCalledWith('git', ['status'], { reject: false });
  });

  it('does not retry a failure, however transient it looks', async () => {
    mockExeca.mockResolvedValue(spawnFailure('ECONNRESET'));

    const result = await run('gh', ['issue', 'view', '42']);

    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
    // The three fields of every release before `retry` existed, and no more:
    // nothing downstream may start reading a classification that is not there.
    expect(Object.keys(result).sort()).toEqual(['exitCode', 'stderr', 'stdout']);
  });

  it('forwards the execa options it was given', async () => {
    mockExeca.mockResolvedValueOnce(execaResult());

    await run('git', ['status'], { cwd: '/repo', timeout: 5_000 });

    expect(mockExeca).toHaveBeenCalledWith('git', ['status'], {
      reject: false,
      cwd: '/repo',
      timeout: 5_000,
    });
  });
});

describe('run — with a retry policy', () => {
  it('retries a transient failure and returns the attempt that worked', async () => {
    mockExeca
      .mockResolvedValueOnce(spawnFailure('ECONNRESET'))
      .mockResolvedValueOnce(spawnFailure('ECONNRESET'))
      .mockResolvedValueOnce(execaResult({ stdout: 'issue #42' }));

    const result = await run('gh', ['issue', 'view', '42'], { retry: policy });

    expect(mockExeca).toHaveBeenCalledTimes(3);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('issue #42');
    expect(result.attempts).toBe(3);
    expect(result.failure).toBeUndefined();
    expect(mockDelay.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
  });

  it('never passes its own options through to execa', async () => {
    mockExeca.mockResolvedValueOnce(execaResult());

    await run('git', ['fetch'], { retry: policy, source: 'github', cwd: '/repo' });

    expect(mockExeca).toHaveBeenCalledWith('git', ['fetch'], { reject: false, cwd: '/repo' });
  });

  it('gives up with the classified failure once the budget is spent', async () => {
    mockExeca.mockResolvedValue(spawnFailure('ECONNRESET'));

    const result = await run('gh', ['pr', 'create'], { retry: policy });

    expect(mockExeca).toHaveBeenCalledTimes(3);
    expect(result.failure?.kind).toBe('network');
    expect(result.attempts).toBe(3);
  });

  it('reports every attempt to onRetryAttempt, before its backoff', async () => {
    mockExeca
      .mockResolvedValueOnce(spawnFailure('EAI_AGAIN'))
      .mockResolvedValueOnce(execaResult({ stdout: 'ok' }));

    const seen: string[] = [];
    await run('gh', ['api', 'user'], {
      retry: policy,
      onRetryAttempt: (info) =>
        void seen.push(`${info.attempt}:${info.failure?.kind ?? 'ok'}:${info.delayMs}`),
    });

    expect(seen).toEqual(['1:network:1000', '2:ok:0']);
  });

  it('stops when retrySignal fires during a backoff', async () => {
    mockExeca.mockResolvedValue(spawnFailure('ECONNRESET'));
    mockDelay.mockImplementation(async () => false);

    const controller = new AbortController();
    const result = await run('gh', ['api', 'user'], {
      retry: policy,
      retrySignal: controller.signal,
    });

    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(result.failure?.kind).toBe('network');
  });

  it('does not retry a non-zero exit it cannot classify', async () => {
    // `git rev-parse --verify --quiet` answering "no such ref" is exit 1 with
    // no output: `unknown`, which is not a retryable kind.
    mockExeca.mockResolvedValue(execaResult({ exitCode: 1 }));

    const result = await run('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/x'], {
      retry: policy,
    });

    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(result.failure?.kind).toBe('unknown');
  });

  it('does not retry a failure that needs a human, whatever the policy says', async () => {
    mockExeca.mockResolvedValue(execaResult({ exitCode: 1, stderr: 'gh auth login required' }));

    const result = await run('gh', ['issue', 'view', '42'], {
      retry: { ...policy, retryForever: true },
    });

    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(result.failure?.kind).toBe('authentication');
  });
});

describe('the failure signal built from an execa result', () => {
  it.each([
    ['ENOTFOUND', 'network'],
    ['EAI_AGAIN', 'network'],
    ['ECONNRESET', 'network'],
    ['ETIMEDOUT', 'timeout'],
  ])('propagates errno %s as %s', async (errno, kind) => {
    mockExeca.mockResolvedValue(spawnFailure(errno));

    const result = await run('git', ['fetch'], { retry: { ...policy, maxAttempts: 1 } });

    expect(result.failure?.kind).toBe(kind);
  });

  it('sources a git command as git and a gh command as github', async () => {
    mockExeca.mockResolvedValue(spawnFailure('ENOTFOUND'));
    const once = { ...policy, maxAttempts: 1 };

    await expect(run('git', ['fetch'], { retry: once })).resolves.toMatchObject({
      failure: { source: 'git' },
    });
    await expect(run('/usr/local/bin/gh', ['api', 'user'], { retry: once })).resolves.toMatchObject(
      {
        failure: { source: 'github' },
      },
    );
    await expect(run('npm', ['test'], { retry: once })).resolves.toMatchObject({
      failure: { source: 'internal' },
    });
  });

  it('lets an explicit source win over the inferred one', async () => {
    mockExeca.mockResolvedValue(spawnFailure('ENOTFOUND'));

    const result = await run('git', ['fetch'], {
      retry: { ...policy, maxAttempts: 1 },
      source: 'github',
    });

    expect(result.failure?.source).toBe('github');
  });

  it('falls back to execa own message when the child wrote nothing', async () => {
    mockExeca.mockResolvedValue(
      execaResult({
        exitCode: undefined,
        stderr: '',
        failed: true,
        originalMessage: 'Command failed: connection reset by peer',
      }),
    );

    const result = await run('gh', ['api', 'user'], { retry: { ...policy, maxAttempts: 1 } });

    expect(result.failure?.kind).toBe('network');
  });

  it('reads timedOut and signal, which decide before any text does', async () => {
    mockExeca.mockResolvedValue(
      execaResult({ exitCode: undefined, timedOut: true, signal: 'SIGTERM', failed: true }),
    );

    const result = await run('gh', ['api', 'user'], { retry: { ...policy, maxAttempts: 1 } });

    expect(result.failure?.kind).toBe('timeout');
  });
});

describe('destructive git operations are never retried', () => {
  const destructive: [string, string[]][] = [
    ['push --force', ['push', '--force', 'origin', 'main']],
    ['push -f', ['push', '-f']],
    ['push --force-with-lease', ['push', '--force-with-lease']],
    ['push --delete', ['push', 'origin', '--delete', 'feature']],
    ['reset --hard', ['reset', '--hard', 'HEAD~1']],
    ['clean -fd', ['clean', '-fd']],
    ['checkout --force', ['checkout', '--force', 'main']],
    ['branch -D', ['branch', '-D', 'feature']],
    ['rebase', ['rebase', 'origin/main']],
    ['cherry-pick', ['cherry-pick', 'abc123']],
    ['merge', ['merge', 'origin/main']],
    ['restore', ['restore', '.']],
    ['stash drop', ['stash', 'drop']],
    ['update-ref', ['update-ref', '-d', 'refs/heads/x']],
    // The global options must not hide the subcommand from the guard.
    ['-C <dir> push --force', ['-C', '/repo', 'push', '--force']],
  ];

  it.each(destructive)('runs %s exactly once, even under retryForever', async (_name, args) => {
    mockExeca.mockResolvedValue(spawnFailure('ECONNRESET'));

    await run('git', args, { retry: { ...policy, retryForever: true } });

    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(mockDelay).not.toHaveBeenCalled();
  });

  it('still retries the read-only and additive git commands', async () => {
    mockExeca
      .mockResolvedValueOnce(spawnFailure('ECONNRESET'))
      .mockResolvedValueOnce(execaResult({ stdout: 'done' }));

    const result = await run('git', ['push', 'origin', 'feature'], { retry: policy });

    expect(mockExeca).toHaveBeenCalledTimes(2);
    expect(result.stdout).toBe('done');
  });

  it('classifies invocations without running anything', () => {
    expect(isRetryableInvocation('git', ['fetch', '--all'])).toBe(true);
    expect(isRetryableInvocation('git', ['status', '--porcelain'])).toBe(true);
    expect(isRetryableInvocation('git', ['push', 'origin', 'HEAD'])).toBe(true);
    expect(isRetryableInvocation('git', ['reset', '--soft', 'HEAD~1'])).toBe(true);
    expect(isRetryableInvocation('git', ['reset', '--hard'])).toBe(false);
    expect(isRetryableInvocation('git', ['worktree', 'remove', 'wt'])).toBe(false);
    // The guard is about git only; gh has no destructive verb of this shape.
    expect(isRetryableInvocation('gh', ['pr', 'create'])).toBe(true);
  });
});
