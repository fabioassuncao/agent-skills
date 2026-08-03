import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileWithGrace, runPhaseWithRetry } from './phase-runner.js';

describe('runPhaseWithRetry', () => {
  it('returns immediately on the first successful attempt without retrying', async () => {
    const attempt = vi.fn().mockResolvedValue({ ok: true });

    const result = await runPhaseWithRetry({ phase: 'prd', attempt });

    expect(result.ok).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and succeeds on a later attempt', async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, transient: true, error: 'timed out' })
      .mockResolvedValueOnce({ ok: true });

    const result = await runPhaseWithRetry({
      phase: 'prd',
      attempt,
      backoffBaseSeconds: 0.01,
      backoffMaxSeconds: 0.02,
    });

    expect(result.ok).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('gives up immediately on a non-transient failure without retrying', async () => {
    const attempt = vi.fn().mockResolvedValue({ ok: false, transient: false, error: 'bad prompt' });

    const result = await runPhaseWithRetry({
      phase: 'prd',
      attempt,
      backoffBaseSeconds: 0.01,
      backoffMaxSeconds: 0.02,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('bad prompt');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('stops after exhausting the retry budget on persistent transient failures', async () => {
    const attempt = vi.fn().mockResolvedValue({ ok: false, transient: true, error: 'still down' });

    const result = await runPhaseWithRetry({
      phase: 'prd',
      attempt,
      retryLimit: 3,
      backoffBaseSeconds: 0.01,
      backoffMaxSeconds: 0.02,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('still down');
    expect(attempt).toHaveBeenCalledTimes(3);
  });
});

describe('readFileWithGrace', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('returns the content immediately when the file already exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'issue-flow-phase-runner-test-'));
    const filePath = join(dir, 'prd.md');
    await writeFile(filePath, 'hello', 'utf-8');

    await expect(readFileWithGrace(filePath, [10, 10])).resolves.toBe('hello');
  });

  it('retries after a short delay and succeeds once the file appears', async () => {
    dir = await mkdtemp(join(tmpdir(), 'issue-flow-phase-runner-test-'));
    const filePath = join(dir, 'prd.md');

    setTimeout(() => {
      void writeFile(filePath, 'delayed', 'utf-8');
    }, 15);

    await expect(readFileWithGrace(filePath, [10, 50])).resolves.toBe('delayed');
  });

  it('throws the underlying error once every grace attempt is exhausted', async () => {
    dir = await mkdtemp(join(tmpdir(), 'issue-flow-phase-runner-test-'));
    const filePath = join(dir, 'never-created.md');

    await expect(readFileWithGrace(filePath, [5, 5])).rejects.toThrow();
  });
});
