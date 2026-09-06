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
    api.setCapabilities(['worktrees']);

    expect(api.canCall('fetchWorktrees')).toBe(true);
    expect(api.canCall('terminalToken')).toBe(false);
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
