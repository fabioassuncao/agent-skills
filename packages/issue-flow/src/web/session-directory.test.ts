import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialSnapshot } from '../core/session-state.js';
import type { PlanRepositoryContext } from '../storage/db/repository.js';
import { recordAgentEvent, touchStoredSession } from '../storage/db/repository.js';
import { SqliteSessionPublisher } from '../storage/db/session-publisher.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import {
  DEFAULT_STALE_AFTER_MS,
  type SessionDirectoryChange,
  type SessionDirectoryHandle,
  watchSessionDirectory,
} from './session-directory.js';

describe('web/session-directory', () => {
  let home: string;
  const handles: SessionDirectoryHandle[] = [];
  const publishers: SqliteSessionPublisher[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-session-directory-'));
  });

  afterEach(async () => {
    for (const handle of handles.splice(0)) handle.close();
    for (const publisher of publishers.splice(0)) await publisher.close();
    await rm(home, { recursive: true, force: true });
  });

  function context(projectId: string, issueId: string): PlanRepositoryContext {
    return {
      tasksPath: join(home, 'projects', projectId, 'issues', issueId, 'tasks.json'),
      projectId,
      issueId,
      projectRoot: `/projects/${projectId}`,
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
  }

  function publishSession(projectId = 'proj-a', issueId = '42', sessionId = 'sess-a') {
    const publisher = new SqliteSessionPublisher(context(projectId, issueId), { onWarn: () => {} });
    publishers.push(publisher);
    const at = new Date().toISOString();
    publisher.publish({
      type: 'session:start',
      at,
      sessionId,
      issueNumber: Number(issueId),
      phases: ['execute'],
    });
    publisher.publish({ type: 'phase:start', at, phase: 'execute' });
    return publisher;
  }

  function watch(overrides: Partial<Parameters<typeof watchSessionDirectory>[0]> = {}) {
    const handle = watchSessionDirectory({
      env: { [GLOBAL_ROOT_ENV]: home },
      pollIntervalMs: 10,
      ...overrides,
    });
    handles.push(handle);
    return handle;
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('waitFor: condition never became true');
  }

  it('reports no sessions before SQLite has any snapshots', async () => {
    const handle = watch();
    await handle.refresh();
    expect(handle.sessions()).toEqual([]);
  });

  it('keeps the three-heartbeat staleness window', () => {
    expect(DEFAULT_STALE_AFTER_MS).toBe(90_000);
  });

  it('discovers indexed sessions across projects without traversing projections', async () => {
    const a = publishSession('proj-a', '1', 'sess-a');
    const b = publishSession('proj-b', '2', 'sess-b');
    await Promise.all([a.flush(), b.flush()]);
    const handle = watch();

    await waitFor(() => handle.sessions().length === 2);
    expect(
      handle
        .sessions()
        .map((session) => session.snapshot.sessionId)
        .sort(),
    ).toEqual(['sess-a', 'sess-b']);
    expect(handle.getSession('sess-a')).toMatchObject({ projectId: 'proj-a', issueId: '1' });
  });

  it('returns the ordered SQLite event stream for an active session', async () => {
    const publisher = publishSession();
    await publisher.flush();
    const handle = watch();

    await waitFor(() => handle.sessions().length === 1);
    expect(await handle.events('sess-a')).toMatchObject([
      { seq: 1, event: { type: 'session:start' } },
      { seq: 2, event: { type: 'phase:start' } },
    ]);
    expect(await handle.events('missing')).toBeUndefined();
  });

  it('expires sessions after their database heartbeat stops', async () => {
    const publisher = publishSession();
    await publisher.close();
    const handle = watch({ pollIntervalMs: 60_000 });
    await waitFor(() => handle.sessions().length === 1);

    // Advance only the query clock. All persisted snapshots must age together;
    // a 30 ms real-time window can expire before the first scan on loaded CI.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + DEFAULT_STALE_AFTER_MS * 2);
    try {
      await handle.refresh();
      expect(handle.sessions()).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }

    await touchStoredSession(context('proj-a', '42'), 'sess-a');
    await handle.refresh();
    expect(handle.sessions()).toHaveLength(1);
  });

  describe('push notifications (absorption phase 1)', () => {
    it('reports added, updated and removed sessions with a monotonic revision', async () => {
      const handle = watch({ pollIntervalMs: 60_000, watch: false });
      const changes: SessionDirectoryChange[] = [];
      handle.subscribe((change) => changes.push(change));

      const publisher = publishSession('proj-a', '1', 'sess-a');
      await publisher.flush();
      await handle.refresh();
      expect(changes.at(-1)).toMatchObject({ added: ['sess-a'], updated: [], removed: [] });
      expect(changes.at(-1)?.revision).toBe(1);

      publisher.publish({ type: 'phase:end', at: new Date().toISOString(), phase: 'execute' });
      await publisher.flush();
      await handle.refresh();
      expect(changes.at(-1)).toMatchObject({ added: [], updated: ['sess-a'], removed: [] });
      expect(changes.at(-1)?.revision).toBe(2);

      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + DEFAULT_STALE_AFTER_MS * 2);
      try {
        await handle.refresh();
      } finally {
        clock.mockRestore();
      }
      expect(changes.at(-1)).toMatchObject({ added: [], updated: [], removed: ['sess-a'] });
      expect(changes.at(-1)?.revision).toBe(3);
    });

    it('stays silent when a scan finds the same content, so a heartbeat is not a change', async () => {
      const publisher = publishSession();
      await publisher.flush();
      const handle = watch({ pollIntervalMs: 60_000, watch: false });
      await handle.refresh();

      const changes: SessionDirectoryChange[] = [];
      handle.subscribe((change) => changes.push(change));
      await touchStoredSession(context('proj-a', '42'), 'sess-a');
      await handle.refresh();
      await handle.refresh();

      expect(changes).toEqual([]);
      expect(handle.revision()).toBe(1);
    });

    it('isolates a throwing subscriber so it cannot take the monitor down', async () => {
      const handle = watch({ pollIntervalMs: 60_000, watch: false });
      const seen: number[] = [];
      handle.subscribe(() => {
        throw new Error('subscriber blew up');
      });
      handle.subscribe((change) => seen.push(change.revision));

      const publisher = publishSession();
      await publisher.flush();
      await expect(handle.refresh()).resolves.toBeUndefined();
      expect(seen).toEqual([1]);
    });

    it('stops delivering after unsubscribe', async () => {
      const handle = watch({ pollIntervalMs: 60_000, watch: false });
      const seen: number[] = [];
      const unsubscribe = handle.subscribe((change) => seen.push(change.revision));
      unsubscribe();

      const publisher = publishSession();
      await publisher.flush();
      await handle.refresh();
      expect(seen).toEqual([]);
    });

    // Phase 1's completion criterion (§35: output → screen ≤ 250 ms p95) rests
    // on this hop: a write by the pipeline process must reach the monitor
    // without waiting for an interval. The poll is pushed out of reach on
    // purpose — if the storage watch regressed, this test would only pass after
    // 60 s and time out instead of quietly measuring the fallback.
    it('delivers a write to subscribers without waiting for the poll interval', async () => {
      const handle = watch({ pollIntervalMs: 60_000 });
      const latencies: number[] = [];
      let resolveNext: (() => void) | null = null;
      let startedAt = 0;
      handle.subscribe(() => {
        latencies.push(Date.now() - startedAt);
        resolveNext?.();
        resolveNext = null;
      });

      for (let round = 0; round < 5; round += 1) {
        const publisher = publishSession('proj-push', String(round), `push-${round}`);
        const delivered = new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
        startedAt = Date.now();
        await publisher.flush();
        await delivered;
      }

      const median = [...latencies].sort((a, b) => a - b)[2] ?? Number.POSITIVE_INFINITY;
      expect(latencies).toHaveLength(5);
      expect(median).toBeLessThanOrEqual(250);
    });
  });

  it('reads back the agent lifecycle history a hook reported for a session', async () => {
    const publisher = publishSession();
    await publisher.flush();
    await recordAgentEvent(context('proj-a', '42'), {
      runId: 'sess-a',
      phase: 'execute',
      type: 'agent_status_changed',
      lifecycle: 'idle',
      payload: { runId: 'sess-a', phase: 'execute', type: 'agent_status_changed' },
      occurredAt: '2026-09-06T10:00:00.000Z',
    });
    const handle = watch({ pollIntervalMs: 60_000, watch: false });
    await handle.refresh();

    await expect(handle.agentEvents('sess-a')).resolves.toMatchObject([
      { runId: 'sess-a', phase: 'execute', type: 'agent_status_changed', lifecycle: 'idle' },
    ]);
    await expect(handle.agentEvents('missing')).resolves.toBeUndefined();
  });

  it('reads compatibility sessions and journals without SQLite in JSON mode', async () => {
    const issueDir = join(home, 'projects', 'json-project', 'issues', '42');
    await mkdir(issueDir, { recursive: true });
    const now = new Date().toISOString();
    await writeFile(
      join(issueDir, 'session.json'),
      JSON.stringify({
        ...createInitialSnapshot(),
        sessionId: 'json-session',
        status: 'running',
        updatedAt: now,
        issue: { ...createInitialSnapshot().issue, number: 42 },
      }),
    );
    await writeFile(
      join(issueDir, 'events.jsonl'),
      `${JSON.stringify({ seq: 1, event: { type: 'phase:start', at: now, phase: 'execute' } })}\n`,
    );
    const handle = watch({ storageDriver: 'json' });

    await handle.refresh();
    expect(handle.getSession('json-session')).toMatchObject({
      projectId: 'json-project',
      issueId: '42',
    });
    await expect(handle.events('json-session')).resolves.toMatchObject([
      { seq: 1, event: { type: 'phase:start', phase: 'execute' } },
    ]);
    expect(existsSync(join(home, 'issue-flow.db'))).toBe(false);
  });
});
