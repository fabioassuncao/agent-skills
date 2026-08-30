import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the waiting is faked: the attempt budget and the computed delay stay
// real, so the historical 15s -> 120s curve is assertable in milliseconds.
vi.mock('../resilience/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resilience/policy.js')>();
  return { ...actual, abortableDelay: vi.fn(async () => true) };
});

// The logger prints straight to the terminal otherwise.
vi.mock('../ui/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/logger.js')>();
  return { ...actual, printRetry: vi.fn(() => {}) };
});

const { readFileWithGrace, runPhaseWithRetry } = await import('./phase-runner.js');
const { setSessionPublisher } = await import('./session-publisher.js');
const { MemoryPublisher } = await import('./session-state.js');
type SessionEvent = import('./session-state.js').SessionEvent;
type RetryEvent = Extract<SessionEvent, { type: 'retry' }>;

class RecordingPublisher extends MemoryPublisher {
  readonly events: SessionEvent[] = [];

  protected override afterPublish(event: SessionEvent): void {
    this.events.push(event);
  }
}

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

  describe('the retry event', () => {
    let publisher: RecordingPublisher;

    beforeEach(() => {
      publisher = new RecordingPublisher({ onWarn: () => {} });
      setSessionPublisher(publisher);
    });

    afterEach(() => {
      setSessionPublisher(undefined);
    });

    function retryEvents(): RetryEvent[] {
      return publisher.events.filter((e): e is RetryEvent => e.type === 'retry');
    }

    it("keeps the phases' historical budget with no options: 3 attempts, 15s then 30s", async () => {
      const attempt = vi.fn().mockResolvedValue({
        ok: false,
        transient: true,
        error: 'Claude invocation timed out after 900s',
      });

      await runPhaseWithRetry({ phase: 'prd', attempt });

      expect(attempt).toHaveBeenCalledTimes(3);
      expect(retryEvents().map((e) => [e.attempt, e.delaySeconds, e.kind])).toEqual([
        [1, 15, 'timeout'],
        [2, 30, 'timeout'],
      ]);
    });

    it('names the kind of a failure only the phase itself could see', async () => {
      const attempt = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, transient: true, error: 'PRD file was not created' })
        .mockResolvedValueOnce({ ok: true });

      await runPhaseWithRetry({ phase: 'prd', attempt });

      // The text says nothing a classifier can use, so the kind falls through
      // to `unknown` — and the phase's own `transient` is what retried it.
      expect(retryEvents()).toHaveLength(1);
      expect(retryEvents()[0].kind).toBe('unknown');
    });

    it("never retries the agent's own work, whatever the phase claims", async () => {
      const attempt = vi
        .fn()
        .mockResolvedValue({ ok: false, transient: true, error: 'Tests  3 failed | 41 passed' });

      const result = await runPhaseWithRetry({ phase: 'prd', attempt });

      expect(attempt).toHaveBeenCalledTimes(1);
      expect(retryEvents()).toHaveLength(0);
      expect(result.ok).toBe(false);
    });
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
