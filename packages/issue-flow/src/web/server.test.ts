import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInitialSnapshot,
  MemoryPublisher,
  type SessionSnapshot,
} from '../core/session-state.js';
import { sessionSnapshotSchema } from '../schemas.js';
import {
  SESSION_LIST_DESCRIPTION_MAX,
  startWebServer,
  truncateSessionDescription,
  type WebServerHandle,
} from './server.js';
import type { ActiveSession, SessionDirectoryHandle } from './session-directory.js';

const noop = (): void => {};

describe('truncateSessionDescription', () => {
  it('returns null for nullish input and preserves short text', () => {
    expect(truncateSessionDescription(null)).toBeNull();
    expect(truncateSessionDescription(undefined)).toBeNull();
    expect(truncateSessionDescription('  hello   world  ')).toBe('hello world');
  });

  it('collapses whitespace and truncates long bodies with an ellipsis', () => {
    const body = `${'x'.repeat(SESSION_LIST_DESCRIPTION_MAX + 40)}`;
    const out = truncateSessionDescription(body);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(SESSION_LIST_DESCRIPTION_MAX);
    expect(out!.endsWith('…')).toBe(true);
  });
});

function makePublisher(): MemoryPublisher {
  const publisher = new MemoryPublisher({ onWarn: noop });
  publisher.publish({
    type: 'session:start',
    at: '2026-08-03T12:00:00Z',
    sessionId: 'session-1',
    issueNumber: 22,
    phases: ['init', 'prd'],
  });
  return publisher;
}

