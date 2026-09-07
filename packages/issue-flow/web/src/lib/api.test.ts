import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * PORT of `frontend/src/lib/api.test.ts` @ d8c9d5f — 6 cases, plus 2 for the
 * capability gate this port adds.
 *
 * `apiBase` is derived from `window.location.pathname` at module load, so each
 * case sets the URL and re-imports `api.ts` fresh. It is the regression guard
 * for the push stream, which must be scoped under the active project's
 * `/<prefix>` like every other request — otherwise it falls through to the hub
 * and gets `index.html` back instead of the real endpoint.
 *
 * Two upstream cases changed shape rather than intent:
 *
 * - the SSE assertion targets `/api/stream` (the Issue Flow push channel)
 *   rather than `/api/notifications/stream`;
 * - `uploadFiles` has no route to post to, so the case asserts the honest
 *   refusal instead of a request that would 404.
 */
async function loadApiAt(pathname: string): Promise<typeof import('./api')> {
  window.history.replaceState({}, '', pathname);
  vi.resetModules();
  return import('./api');
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('project-prefixed network calls', () => {
  it('derives apiBase from the first path segment', async () => {
    expect((await loadApiAt('/myproject/')).apiBase).toBe('/myproject');
    expect((await loadApiAt('/')).apiBase).toBe('');
  });

  it('never treats a reserved segment as a project prefix', async () => {
    // `src/web/router.ts` keeps these out of the project namespace; deriving a
    // prefix from one would scope every call under a route that is not a
    // project.
    expect((await loadApiAt('/api/status')).apiBase).toBe('');
    expect((await loadApiAt('/legacy/')).apiBase).toBe('');
  });

  it('subscribeSessions opens the push stream under the active prefix', async () => {
    const urls: string[] = [];
    class MockEventSource {
      constructor(url: string) {
        urls.push(url);
      }
      addEventListener(): void {}
      close(): void {}
    }
    vi.stubGlobal('EventSource', MockEventSource);

    const api = await loadApiAt('/myproject/');
    api.subscribeSessions({ onSessions: () => {} });

    expect(urls).toEqual(['/myproject/api/stream']);
  });

  it('reports file upload as unavailable rather than posting to a route that does not exist', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const api = await loadApiAt('/myproject/');
    await expect(api.uploadFiles('feat/x', [new File(['a'], 'a.txt')])).rejects.toThrow(
      /não está disponível/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('capability gate', () => {
  it('refuses a gated call the monitor has not announced', async () => {
    const api = await loadApiAt('/myproject/');
    api.setCapabilities(['stream:sessions']);

    expect(api.canCall('fetchWorktrees')).toBe(false);
    await expect(api.fetchWorktrees()).rejects.toThrow(/não está disponível/i);
  });

  it('allows it once the capability is announced', async () => {
    const api = await loadApiAt('/myproject/');
    api.setCapabilities(['sessions']);

    expect(api.canCall('fetchWorktrees')).toBe(true);
    expect(api.canCall('terminalToken')).toBe(false);
  });

  /**
   * Phase 8D split the listing out of `worktrees`.
   *
   * The two are different promises: `sessions` says "I can list the sessions
   * and the worktrees they run in", which `src/web/worktrees-api.ts` serves;
   * `worktrees` still says "I can create, merge, archive and re-profile them",
   * which nothing serves yet. A monitor that had to claim the second to offer
   * the first is why the sidebar's session group was empty.
   */
  it('does not let the listing capability offer the mutation surface', async () => {
    const api = await loadApiAt('/myproject/');
    api.setCapabilities(['sessions']);

    expect(api.canCall('fetchWorktrees')).toBe(true);
    expect(api.canCall('createWorktree')).toBe(false);
    expect(api.canCall('mergeWorktree')).toBe(false);
    expect(api.canCall('setWorktreeProfile')).toBe(false);
  });

  it('announces Block A without enabling later agent, tab or settings routes', async () => {
    const api = await loadApiAt('/myproject/');
    api.setCapabilities(['worktrees:mutate']);

    expect(api.canCall('createWorktree')).toBe(true);
    expect(api.canCall('setWorktreeProfile')).toBe(true);
    expect(api.canCall('fetchAgents')).toBe(false);
    expect(api.canCall('createWorktreeTab')).toBe(false);
    expect(api.canCall('setAutoRemoveOnMerge')).toBe(false);
  });

  it('keeps the provider-neutral auto-name policy readable without a mutation capability', async () => {
    const api = await loadApiAt('/myproject/');
    api.setCapabilities([]);

    expect(api.canCall('fetchAutoNameConfig')).toBe(true);
  });

  it('keeps remote-safe agent reads separate from custom-agent writes', async () => {
    const api = await loadApiAt('/myproject/');
    api.setCapabilities(['agents:read']);

    expect(api.canCall('fetchAgents')).toBe(true);
    expect(api.canCall('validateAgent')).toBe(true);
    expect(api.canCall('createAgent')).toBe(false);
    expect(api.canCall('updateAgent')).toBe(false);
    expect(api.canCall('deleteAgent')).toBe(false);
  });
});

describe('agent sessions (§49.3)', () => {
  it('opens one under the active prefix, with nothing the caller did not ask for', async () => {
    const api = await loadApiAt('/myproject/');
    api.setCapabilities(['session:open']);

    const fetchMock = vi.fn(async () =>
      jsonResponse({ branch: 'session/scratch-a1b2', session: { id: 'sess-1' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await api.openSession()).toEqual({
      branch: 'session/scratch-a1b2',
      sessionId: 'sess-1',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/myproject/api/sessions');
    expect(init.method).toBe('POST');
    // Every field is optional: an empty body is what makes it *free* (§49.2).
    expect(init.body).toBe('{}');
  });

  it('refuses without the capability, and never reaches the network', async () => {
    const api = await loadApiAt('/myproject/');
    api.setCapabilities(['sessions']);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(api.canOpenSessions()).toBe(false);
    await expect(api.openSession()).rejects.toThrow(/não está disponível/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the server’s reason rather than a bare status', async () => {
    const api = await loadApiAt('/myproject/');
    api.setCapabilities(['session:open']);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'Issue 42 has no run to attach a session to yet.' }),
            {
              status: 409,
              headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    );

    await expect(api.linkSession('sess-1', '42')).rejects.toThrow(/no run to attach/);
  });

  /**
   * The consolidated listing of §49.4 answers "what is running anywhere", so a
   * monitor that cannot answer it says nothing rather than failing: the caller
   * renders a view with no sessions instead of an error nobody can act on.
   */
  it('answers an empty list where there is no session surface at all', async () => {
    const api = await loadApiAt('/myproject/');
    api.setCapabilities([]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await api.fetchAgentSessions()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for every project, and keeps only rows it can read', async () => {
    const api = await loadApiAt('/myproject/');
    api.setCapabilities(['sessions']);
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        { id: 's-1', branch: 'session/a', provider: 'codex', status: 'running', free: true },
        { nonsense: true },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const rows = await api.fetchAgentSessions();
    expect(fetchMock).toHaveBeenCalledWith('/myproject/api/agent-sessions?all=1', {
      cache: 'no-store',
    });
    expect(rows).toEqual([
      {
        id: 's-1',
        projectId: null,
        branch: 'session/a',
        provider: 'codex',
        label: null,
        status: 'running',
        runId: null,
        free: true,
      },
    ]);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe('setUpProject', () => {
  it('returns the prefix immediately when the repo is already a project', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          initializing: false,
          path: '/repo/y',
          project: {
            id: 'github.com/example/y',
            prefix: 'y',
            name: 'Y',
            root: '/repo/y',
            source: 'registered',
            active: false,
            served: true,
            addedAt: null,
            lastSeenAt: null,
          },
        }),
      ),
    );

    const api = await loadApiAt('/y/');
    const phases: string[] = [];
    const result = await api.setUpProject('/repo/y', (phase) => phases.push(phase));

    expect(result).toEqual({ prefix: 'y' });
    expect(phases).toEqual([]); // no setup needed → no phases
  });

  it('polls the setup tracker and resolves with the prefix when ready', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/projects') && method === 'POST') {
        return jsonResponse({ initializing: true, path: '/repo/x' });
      }
      if (url.endsWith('/api/project-inits')) {
        return jsonResponse({
          inits: [{ path: '/repo/x', phase: 'ready', prefix: 'x', name: 'X', error: null }],
        });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = await loadApiAt('/x/');
    const phases: string[] = [];
    const result = await api.setUpProject('/repo/x', (phase) => phases.push(phase));

    expect(result).toEqual({ prefix: 'x' });
    expect(phases).toEqual(['ready']);
  });

  it('rejects with the server error when setup fails', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/projects') && method === 'POST') {
        return jsonResponse({ initializing: true, path: '/repo/z' });
      }
      return jsonResponse({
        inits: [
          {
            path: '/repo/z',
            phase: 'failed',
            prefix: null,
            name: null,
            error: 'não é um repositório git',
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = await loadApiAt('/x/');
    await expect(api.setUpProject('/repo/z', () => {})).rejects.toThrow('não é um repositório git');
  });
});

/**
 * **U17** — the identity of the process that served this page.
 *
 * `--restart-web` puts new code behind the same origin. A page whose bundle
 * came out of a process that no longer exists is showing code the server has
 * stopped agreeing with, so it reloads. This is the asset handoff, not a
 * session state — and a server old enough not to send the header is not a
 * change either.
 */
describe('instance identity (U17)', () => {
  function withInstance(instanceId: string | null, body: unknown = {}): Response {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (instanceId !== null) headers['X-Issue-Flow-Instance'] = instanceId;
    return new Response(JSON.stringify(body), { status: 200, headers });
  }

  it('treats the first observation as a baseline, never as a change', async () => {
    const api = await loadApiAt('/');
    const onChange = vi.fn();
    api.resetInstanceIdentity();
    api.watchInstanceIdentity(onChange);

    expect(api.observeInstance(withInstance('a').headers)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a change once the serving process is replaced', async () => {
    const api = await loadApiAt('/');
    const onChange = vi.fn();
    api.resetInstanceIdentity();
    api.watchInstanceIdentity(onChange);

    api.observeInstance(withInstance('a').headers);
    expect(api.observeInstance(withInstance('a').headers)).toBe(false);
    expect(api.observeInstance(withInstance('b').headers)).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('says nothing about a server that does not send the header', async () => {
    const api = await loadApiAt('/');
    const onChange = vi.fn();
    api.resetInstanceIdentity();
    api.watchInstanceIdentity(onChange);

    expect(api.observeInstance(withInstance(null).headers)).toBe(false);
    expect(api.observeInstance(withInstance(null).headers)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('records the identity from the very first response of the page', async () => {
    // `loadCapabilities` is the first call the bundle makes; starting anywhere
    // later would leave the page with no baseline to compare against.
    const fetchMock = vi.fn(async () =>
      withInstance('boot', { ok: true, capabilities: ['stream:sessions'], version: '0.20.0' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const api = await loadApiAt('/');
    const onChange = vi.fn();
    api.watchInstanceIdentity(onChange);
    await api.loadCapabilities();

    expect(api.hasCapability('stream:sessions')).toBe(true);
    expect(api.observeInstance(withInstance('boot').headers)).toBe(false);
    expect(api.observeInstance(withInstance('other').headers)).toBe(true);
  });
});

/**
 * The revalidated status read. A `304` is the normal answer while nothing
 * changed, which is what keeps the fallback interval cheap.
 */
describe('fetchExecutionStatus', () => {
  it('sends If-None-Match and reports a 304 as unchanged', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetchMock);

    const api = await loadApiAt('/proj/');
    const result = await api.fetchExecutionStatus('run-1', 'W/"abc"');

    expect(result).toEqual({ kind: 'not-modified' });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('/proj/api/status?session=run-1');
    expect((call[1].headers as Record<string, string>)['If-None-Match']).toBe('W/"abc"');
  });

  it('returns the snapshot and its ETag when the run moved', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ sessionId: 'run-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json', ETag: 'W/"def"' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const api = await loadApiAt('/');
    const result = await api.fetchExecutionStatus(null, null);

    expect(result).toEqual({
      kind: 'snapshot',
      snapshot: { sessionId: 'run-1' },
      etag: 'W/"def"',
    });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/status');
  });
});
