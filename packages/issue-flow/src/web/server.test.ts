import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentSession, saveSession } from '../agents/session/store.js';
import {
  createInitialSnapshot,
  MemoryPublisher,
  type SessionSnapshot,
} from '../core/session-state.js';
import {
  buildProjectSessionName,
  buildWorktreeParkingWindowName,
  buildWorktreeWindowName,
} from '../runtime/tmux/names.js';
import { sessionSnapshotSchema } from '../schemas.js';
import {
  loadWorktree,
  type PlanRepositoryContext,
  saveWorktree,
} from '../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import {
  SESSION_LIST_DESCRIPTION_MAX,
  startWebServer,
  truncateSessionDescription,
  type WebServerHandle,
} from './server.js';
import type {
  ActiveSession,
  SessionDirectoryChange,
  SessionDirectoryHandle,
} from './session-directory.js';

const noop = (): void => {};
const packageVersion = (createRequire(import.meta.url)('../../package.json') as { version: string })
  .version;

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
    const response = await fetch(`${handle.url}/api/health`);
    const health = await response.json();
    expect(health.ok).toBe(true);
    expect(health.pid).toBe(process.pid);
    expect(health.instanceId).toBe(handle.instanceId);
    expect(health.startedAt).toEqual(expect.any(String));
    expect(typeof health.uptime).toBe('number');
    expect(health.version).toBe('9.9.9');
    expect(health.refreshSeconds).toBe(10);
    expect(health.capabilities).toContain('config:agent:write');
    expect(health.capabilities).toContain('config:routing:write');
    expect(response.headers.get('X-Issue-Flow-Instance')).toBe(handle.instanceId);
  });

  it('reports the package version from both source and bundled layouts', async () => {
    const handle = await start();
    const health = await fetch(`${handle.url}/api/health`).then((response) => response.json());
    expect(health.version).toBe(packageVersion);
  });

  it('writes a validated global harness preference only on loopback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'issue-flow-web-config-'));
    tmpDirs.push(dir);
    const previous = process.env.ISSUE_FLOW_HOME;
    process.env.ISSUE_FLOW_HOME = dir;
    try {
      const handle = await start();
      const response = await fetch(`${handle.url}/api/config/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'codex', model: 'gpt-5.6' }),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf-8'))).toMatchObject({
        agent: { provider: 'codex', model: 'gpt-5.6' },
      });
    } finally {
      if (previous === undefined) delete process.env.ISSUE_FLOW_HOME;
      else process.env.ISSUE_FLOW_HOME = previous;
    }
  });

  it('writes validated routing preferences globally and exposes the resolved catalog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'issue-flow-web-routing-'));
    tmpDirs.push(dir);
    const previous = process.env.ISSUE_FLOW_HOME;
    process.env.ISSUE_FLOW_HOME = dir;
    try {
      const handle = await start({
        probeAvailability: async (id) => ({
          id,
          installed: id === 'claude' || id === 'codex',
          authenticated: id === 'claude' || id === 'codex',
          authentication: id === 'claude' || id === 'codex' ? 'confirmed' : 'failed',
          state: id === 'claude' || id === 'codex' ? 'ready' : 'unavailable',
          version: 'test',
          detail: 'test',
          observedAt: '2026-08-30T12:00:00.000Z',
          expiresAt: '2026-08-30T12:05:00.000Z',
          source: 'probe',
          cooldownUntil: null,
        }),
      });
      const response = await fetch(`${handle.url}/api/config/routing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'active', profile: 'economy', policy: 'recommended' }),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf-8'))).toMatchObject({
        routing: { mode: 'active', profile: 'economy', policy: 'recommended' },
      });

      const config = await fetch(`${handle.url}/api/config?session=session-1`).then((res) =>
        res.json(),
      );
      expect(config.routing).toMatchObject({
        mode: 'active',
        profile: 'economy',
        policy: 'recommended',
      });
      expect(config.catalog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            harness: 'codex-cli',
            provider: 'codex',
            installed: true,
            models: expect.arrayContaining([expect.objectContaining({ tier: 'fast' })]),
          }),
        ]),
      );
    } finally {
      if (previous === undefined) delete process.env.ISSUE_FLOW_HOME;
      else process.env.ISSUE_FLOW_HOME = previous;
    }
  });

  it('rejects invalid routing writes and disables them outside loopback', async () => {
    const local = await start();
    const invalid = await fetch(`${local.url}/api/config/routing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'automatic' }),
    });
    expect(invalid.status).toBe(400);

    const remote = await start({ host: '0.0.0.0' });
    const forbidden = await fetch(`${remote.url}/api/config/routing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'active' }),
    });
    expect(forbidden.status).toBe(403);
  });

  /**
   * A checkout that never ran `npm run build:web`.
   *
   * The previous panel used to be this answer (ADR-18). Phase 8D removed it
   * with §50.7 green, so `/` says what is missing and links `status.json` —
   * which §50.8 keeps as the one fallback that needs no JavaScript at all.
   */
  it('says the dashboard is not built, and keeps status.json reachable', async () => {
    const handle = await start({ dashboardDir: join(tmpdir(), 'issue-flow-no-dashboard') });

    const index = await fetch(`${handle.url}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await index.text();
    expect(html).toContain('npm run build:web');
    expect(html).toContain('status.json');

    // The no-JavaScript fallback is a route of its own and does not depend on
    // any panel existing.
    expect((await fetch(`${handle.url}/status.json`)).status).toBe(200);

    // The previous panel is gone: nothing answers at its addresses.
    for (const path of ['/legacy/', '/legacy', '/app.css', '/app.js']) {
      expect((await fetch(`${handle.url}${path}`, { redirect: 'manual' })).status).toBe(404);
    }
  });

  it('serves the built dashboard and only the assets the build emits', async () => {
    const dashboardDir = await mkdtemp(join(tmpdir(), 'issue-flow-dashboard-'));
    tmpDirs.push(dashboardDir);
    await mkdir(join(dashboardDir, 'assets'), { recursive: true });
    await writeFile(join(dashboardDir, 'index.html'), '<html>new</html>');
    await writeFile(join(dashboardDir, 'assets', 'index-abc123.js'), 'export default 1;');
    await writeFile(join(dashboardDir, 'assets', 'index-abc123.css'), '.a{}');
    await writeFile(join(dashboardDir, 'assets', 'logo.bin'), 'binary');

    const handle = await start({ dashboardDir });

    expect(await (await fetch(`${handle.url}/`)).text()).toBe('<html>new</html>');

    const asset = await fetch(`${handle.url}/assets/index-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await fetch(`${handle.url}/assets/index-abc123.css`)).headers.get('content-type')).toBe(
      'text/css; charset=utf-8',
    );

    // A file the build is not expected to emit is not guessed at: answering it
    // with the wrong Content-Type is worse than not answering.
    expect((await fetch(`${handle.url}/assets/logo.bin`)).status).toBe(404);
  });

  it('serves the packaged UI or the unbuilt fallback from the default location', async () => {
    const handle = await start();

    const index = await fetch(`${handle.url}/`);
    expect(index.status).toBe(200);
    const html = await index.text();
    expect(html).toContain('issue-flow');

    const bundle = /\/assets\/(index-[^"']+\.js)/.exec(html)?.[1];
    if (bundle === undefined) {
      // A source checkout is valid before `npm run build:web`: the default
      // resolver must produce the same actionable fallback as an explicit
      // missing dashboard directory.
      expect(html).toContain('npm run build:web');
      expect(html).toContain('status.json');
    } else {
      // A packaged checkout serves the module bundle and remains offline-safe.
      expect(html).not.toMatch(/https?:\/\/(?!github)/);
      const bundleResponse = await fetch(`${handle.url}/assets/${bundle}`);
      expect(bundleResponse.status).toBe(200);
      expect(bundleResponse.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    }

    // ...and there is no second panel behind it any more (§50.8).
    expect((await fetch(`${handle.url}/legacy/`)).status).toBe(404);
  });

  it('answers 404 JSON for unknown routes, missing assets and non-GET methods', async () => {
    const handle = await start({ dashboardDir: join(tmpdir(), 'does-not-exist-either') });

    // `/` is deliberately absent from this list: with no build it answers the
    // page that says so, which is more useful than a 404 nobody can act on.
    for (const request of [
      fetch(`${handle.url}/nope`),
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

/**
 * A `SessionDirectoryHandle` double backed by an in-memory list, with the push
 * side driven by hand: `replace()` swaps the sessions and notifies subscribers
 * exactly as a scan would, so a test can observe `/api/stream` without a real
 * SQLite tree or a filesystem watch.
 */
function fakeSessionDirectory(snapshots: SessionSnapshot[]) {
  let sessions: ActiveSession[] = snapshots.map((snapshot) => ({
    issueDir: '/fake/issue-dir',
    filePath: '/fake/issue-dir/session.json',
    snapshot,
    updatedAtMs: Date.now(),
  }));
  const listeners = new Set<(change: SessionDirectoryChange) => void>();
  let revision = 0;
  const handle: SessionDirectoryHandle & {
    replace(next: SessionSnapshot[], change?: Partial<SessionDirectoryChange>): void;
    subscriberCount(): number;
  } = {
    subscriberCount: () => listeners.size,
    sessions: () => sessions,
    getSession: (sessionId) => sessions.find((s) => s.snapshot.sessionId === sessionId),
    events: async (sessionId) =>
      sessions.some((s) => s.snapshot.sessionId === sessionId) ? [] : undefined,
    agentEvents: async (sessionId) =>
      sessions.some((s) => s.snapshot.sessionId === sessionId) ? [] : undefined,
    refresh: async () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => revision,
    close: () => listeners.clear(),
    replace: (next, change = {}) => {
      sessions = next.map((snapshot) => ({
        issueDir: '/fake/issue-dir',
        filePath: '/fake/issue-dir/session.json',
        snapshot,
        updatedAtMs: Date.now(),
      }));
      revision += 1;
      const payload: SessionDirectoryChange = {
        added: [],
        updated: [],
        removed: [],
        revision,
        ...change,
      };
      for (const listener of listeners) listener(payload);
    },
  };
  return handle;
}

/** One `event:`/`data:` frame of a Server-Sent Events response. */
interface StreamFrame {
  event: string;
  data: unknown;
}

/**
 * Read `/api/stream` and expose the frames as they arrive. `next(event)` waits
 * for the next frame of a given type, so a test asserts on delivery order
 * rather than on a timer.
 */
async function openEventStream(url: string) {
  const controller = new AbortController();
  const res = await fetch(url, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  });
  const frames: StreamFrame[] = [];
  const waiters: { event: string; resolve: (frame: StreamFrame) => void }[] = [];

  const deliver = (frame: StreamFrame): void => {
    const index = waiters.findIndex((waiter) => waiter.event === frame.event);
    // A frame handed to a waiter is consumed; buffering it too would let the
    // next `next()` call answer with a frame the test already asserted on.
    if (index >= 0) waiters.splice(index, 1)[0]?.resolve(frame);
    else frames.push(frame);
  };

  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = async (): Promise<void> => {
    if (reader === undefined) return;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.*)$/m.exec(raw)?.[1];
        if (event !== undefined && data !== undefined) {
          deliver({ event, data: JSON.parse(data) });
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  };
  void pump().catch(() => {});

  return {
    response: res,
    frames,
    next: (event: string, timeoutMs = 2000): Promise<StreamFrame> => {
      const existing = frames.findIndex((frame) => frame.event === event);
      if (existing >= 0) return Promise.resolve(frames.splice(existing, 1)[0] as StreamFrame);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no '${event}' frame in ${timeoutMs}ms`)),
          timeoutMs,
        );
        waiters.push({
          event,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
    close: () => controller.abort(),
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

  it('GET /api/events?session=<id> exposes the session journal', async () => {
    const snapshots = [makeSnapshot('sess-a', 1)];
    const directory = fakeSessionDirectory(snapshots);
    directory.events = async (sessionId) =>
      sessionId === 'sess-a'
        ? [{ seq: 1, event: { type: 'retry', at: '2026-08-30T10:00:00Z', attempt: 1 } }]
        : undefined;
    const handle = await startWebServer({
      sessions: directory,
      port: 0,
      host: '127.0.0.1',
      info: noop,
      warn: noop,
    });
    if (handle === null) throw new Error('server failed to start');
    handles.push(handle);

    const res = await fetch(`${handle.url}/api/events?session=sess-a`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { seq: 1, event: { type: 'retry', at: '2026-08-30T10:00:00Z', attempt: 1 } },
    ]);
    expect((await fetch(`${handle.url}/api/events?session=missing`)).status).toBe(404);
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

describe('startWebServer — push transport (/api/stream, absorption phase 1)', () => {
  const handles: WebServerHandle[] = [];
  const streams: { close: () => void }[] = [];

  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    for (const handle of handles.splice(0)) await handle.close();
  });

  async function start(directory: ReturnType<typeof fakeSessionDirectory>) {
    const handle = await startWebServer({
      sessions: directory,
      port: 0,
      host: '127.0.0.1',
      info: noop,
      warn: noop,
    });
    if (handle === null) throw new Error('server failed to start');
    handles.push(handle);
    return handle;
  }

  async function connect(url: string) {
    const stream = await openEventStream(url);
    streams.push(stream);
    return stream;
  }

  it('answers as an event stream and opens with hello plus the current session list', async () => {
    const directory = fakeSessionDirectory([makeSnapshot('sess-a', 1)]);
    const handle = await start(directory);

    const stream = await connect(`${handle.url}/api/stream`);
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(stream.response.headers.get('cache-control')).toBe('no-store');
    expect(stream.response.headers.get('x-accel-buffering')).toBe('no');

    const hello = await stream.next('hello');
    expect(hello.data).toMatchObject({ instanceId: handle.instanceId, session: null });

    const sessions = (await stream.next('sessions')).data as { sessionId: string }[];
    expect(sessions.map((entry) => entry.sessionId)).toEqual(['sess-a']);
  });

  it('pushes the session list on change without the client asking for it', async () => {
    const directory = fakeSessionDirectory([makeSnapshot('sess-a', 1)]);
    const handle = await start(directory);
    const stream = await connect(`${handle.url}/api/stream`);
    await stream.next('sessions');

    directory.replace([makeSnapshot('sess-a', 1), makeSnapshot('sess-b', 2)], {
      added: ['sess-b'],
    });

    const sessions = (await stream.next('sessions')).data as { sessionId: string }[];
    expect(sessions.map((entry) => entry.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
  });

  it('pushes a status frame only for the subscribed session', async () => {
    const directory = fakeSessionDirectory([makeSnapshot('sess-a', 1), makeSnapshot('sess-b', 2)]);
    const handle = await start(directory);
    const stream = await connect(`${handle.url}/api/stream?session=sess-a`);

    expect((await stream.next('hello')).data).toMatchObject({ session: 'sess-a' });
    expect((await stream.next('status')).data).toMatchObject({ sessionId: 'sess-a' });

    // A change that does not touch sess-a refreshes the list, never the status.
    directory.replace([makeSnapshot('sess-a', 1), makeSnapshot('sess-b', 2)], {
      updated: ['sess-b'],
    });
    await stream.next('sessions');
    expect(stream.frames.some((frame) => frame.event === 'status')).toBe(false);

    directory.replace([makeSnapshot('sess-a', 1), makeSnapshot('sess-b', 2)], {
      updated: ['sess-a'],
    });
    expect((await stream.next('status')).data).toMatchObject({ sessionId: 'sess-a' });
  });

  it('announces a subscribed session that stopped being active', async () => {
    const directory = fakeSessionDirectory([makeSnapshot('sess-a', 1)]);
    const handle = await start(directory);
    const stream = await connect(`${handle.url}/api/stream?session=sess-a`);
    await stream.next('status');

    directory.replace([], { removed: ['sess-a'] });
    expect((await stream.next('gone')).data).toEqual({ sessionId: 'sess-a' });
  });

  it('pushes exactly what GET /api/sessions would return, so the fallback needs no second path', async () => {
    const directory = fakeSessionDirectory([makeSnapshot('sess-a', 1)]);
    const handle = await start(directory);
    const stream = await connect(`${handle.url}/api/stream`);

    const pushed = (await stream.next('sessions')).data;
    const fetched = await (await fetch(`${handle.url}/api/sessions`)).json();
    expect(pushed).toEqual(fetched);
  });

  it('releases the subscription when the client disconnects', async () => {
    const directory = fakeSessionDirectory([makeSnapshot('sess-a', 1)]);
    const handle = await start(directory);
    const stream = await connect(`${handle.url}/api/stream`);
    await stream.next('sessions');

    stream.close();
    // The subscription is dropped on the socket's close event, which is
    // asynchronous relative to abort(); a bounded wait keeps the assertion
    // about the contract rather than about scheduling.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && directory.subscriberCount() > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(directory.subscriberCount()).toBe(0);
  });

  it('advertises the push capability on /api/health so an older reused monitor is distinguishable', async () => {
    const handle = await start(fakeSessionDirectory([]));
    const health = await (await fetch(`${handle.url}/api/health`)).json();
    expect(health.capabilities).toContain('stream:sessions');
  });

  it('works over the legacy single-publisher backend, which cannot push on its own', async () => {
    const publisher = makePublisher();
    const handle = await startWebServer({
      publisher,
      port: 0,
      host: '127.0.0.1',
      info: noop,
      warn: noop,
    });
    if (handle === null) throw new Error('server failed to start');
    handles.push(handle);

    const stream = await connect(`${handle.url}/api/stream?session=session-1`);
    await stream.next('status');

    publisher.publish({ type: 'phase:start', at: '2026-08-03T12:00:05Z', phase: 'prd' });
    expect((await stream.next('status')).data).toMatchObject({ currentPhase: 'prd' });
  });
});

describe('startWebServer — the terminal surface (absorption phase 8)', () => {
  const handles: WebServerHandle[] = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.close();
  });

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

  // Off unless asked for: a monitor that never serves a terminal must not
  // advertise one, and must not hand out a credential for it.
  it('is absent unless the caller asked for it', async () => {
    const handle = await start();
    const health = await (await fetch(`${handle.url}/api/health`)).json();
    expect(health.capabilities).not.toContain('terminal:attach');
    expect((await fetch(`${handle.url}/api/terminal/token`)).status).toBe(404);
  });

  it('advertises the capability and serves the credential on loopback', async () => {
    const handle = await start({ terminal: { resolveTarget: async () => null } });

    const health = await (await fetch(`${handle.url}/api/health`)).json();
    expect(health.capabilities).toContain('terminal:attach');

    const token = await (await fetch(`${handle.url}/api/terminal/token`)).json();
    expect(token.path).toBe('/ws/terminal');
    expect(typeof token.token).toBe('string');
    expect(token.token.length).toBeGreaterThan(0);
  });

  // ADR-10: this is a remote shell. It exists on loopback or it does not exist,
  // and the credential is never served where the surface itself is refused.
  it('does not exist when the monitor is not bound to loopback', async () => {
    const handle = await start({
      host: '0.0.0.0',
      terminal: { resolveTarget: async () => null },
    });

    const health = await (await fetch(`${handle.url}/api/health`)).json();
    expect(health.capabilities).not.toContain('terminal:attach');
    expect((await fetch(`${handle.url}/api/terminal/token`)).status).toBe(404);
  });
});

describe('startWebServer — the session listing (absorption phase 8D)', () => {
  const handles: WebServerHandle[] = [];
  const agentTmpDirs: string[] = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.close();
    for (const dir of agentTmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

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

  /**
   * Phase 8D split `sessions` out of `worktrees`.
   *
   * The two are different promises and conflating them cost the dashboard its
   * whole session surface: a monitor that could list perfectly well could not
   * say so without also claiming it could merge, archive and re-profile.
   */
  it('announces nothing and answers an empty list without the dependency', async () => {
    const handle = await start();
    const health = await (await fetch(`${handle.url}/api/health`)).json();
    expect(health.capabilities).not.toContain('sessions');
    expect(health.capabilities).not.toContain('pr:ci');

    const response = await fetch(`${handle.url}/api/worktrees`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ worktrees: [] });
  });

  it('announces the listing, and `pr:ci` only where a CI log can be read', async () => {
    const listingOnly = await start({
      worktrees: { resolveProject: async () => null },
    });
    const first = await (await fetch(`${listingOnly.url}/api/health`)).json();
    expect(first.capabilities).toContain('sessions');
    expect(first.capabilities).not.toContain('pr:ci');

    const withCi = await start({
      worktrees: { resolveProject: async () => null, ciLog: async () => 'log' },
    });
    const second = await (await fetch(`${withCi.url}/api/health`)).json();
    expect(second.capabilities).toContain('pr:ci');
  });

  it('never announces the mutation surface it does not serve', async () => {
    const handle = await start({ worktrees: { resolveProject: async () => null } });
    const health = await (await fetch(`${handle.url}/api/health`)).json();
    expect(health.capabilities).not.toContain('worktrees:mutate');
  });

  it('announces worktree mutations only when loopback and runtime wiring agree', async () => {
    const handle = await start({
      worktrees: {
        writable: true,
        resolveProject: async () => null,
        resolveRuntime: async () => null,
      },
    });
    const health = await (await fetch(`${handle.url}/api/health`)).json();
    expect(health.capabilities).toContain('worktrees:mutate');
    expect(health.capabilities).not.toContain('worktrees');
  });

  it('HTTP-gates a mutation even when a dependency incorrectly claims writable off loopback', async () => {
    const handle = await start({
      host: '0.0.0.0',
      worktrees: {
        writable: true,
        resolveProject: async () => null,
        resolveRuntime: async () => null,
      },
    });
    const response = await fetch(`${handle.url}/api/worktrees`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    const health = await (await fetch(`${handle.url}/api/health`)).json();
    expect(health.capabilities).not.toContain('worktrees:mutate');
  });

  it('serves custom-agent CRUD over HTTP and announces granular capabilities', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-agent-http-'));
    agentTmpDirs.push(projectRoot);
    const handle = await start({
      agents: {
        writable: true,
        resolveProject: async () => ({ projectRoot }),
      },
    });
    const health = await (await fetch(`${handle.url}/api/health`)).json();
    expect(health.capabilities).toContain('agents:read');
    expect(health.capabilities).toContain('agents:write');

    const created = await fetch(`${handle.url}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Gemini CLI', startCommand: `gemini "\${PROMPT}"` }),
    });
    expect(created.status).toBe(200);
    expect((await created.json()).agent.id).toBe('gemini-cli');

    const listed = await fetch(`${handle.url}/api/agents`);
    expect((await listed.json()).agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'gemini-cli', kind: 'custom' })]),
    );

    const updated = await fetch(`${handle.url}/api/agents/gemini-cli`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Gemini Pro', startCommand: 'gemini pro' }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).agent.label).toBe('Gemini Pro');

    expect(
      (
        await fetch(`${handle.url}/api/agents/gemini-cli`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
  });

  it('keeps agent reads and validation available remotely while refusing writes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-agent-remote-'));
    agentTmpDirs.push(projectRoot);
    const handle = await start({
      host: '0.0.0.0',
      agents: {
        writable: true,
        resolveProject: async () => ({ projectRoot }),
      },
    });
    const url = `http://127.0.0.1:${handle.port}`;
    const health = await (await fetch(`${url}/api/health`)).json();
    expect(health.capabilities).toContain('agents:read');
    expect(health.capabilities).not.toContain('agents:write');
    const listed = await fetch(`${url}/api/agents`);
    expect(listed.status).toBe(200);
    expect(
      (await listed.json()).agents.every(
        (agent: { startCommand: unknown }) => agent.startCommand === null,
      ),
    ).toBe(true);
    expect(
      (
        await fetch(`${url}/api/agents/validate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: 'X', startCommand: 'x' }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: 'X', startCommand: 'x' }),
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${url}/api/agents/%ZZ`, { method: 'DELETE' })).status).toBe(400);
  });

  it('dispatches encoded worktree resources to the canonical runtime operation', async () => {
    const setLabel = vi.fn(async () => ({}));
    const worktrees = {
      list: async () => [
        {
          branch: 'feat/http',
          path: '/worktrees/feat/http',
          entry: {
            path: '/worktrees/feat/http',
            branch: 'feat/http',
            head: 'abc',
            bare: false,
            detached: false,
          },
          binding: { branch: 'feat/http', worktreeId: 'wt-http' },
          state: 'managed',
        },
      ],
      setLabel,
    };
    const handle = await start({
      worktrees: {
        writable: true,
        resolveProject: async () => null,
        resolveRuntime: async () =>
          ({
            projectId: 'project',
            deps: { projectId: 'project', worktrees },
            worktrees,
            profileNames: [],
          }) as never,
      },
    });
    const response = await fetch(`${handle.url}/api/worktrees/feat%2Fhttp/label`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'HTTP path' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, label: 'HTTP path' });
    expect(setLabel).toHaveBeenCalledWith('feat/http', 'HTTP path');
  });

  it('dispatches create, select, refresh and delete tab routes over HTTP', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-tabs-http-'));
    agentTmpDirs.push(projectRoot);
    const branch = 'feat/http-tabs';
    const projectId = 'project-tabs-http';
    const worktreeId = 'wt-tabs-http';
    const storage: PlanRepositoryContext = {
      tasksPath: '',
      projectId,
      issueId: '',
      projectRoot,
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: projectRoot } },
    };
    const timestamp = '2026-09-06T12:00:00.000Z';
    const binding = {
      worktreeId,
      branch,
      path: projectRoot,
      baseBranch: 'main',
      label: null,
      profile: 'default',
      agent: 'claude',
      runtime: 'host' as const,
      startupEnvValues: {},
      allocatedPorts: {},
      source: null,
      conversationId: null,
      archived: false,
      activeAgentSessionId: null,
      tabSequenceCounter: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await saveWorktree(storage, binding);
    const root = createAgentSession({
      branch,
      worktreeId,
      provider: 'claude',
      permission: 'workspace',
      conversationId: 'root-http-conversation',
      paneTarget: '%1',
      tabSequence: 0,
      status: 'running',
    });
    await saveSession(storage, root);
    await saveWorktree(storage, { ...binding, activeAgentSessionId: root.id });

    const sessionName = buildProjectSessionName(projectId);
    const mainWindow = buildWorktreeWindowName(branch);
    const parkingWindow = buildWorktreeParkingWindowName(worktreeId);
    const panes = new Map<string, string>([['%1', mainWindow]]);
    const tokens = new Map<string, string>([['%1', root.paneToken as string]]);
    let nextPane = 2;
    const tmux = {
      isAvailable: async () => true,
      hasWindow: async () => true,
      hasWindowStrict: async (_session: string, window: string) =>
        [...panes.values()].includes(window),
      getPaneId: async () => '%1',
      getPaneWindow: async (pane: string) => panes.get(pane) as string,
      hasPaneStrict: async (pane: string) => panes.has(pane),
      getPaneIdentity: async (pane: string) => ({
        paneId: pane,
        sessionName,
        windowName: panes.get(pane) as string,
        ownerToken: tokens.get(pane) ?? null,
      }),
      tagPaneOwner: async (pane: string, token: string) => void tokens.set(pane, token),
      createParkedPane: async () => {
        const pane = `%${nextPane++}`;
        panes.set(pane, parkingWindow);
        return pane;
      },
      runCommand: async () => {},
      swapPanes: async (left: string, right: string) => {
        const leftWindow = panes.get(left) as string;
        panes.set(left, panes.get(right) as string);
        panes.set(right, leftWindow);
      },
      movePaneToWindow: async (pane: string, destination: string) =>
        void panes.set(pane, destination.slice(destination.indexOf(':') + 1)),
      selectPane: async () => {},
      killPaneStrict: async (pane: string) => {
        panes.delete(pane);
        tokens.delete(pane);
      },
      listPaneLocations: async () =>
        [...panes].map(([paneId, windowName]) => ({
          paneId,
          sessionName,
          windowName,
          ownerToken: tokens.get(paneId) ?? null,
        })),
    };
    const worktrees = {
      list: async () => [
        {
          branch,
          path: projectRoot,
          entry: { path: projectRoot, branch, head: null, bare: false, detached: false },
          binding: await loadWorktree(storage, branch),
          state: 'managed' as const,
        },
      ],
      remove: async () => {},
    };
    const runtime = {
      projectId,
      projectRoot,
      storage,
      profileName: 'default',
      profileNames: ['default'],
      profileConfigs: [{ name: 'default' }],
      mainBranch: 'main',
      startupEnv: {},
      services: [],
      worktrees,
      git: { resolveWorktreeGitDir: async () => join(projectRoot, '.git') },
      deps: {
        projectId,
        projectRoot,
        storage,
        worktrees,
        tmux,
        git: { resolveWorktreeGitDir: async () => join(projectRoot, '.git') },
        branchExists: async () => true,
        panes: [{ id: 'agent', kind: 'agent', focus: true }],
        profileName: 'default',
        shellPath: '/bin/sh',
      },
    };
    const handle = await start({
      worktrees: {
        writable: true,
        resolveProject: async () => null,
        resolveRuntime: async () => runtime as never,
      },
    });
    const encoded = encodeURIComponent(branch);
    const created = await fetch(`${handle.url}/api/worktrees/${encoded}/tabs`, {
      method: 'POST',
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { tab: { tabId: string } };

    expect(
      (
        await fetch(`${handle.url}/api/worktrees/${encoded}/tabs/${createdBody.tab.tabId}/select`, {
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${handle.url}/api/worktrees/${encoded}/agent-terminal/refresh`, {
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${handle.url}/api/worktrees/${encoded}/tabs/${createdBody.tab.tabId}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
  });

  it('serves Linear, auto-name and integration settings with loopback-only mutations', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-integrations-http-'));
    agentTmpDirs.push(projectRoot);
    const postConversation = vi.fn(async () => ({
      issueId: 'ENG-12',
      issueUrl: 'https://linear/ENG-12',
      commentUrl: 'https://linear/comment/12',
      attachmentUrl: 'https://linear/attachment/12',
    }));
    const runtime = { projectRoot } as never;
    const handle = await start({
      integrations: {
        writable: true,
        env: { LINEAR_API_KEY: 'server-secret' },
        resolveRuntime: async () => runtime,
        createLinearClient: () => ({
          fetchAssignedIssues: async () => [],
          postConversation,
        }),
        readConversation: async () => ({
          markdown: 'conversa HTTP',
          attachment: {
            issueFlowConversation: 1,
            branch: 'feat/http',
            baseBranch: 'main',
            agent: 'codex',
            createdAt: '2026-09-06T00:00:00.000Z',
            conversation: [],
          },
        }),
      },
    });

    const health = await (await fetch(`${handle.url}/api/health`)).json();
    expect(health.capabilities).toEqual(
      expect.arrayContaining(['linear:read', 'linear:write', 'settings:write']),
    );
    expect(await (await fetch(`${handle.url}/api/linear/issues`)).json()).toEqual({
      availability: 'ready',
      issues: [],
    });
    expect((await fetch(`${handle.url}/api/project/auto-name`)).status).toBe(200);

    const toggle = await fetch(`${handle.url}/api/linear/auto-create`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(toggle.status).toBe(200);

    const posted = await fetch(`${handle.url}/api/worktrees/feat%2Fhttp/linear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'issue', issueId: 'ENG-12' } }),
    });
    expect(posted.status).toBe(200);
    expect(postConversation).toHaveBeenCalledWith(
      { kind: 'issue', issueId: 'ENG-12' },
      {
        branch: 'feat/http',
        markdown: 'conversa HTTP',
        attachment: expect.objectContaining({ issueFlowConversation: 1, branch: 'feat/http' }),
      },
    );
  });

  it('does not announce or allow integration mutations off loopback', async () => {
    let linearReads = 0;
    const handle = await start({
      host: '0.0.0.0',
      integrations: {
        writable: true,
        env: { LINEAR_API_KEY: 'remote-http-secret' },
        resolveRuntime: async () => ({ projectRoot: '/tmp/project' }) as never,
        createLinearClient: () => ({
          fetchAssignedIssues: async () => {
            linearReads += 1;
            if (linearReads === 1) throw new Error('Linear echoed remote-http-secret');
            return [
              {
                id: 'id-1',
                identifier: 'ENG-1',
                title: 'Título normal',
                description: 'Descrição remote-http-secret',
                priority: 1,
                priorityLabel: 'Urgente',
                url: 'https://linear/remote-http-secret',
                branchName: 'eng-1',
                dueDate: null,
                updatedAt: '2026-09-06T00:00:00Z',
                state: { name: 'Todo', color: '#fff', type: 'unstarted' },
                team: { name: 'Engineering', key: 'ENG' },
                labels: [],
                project: null,
              },
            ];
          },
          postConversation: vi.fn(),
        }),
      },
    });
    const health = await (await fetch(`${handle.url}/api/health`)).json();
    expect(health.capabilities).toContain('linear:read');
    expect(health.capabilities).not.toContain('linear:write');
    expect(health.capabilities).not.toContain('settings:write');
    const linear = await fetch(`${handle.url}/api/linear/issues`);
    expect(linear.status).toBe(502);
    expect(await linear.text()).not.toContain('remote-http-secret');
    const linearData = await fetch(`${handle.url}/api/linear/issues`);
    expect(linearData.status).toBe(200);
    const linearText = await linearData.text();
    expect(linearText).toContain('[redacted]');
    expect(linearText).not.toContain('remote-http-secret');
    expect((await fetch(`${handle.url}/api/config/project`)).status).toBe(403);
    expect(
      (
        await fetch(`${handle.url}/api/github/auto-remove-on-merge`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        })
      ).status,
    ).toBe(403);
  });

  it('returns typed statuses for malformed and oversized JSON mutation bodies', async () => {
    const handle = await start({
      integrations: {
        writable: true,
        resolveRuntime: async () => ({ projectRoot: '/tmp/project' }) as never,
      },
    });
    const malformed = await fetch(`${handle.url}/api/linear/auto-create`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    const oversized = await fetch(`${handle.url}/api/linear/auto-create`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, padding: 'x'.repeat(70 * 1024) }),
    });
    expect(oversized.status).toBe(413);
  });
});