describe('startWebServer', () => {
  const handles: WebServerHandle[] = [];
  const tmpDirs: string[] = [];

  async function start(
    overrides: Partial<Parameters<typeof startWebServer>[0]> = {},
  ): Promise<WebServerHandle> {
    const handle = await startWebServer({
      publisher: makePublisher(),
      port: 0,
      host: '127.0.0.1',
      info: noop,
      warn: noop,
      ...overrides,
    });
    if (handle === null) throw new Error('server failed to start');
    handles.push(handle);
    return handle;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const handle of handles.splice(0)) {
      await handle.close();
    }
    for (const dir of tmpDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serves the in-memory snapshot on /api/status with the required headers', async () => {
    const handle = await start();
    const res = await fetch(`${handle.url}/api/status`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);

    const payload = await res.json();
    expect(sessionSnapshotSchema.parse(payload)).toBeTruthy();
    expect(payload.sessionId).toBe('session-1');
    expect(payload.issue.number).toBe(22);
  });

  it('serves the whole issue section, enrichment included', async () => {
    const publisher = makePublisher();
    publisher.publish({
      type: 'issue:update',
      at: '2026-08-03T12:00:01Z',
      number: 22,
      url: 'https://github.com/acme/repo/issues/22',
      title: 'Enrich the monitor snapshot',
      description: 'Body of the issue',
      labels: ['enhancement'],
      state: 'open',
    });
    const handle = await start({ publisher });

    const payload = await (await fetch(`${handle.url}/api/status`)).json();
    expect(payload.issue).toEqual({
      number: 22,
      url: 'https://github.com/acme/repo/issues/22',
      title: 'Enrich the monitor snapshot',
      description: 'Body of the issue',
      labels: ['enhancement'],
      state: 'open',
    });
  });

  it('serves the repository section with branch, head commit, name and root', async () => {
    const publisher = makePublisher();
    publisher.publish({
      type: 'git:update',
      at: '2026-08-03T12:00:02Z',
      branch: 'issue/22-test',
      baseBranch: 'main',
      repositoryName: 'acme/repo',
      remoteUrl: 'git@github.com:acme/repo.git',
      headCommit: 'c56b163',
      repositoryRoot: '/repo/root',
    });
    const handle = await start({ publisher });

    const payload = await (await fetch(`${handle.url}/api/status`)).json();
    expect(payload.repository).toEqual({
      name: 'acme/repo',
      remoteUrl: 'git@github.com:acme/repo.git',
      branch: 'issue/22-test',
      headCommit: 'c56b163',
      root: '/repo/root',
    });
  });

  it('serves the same payload on the /status.json alias', async () => {
    const handle = await start();
    const [status, alias] = await Promise.all([
      fetch(`${handle.url}/api/status`).then((r) => r.text()),
      fetch(`${handle.url}/status.json`).then((r) => r.text()),
    ]);
    expect(alias).toBe(status);
  });

  it('answers 304 with an empty body for a matching If-None-Match', async () => {
    const publisher = makePublisher();
    const handle = await start({ publisher });

    const first = await fetch(`${handle.url}/api/status`);
    const etag = first.headers.get('etag');
    expect(etag).not.toBeNull();

    const cached = await fetch(`${handle.url}/api/status`, {
      headers: { 'If-None-Match': etag as string },
    });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
    expect(cached.headers.get('cache-control')).toBe('no-store');

    // A new event bumps the version: the same ETag now gets a fresh 200.
    publisher.publish({ type: 'phase:start', at: '2026-08-03T12:01:00Z', phase: 'prd' });
    const changed = await fetch(`${handle.url}/api/status`, {
      headers: { 'If-None-Match': etag as string },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
  });

  it('lists a single session on /api/sessions', async () => {
    const handle = await start();
    const res = await fetch(`${handle.url}/api/sessions`);
    expect(res.status).toBe(200);

    const sessions = await res.json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: 'session-1',
      issueNumber: 22,
      status: 'running',
      statusUrl: '/api/status?session=session-1',
      // Enriched card fields (issue #35): null until the matching events land.
      issueTitle: null,
      issueDescription: null,
      repositoryName: null,
      currentPhase: null,
      progressPercent: 0,
      elapsedSeconds: expect.any(Number),
      // Resilience fields (US-029): a card that only shows a percentage cannot
      // tell a run that is progressing from one that has been retrying.
      retries: 0,
      correctionCycle: 0,
    });
  });

  it('enriches /api/sessions with issue, repository and progress fields for dashboard cards', async () => {
    const publisher = makePublisher();
    publisher.publish({
      type: 'issue:update',
      at: '2026-08-03T12:00:01Z',
      number: 22,
      url: 'https://github.com/acme/repo/issues/22',
      title: 'Dashboard multi-projeto',
      description: 'Listar sessões ativas como cards.',
      labels: ['frontend'],
      state: 'open',
    });
    publisher.publish({
      type: 'git:update',
      at: '2026-08-03T12:00:02Z',
      branch: 'issue/35-dashboard',
      baseBranch: 'main',
      commits: [],
      repositoryName: 'acme/issue-flow',
      remoteUrl: 'https://github.com/acme/issue-flow.git',
      headCommit: 'abc1234',
      repositoryRoot: '/tmp/issue-flow',
    });
    publisher.publish({ type: 'phase:start', at: '2026-08-03T12:00:03Z', phase: 'prd' });
    const handle = await start({ publisher });

    const sessions = await (await fetch(`${handle.url}/api/sessions`)).json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: 'session-1',
      issueNumber: 22,
      issueTitle: 'Dashboard multi-projeto',
      issueDescription: 'Listar sessões ativas como cards.',
      repositoryName: 'acme/issue-flow',
      currentPhase: 'prd',
      progressPercent: expect.any(Number),
      status: 'running',
      statusUrl: '/api/status?session=session-1',
    });
  });

  it('truncates long issueDescription on /api/sessions for dashboard preview', async () => {
    const longBody = `${'palavra '.repeat(80)}fim`;
    const publisher = makePublisher();
    publisher.publish({
      type: 'issue:update',
      at: '2026-08-03T12:00:01Z',
      number: 22,
      url: 'https://github.com/acme/repo/issues/22',
      title: 'Issue longa',
      description: longBody,
      labels: [],
      state: 'open',
    });
    const handle = await start({ publisher });

    const sessions = await (await fetch(`${handle.url}/api/sessions`)).json();
    expect(sessions[0].issueDescription.length).toBeLessThanOrEqual(SESSION_LIST_DESCRIPTION_MAX);
    expect(sessions[0].issueDescription.endsWith('…')).toBe(true);
    expect(sessions[0].issueDescription.length).toBeLessThan(longBody.length);
  });

  it('reports ok, uptime and version on /api/health', async () => {
    const handle = await start({ version: '9.9.9', refreshSeconds: 10 });
    const health = await fetch(`${handle.url}/api/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
    expect(typeof health.uptime).toBe('number');
    expect(health.version).toBe('9.9.9');
    expect(health.refreshSeconds).toBe(10);
  });

  it('serves static assets from the public directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'issue-flow-web-'));
    tmpDirs.push(dir);
    await writeFile(join(dir, 'index.html'), '<html>monitor</html>');
    await writeFile(join(dir, 'app.css'), 'body {}');
    await writeFile(join(dir, 'app.js'), 'console.log(1);');

    const handle = await start({ publicDir: dir });

    const index = await fetch(`${handle.url}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await index.text()).toBe('<html>monitor</html>');

    const css = await fetch(`${handle.url}/app.css`);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');

    const js = await fetch(`${handle.url}/app.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('serves the real UI assets when no publicDir is given (default resolution)', async () => {
    const handle = await start();

    const index = await fetch(`${handle.url}/`);
    expect(index.status).toBe(200);
    const html = await index.text();
    expect(html).toContain('issue-flow');
    expect(html).toContain('app.css');
    expect(html).toContain('app.js');
    // Self-contained UI: no external resources, works offline.
    expect(html).not.toMatch(/https?:\/\/(?!github)/);

    const css = await fetch(`${handle.url}/app.css`);
    expect(css.status).toBe(200);

    const js = await fetch(`${handle.url}/app.js`);
    expect(js.status).toBe(200);
    const jsText = await js.text();
    expect(jsText).toContain('api/status');
    expect(jsText).toContain('api/sessions');
    expect(jsText).toContain('renderDashboard');
    expect(jsText).toContain('pollAgain');
    expect(jsText).toContain("el('span', 'dashboard-card-head'");
    expect(jsText).not.toContain("el('div', 'dashboard-card-head'");
  });

  it('answers 404 JSON for unknown routes, missing assets and non-GET methods', async () => {
    const handle = await start({ publicDir: join(tmpdir(), 'does-not-exist') });

    for (const request of [
      fetch(`${handle.url}/nope`),
      fetch(`${handle.url}/`),
      fetch(`${handle.url}/api/control/pause`, { method: 'POST' }),
      fetch(`${handle.url}/api/status`, { method: 'POST' }),
    ]) {
      const res = await request;
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });

  it('returns null on EADDRINUSE and warns instead of failing the pipeline', async () => {
    const first = await start();
    const warn = vi.fn();

    const second = await startWebServer({
      publisher: makePublisher(),
      port: first.port,
      host: '127.0.0.1',
      info: noop,
      warn,
    });

    expect(second).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already in use'));
    // The original server is untouched.
    const res = await fetch(`${first.url}/api/health`);
    expect(res.status).toBe(200);
  });

  it('unrefs the server so it never keeps the process alive', async () => {
    const unref = vi.spyOn(Server.prototype, 'unref');
    await start();
    expect(unref).toHaveBeenCalled();
  });

  it('prints the access URL and warns about network exposure on 0.0.0.0', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    await start({ host: '0.0.0.0', info, warn });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('0.0.0.0'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('http://localhost:'));
  });

  it('does not warn about exposure for the default host', async () => {
    const warn = vi.fn();
    await start({ warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('close() stops the server, removes signal handlers and is idempotent', async () => {
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    const handle = await start();
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);

    await handle.close();
    await handle.close();

    expect(handle.server.listening).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
    await expect(fetch(`${handle.url}/api/health`)).rejects.toThrow();
  });
});

// ── Multi-session mode (US-003/US-004/US-005) ──────────────────────────────

function makeSnapshot(sessionId: string, issueNumber: number): SessionSnapshot {
  return {
    ...createInitialSnapshot(),
    sessionId,
    status: 'running',
    issue: { ...createInitialSnapshot().issue, number: issueNumber },
  };
}

/** A `SessionDirectoryHandle` double backed by a fixed, in-memory list. */
function fakeSessionDirectory(snapshots: SessionSnapshot[]): SessionDirectoryHandle {
  const sessions: ActiveSession[] = snapshots.map((snapshot) => ({
    issueDir: '/fake/issue-dir',
    filePath: '/fake/issue-dir/session.json',
    snapshot,
    updatedAtMs: Date.now(),
  }));
  return {
    sessions: () => sessions,
    getSession: (sessionId) => sessions.find((s) => s.snapshot.sessionId === sessionId),
    refresh: async () => {},
    close: () => {},
  };
}

describe('startWebServer — multi-session mode (directory-backed)', () => {
  const handles: WebServerHandle[] = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      await handle.close();
    }
  });

  async function start(snapshots: SessionSnapshot[]): Promise<WebServerHandle> {
    const handle = await startWebServer({
      sessions: fakeSessionDirectory(snapshots),
      port: 0,
      host: '127.0.0.1',
      info: noop,
      warn: noop,
    });
    if (handle === null) throw new Error('server failed to start');
    handles.push(handle);
    return handle;
  }

  it('GET /api/sessions lists every active session with a distinct statusUrl each', async () => {
    const handle = await start([makeSnapshot('sess-a', 1), makeSnapshot('sess-b', 2)]);

    const sessions = await (await fetch(`${handle.url}/api/sessions`)).json();
    expect(sessions).toHaveLength(2);
    const urls = sessions.map((s: { statusUrl: string }) => s.statusUrl);
    expect(new Set(urls).size).toBe(2);
    expect(urls).toEqual(
      expect.arrayContaining(['/api/status?session=sess-a', '/api/status?session=sess-b']),
    );
  });

  it('GET /api/sessions returns an empty array, not an error, with zero active sessions', async () => {
    const handle = await start([]);
    const res = await fetch(`${handle.url}/api/sessions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET /api/status?session=<id> returns that specific session', async () => {
    const handle = await start([makeSnapshot('sess-a', 1), makeSnapshot('sess-b', 2)]);

    const res = await fetch(`${handle.url}/api/status?session=sess-b`);
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.sessionId).toBe('sess-b');
    expect(payload.issue.number).toBe(2);
  });

  it('GET /api/status?session=<unknown> answers 404', async () => {
    const handle = await start([makeSnapshot('sess-a', 1)]);
    const res = await fetch(`${handle.url}/api/status?session=does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('GET /api/status with no query and exactly one active session answers it directly (back-compat)', async () => {
    const handle = await start([makeSnapshot('sess-a', 1)]);
    const res = await fetch(`${handle.url}/api/status`);
    expect(res.status).toBe(200);
    expect((await res.json()).sessionId).toBe('sess-a');
  });

  it('GET /api/status with no query and zero active sessions answers 404 explicitly', async () => {
    const handle = await start([]);
    const res = await fetch(`${handle.url}/api/status`);
    expect(res.status).toBe(404);
  });

  it('GET /api/status with no query and several active sessions answers 409 explicitly', async () => {
    const handle = await start([makeSnapshot('sess-a', 1), makeSnapshot('sess-b', 2)]);
    const res = await fetch(`${handle.url}/api/status`);
    expect(res.status).toBe(409);
    const payload = await res.json();
    expect(payload.sessions).toEqual(expect.arrayContaining(['sess-a', 'sess-b']));
  });
});
