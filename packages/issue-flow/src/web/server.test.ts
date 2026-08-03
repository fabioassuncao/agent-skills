import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryPublisher } from '../core/session-state.js';
import { sessionSnapshotSchema } from '../schemas.js';
import { startWebServer, type WebServerHandle } from './server.js';

const noop = (): void => {};

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
    expect(res.headers.get('etag')).toBe('"1"');

    const payload = await res.json();
    expect(sessionSnapshotSchema.parse(payload)).toBeTruthy();
    expect(payload.sessionId).toBe('session-1');
    expect(payload.issue.number).toBe(22);
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
    expect(changed.headers.get('etag')).toBe('"2"');
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
      statusUrl: '/api/status',
    });
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
