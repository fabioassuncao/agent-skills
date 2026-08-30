import { mkdtemp, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GLOBAL_ROOT_ENV, getIssuePaths } from '../../storage/paths.js';
import { FilePublisher, MemoryPublisher, NullPublisher } from '../session-state.js';

describe('NullPublisher', () => {
  it('is a no-op with version 0 and a stable empty snapshot', async () => {
    const publisher = new NullPublisher();
    publisher.publish({ type: 'log', at: '2026-08-03T12:00:00Z', level: 'info', message: 'x' });
    expect(publisher.version()).toBe(0);
    expect(publisher.snapshot().status).toBe('idle');
    expect(publisher.snapshot().logs).toEqual([]);
    await publisher.flush();
    await publisher.close();
  });
});

describe('MemoryPublisher', () => {
  it('increments version monotonically on each published event', () => {
    const publisher = new MemoryPublisher();
    expect(publisher.version()).toBe(0);
    publisher.publish({
      type: 'session:start',
      at: '2026-08-03T12:00:00Z',
      sessionId: 's',
      issueNumber: 1,
      phases: ['init'],
    });
    publisher.publish({ type: 'log', at: '2026-08-03T12:00:01Z', level: 'info', message: 'a' });
    expect(publisher.version()).toBe(2);
    expect(publisher.snapshot().status).toBe('running');
    expect(publisher.snapshot().logs).toHaveLength(1);
  });

  it('publish never throws, even when internals fail; warns only once', () => {
    const warnings: string[] = [];
    const publisher = new MemoryPublisher({ onWarn: (m) => warnings.push(m) });
    // Force an internal failure in the reducer path.
    const broken = {
      type: 'stories:update',
      at: '2026-08-03T12:00:00Z',
      stories: null,
    } as unknown as SessionEvent;
    expect(() => publisher.publish(broken)).not.toThrow();
    expect(() => publisher.publish(broken)).not.toThrow();
    expect(warnings).toHaveLength(1);
  });

  it('drops log events without bumping the version when includeLogs is false', () => {
    const publisher = new MemoryPublisher({ includeLogs: false });
    publisher.publish({
      type: 'session:start',
      at: '2026-08-03T12:00:00Z',
      sessionId: 's',
      issueNumber: 1,
      phases: ['init'],
    });
    publisher.publish({ type: 'log', at: '2026-08-03T12:00:01Z', level: 'error', message: 'x' });
    expect(publisher.version()).toBe(1);
    expect(publisher.snapshot().logs).toEqual([]);
    expect(publisher.snapshot().errors).toEqual([]);
    // Non-log events still flow normally.
    expect(publisher.snapshot().status).toBe('running');
  });
});

describe('FilePublisher', () => {
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'issue-flow-state-test-'));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('writes the snapshot to disk without leaving a temp file behind', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'session.json');
      const publisher = new FilePublisher(filePath, { throttleMs: 0, onWarn: () => {} });
      publisher.publish({
        type: 'session:start',
        at: '2026-08-03T12:00:00Z',
        sessionId: 's',
        issueNumber: 1,
        phases: ['init'],
      });
      await publisher.close();

      const written = JSON.parse(await readFile(filePath, 'utf-8')) as SessionSnapshot;
      expect(written.sessionId).toBe('s');
      expect(written.status).toBe('running');
      // Atomic write cleans up after itself: only session.json remains.
      expect(await readdir(dir)).toEqual(['session.json']);
    });
  });

  it('creates the parent directory on the first write when it does not exist yet', async () => {
    await withTempDir(async (dir) => {
      // The real destination: `run` hands the publisher `paths.sessionFile`,
      // several levels deep inside the global storage, where not even the
      // project directory has to exist yet.
      const { sessionFile } = getIssuePaths('widgets-0123456789ab', 23, {
        env: { [GLOBAL_ROOT_ENV]: dir },
      });
      const filePath = sessionFile;
      const warn = vi.fn();
      // Regression: the very first publish() used to fire before any phase
      // had a chance to mkdir the issue directory, throwing ENOENT on write.
      const publisher = new FilePublisher(filePath, { throttleMs: 0, onWarn: warn });
      publisher.publish({
        type: 'session:start',
        at: '2026-08-03T12:00:00Z',
        sessionId: 's',
        issueNumber: 23,
        phases: ['init'],
      });
      await publisher.close();

      expect(warn).not.toHaveBeenCalled();
      const written = JSON.parse(await readFile(filePath, 'utf-8')) as SessionSnapshot;
      expect(written.sessionId).toBe('s');
    });
  });

  it('touches the live file without changing content or version, then stops on close', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'session.json');
      const publisher = new FilePublisher(filePath, {
        throttleMs: 0,
        heartbeatMs: 10,
        onWarn: () => {},
      });
      publisher.publish({
        type: 'session:start',
        at: '2026-08-03T12:00:00Z',
        sessionId: 's',
        issueNumber: 1,
        phases: ['init'],
      });
      await publisher.flush();

      const content = await readFile(filePath, 'utf-8');
      const version = publisher.version();
      const old = new Date('2000-01-01T00:00:00Z');
      await utimes(filePath, old, old);

      const deadline = Date.now() + 1000;
      while ((await stat(filePath)).mtimeMs === old.getTime() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect((await stat(filePath)).mtimeMs).toBeGreaterThan(old.getTime());
      expect(await readFile(filePath, 'utf-8')).toBe(content);
      expect(publisher.version()).toBe(version);

      await publisher.close();
      await utimes(filePath, old, old);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await stat(filePath)).mtimeMs).toBe(old.getTime());
    });
  });

  it('honors includeLogs=false: published file contains no logs', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'session.json');
      const publisher = new FilePublisher(filePath, {
        throttleMs: 0,
        includeLogs: false,
        onWarn: () => {},
      });
      publisher.publish({
        type: 'session:start',
        at: '2026-08-03T12:00:00Z',
        sessionId: 's',
        issueNumber: 1,
        phases: ['init'],
      });
      publisher.publish({ type: 'log', at: '2026-08-03T12:00:01Z', level: 'info', message: 'x' });
      await publisher.close();

      const written = JSON.parse(await readFile(filePath, 'utf-8')) as SessionSnapshot;
      expect(written.logs).toEqual([]);
      expect(written.errors).toEqual([]);
      expect(written.warnings).toEqual([]);
    });
  });
});
