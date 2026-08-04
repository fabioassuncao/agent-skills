import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInitialSnapshot, type SessionSnapshot } from '../core/session-state.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { detectActiveInstance, ensureSingleWebServer, getWebLockFile } from './lock.js';
import { startWebServer, type WebServerHandle } from './server.js';
import { type SessionDirectoryHandle, watchSessionDirectory } from './session-directory.js';

const noop = (): void => {};

function makeSnapshot(sessionId: string, issueNumber: number): SessionSnapshot {
  return {
    ...createInitialSnapshot(),
    sessionId,
    status: 'running',
    issue: { ...createInitialSnapshot().issue, number: issueNumber },
  };
}

/**
 * End-to-end coverage (US-007) that ties every piece together the way
 * production code actually does: real files on disk, the real polling
 * scanner (`session-directory.ts`), the real lock (`lock.ts`) and the real
 * HTTP routes (`server.ts`) — as opposed to the focused unit tests in
 * `lock.test.ts` / `session-directory.test.ts` / `server.test.ts`, which each
 * fake the other two layers.
 */
describe('web — single instance + multi-session, end to end (US-007)', () => {
  let home: string;
  const envOptions = () => ({ env: { [GLOBAL_ROOT_ENV]: home } });
  const handles: WebServerHandle[] = [];
  const dirHandles: SessionDirectoryHandle[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-web-e2e-'));
  });

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.close()));
    for (const dir of dirHandles.splice(0)) dir.close();
    await rm(home, { recursive: true, force: true });
  });

  async function writeSession(
    projectId: string,
    issueNumber: string,
    snapshot: SessionSnapshot,
  ): Promise<void> {
    const dir = join(home, 'projects', projectId, 'issues', issueNumber);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session.json'), JSON.stringify(snapshot), 'utf-8');
  }

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('waitFor: condition never became true');
  }

  it('first invocation binds; a concurrent second invocation reuses it without an EADDRINUSE-style failure', async () => {
    const [a, b] = await Promise.all([
      ensureSingleWebServer({ port: 0, host: '127.0.0.1', info: noop, warn: noop }, envOptions()),
      ensureSingleWebServer({ port: 0, host: '127.0.0.1', info: noop, warn: noop }, envOptions()),
    ]);
    if (a) handles.push(a);
    if (b) handles.push(b);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.port).toBe(b?.port);
    // Exactly one owns a local Server; the other reused it — never two ports.
    expect([a, b].filter((h) => h?.server !== undefined)).toHaveLength(1);
  });

  it('a stale lock (dead pid) is replaced and a new instance takes over', async () => {
    const lockFile = getWebLockFile(envOptions());
    await writeFile(
      lockFile,
      JSON.stringify({
        pid: 999999999,
        port: 59999,
        host: '127.0.0.1',
        startedAt: '2020-01-01T00:00:00Z',
      }),
      'utf-8',
    );

    const handle = await ensureSingleWebServer(
      { port: 0, host: '127.0.0.1', info: noop, warn: noop },
      envOptions(),
    );
    if (handle) handles.push(handle);

    expect(handle).not.toBeNull();
    const lock = await detectActiveInstance(lockFile);
    expect(lock?.pid).toBe(process.pid);
    expect(lock?.port).toBe(handle?.port);
  });

  it('multiple simultaneous sessions written to disk by different runs all show up in GET /api/sessions', async () => {
    await writeSession('project-a', '1', makeSnapshot('sess-a', 1));
    await writeSession('project-b', '2', makeSnapshot('sess-b', 2));

    const sessions = watchSessionDirectory({ ...envOptions(), pollIntervalMs: 15 });
    dirHandles.push(sessions);
    const handle = await startWebServer({
      sessions,
      port: 0,
      host: '127.0.0.1',
      info: noop,
      warn: noop,
    });
    if (handle === null) throw new Error('server failed to start');
    handles.push(handle);

    await waitFor(async () => {
      const res = await fetch(`${handle.url}/api/sessions`);
      const body = (await res.json()) as unknown[];
      return body.length === 2;
    });

    const list = (await (await fetch(`${handle.url}/api/sessions`)).json()) as Array<{
      sessionId: string;
      issueNumber: number;
      statusUrl: string;
    }>;
    expect(list.map((s) => s.sessionId).sort()).toEqual(['sess-a', 'sess-b']);

    // Each session's own statusUrl actually resolves to that session.
    const a = list.find((s) => s.sessionId === 'sess-a');
    const resA = await fetch(`${handle.url}${a?.statusUrl}`);
    expect((await resA.json()).issue.number).toBe(1);
  });
});
