import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInitialSnapshot, type SessionSnapshot } from '../core/session-state.js';
import { type SessionDirectoryHandle, watchSessionDirectory } from './session-directory.js';

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { ...createInitialSnapshot(), sessionId: 'session-1', status: 'running', ...overrides };
}

describe('web/session-directory', () => {
  let home: string;
  const handles: SessionDirectoryHandle[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-session-dir-'));
  });

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      handle.close();
    }
    await rm(home, { recursive: true, force: true });
  });

  async function writeSession(
    projectId: string,
    issueNumber: string,
    snapshot: SessionSnapshot,
  ): Promise<string> {
    const dir = join(home, 'projects', projectId, 'issues', issueNumber);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'session.json');
    await writeFile(file, JSON.stringify(snapshot), 'utf-8');
    return file;
  }

  function watch(overrides: Partial<Parameters<typeof watchSessionDirectory>[0]> = {}) {
    const handle = watchSessionDirectory({
      env: { ISSUE_FLOW_HOME: home },
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

  it('reports no sessions before anything has been written', async () => {
    const handle = watch();
    await handle.refresh();
    expect(handle.sessions()).toEqual([]);
  });

  it('discovers a valid session.json under projects/<id>/issues/<n>/', async () => {
    await writeSession('proj-a', '42', makeSnapshot({ sessionId: 'sess-a' }));
    const handle = watch();

    await waitFor(() => handle.sessions().length === 1);
    expect(handle.getSession('sess-a')?.snapshot.sessionId).toBe('sess-a');
  });

  it('reflects multiple sessions across different projects and issues simultaneously', async () => {
    await writeSession('proj-a', '1', makeSnapshot({ sessionId: 'sess-a' }));
    await writeSession('proj-b', '2', makeSnapshot({ sessionId: 'sess-b' }));
    const handle = watch();

    await waitFor(() => handle.sessions().length === 2);
    const ids = handle
      .sessions()
      .map((s) => s.snapshot.sessionId)
      .sort();
    expect(ids).toEqual(['sess-a', 'sess-b']);
  });

  it('ignores a corrupted session.json instead of crashing the scan', async () => {
    const dir = join(home, 'projects', 'proj-a', 'issues', '1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session.json'), 'not json', 'utf-8');
    await writeSession('proj-b', '2', makeSnapshot({ sessionId: 'sess-b' }));

    const handle = watch();
    await waitFor(() => handle.sessions().length === 1);
    expect(handle.sessions()[0]?.snapshot.sessionId).toBe('sess-b');
  });

  it('ignores a session.json that fails schema validation', async () => {
    const dir = join(home, 'projects', 'proj-a', 'issues', '1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session.json'), JSON.stringify({ not: 'a snapshot' }), 'utf-8');

    const handle = watch();
    await handle.refresh();
    expect(handle.sessions()).toEqual([]);
  });

  it('stops reporting a session once its file goes stale', async () => {
    await writeSession('proj-a', '1', makeSnapshot({ sessionId: 'sess-a' }));
    const handle = watch({ staleAfterMs: 30 });

    await waitFor(() => handle.sessions().length === 1);
    await waitFor(() => handle.sessions().length === 0, 2000);
  });

  it('picks a session back up when its file is updated again after going stale', async () => {
    const file = await writeSession('proj-a', '1', makeSnapshot({ sessionId: 'sess-a' }));
    const handle = watch({ staleAfterMs: 30 });

    await waitFor(() => handle.sessions().length === 1);
    await waitFor(() => handle.sessions().length === 0);

    await writeFile(file, JSON.stringify(makeSnapshot({ sessionId: 'sess-a' })), 'utf-8');
    await waitFor(() => handle.sessions().length === 1);
  });

  it('close() stops polling: sessions() keeps its last value instead of updating', async () => {
    await writeSession('proj-a', '1', makeSnapshot({ sessionId: 'sess-a' }));
    const handle = watch();
    await waitFor(() => handle.sessions().length === 1);

    handle.close();
    await writeSession('proj-b', '2', makeSnapshot({ sessionId: 'sess-b' }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(handle.sessions()).toHaveLength(1);
  });

  it('tolerates a missing projects/ directory (no --web run has ever happened)', async () => {
    const handle = watchSessionDirectory({
      env: { ISSUE_FLOW_HOME: join(home, 'does-not-exist') },
      pollIntervalMs: 10,
    });
    handles.push(handle);
    await handle.refresh();
    expect(handle.sessions()).toEqual([]);
  });
});
