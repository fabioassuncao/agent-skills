import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntimeEvent } from './contract.js';
import { type AgentControlServerHandle, startAgentControlServer } from './control-server.js';

/**
 * ADR-10 applies here even though this is not a browser surface: it accepts
 * writes about a live run, so it binds to loopback and requires a bearer token.
 * The cases §23 of the absorption plan calls for — an invalid token answering
 * 401 among them — are the reason this file exists.
 */
describe('startAgentControlServer', () => {
  const handles: AgentControlServerHandle[] = [];
  const received: AgentRuntimeEvent[] = [];

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.close();
    received.length = 0;
  });

  async function start(
    overrides: Partial<Parameters<typeof startAgentControlServer>[0]> = {},
  ): Promise<AgentControlServerHandle> {
    const handle = await startAgentControlServer({
      onEvent: (event) => {
        received.push(event);
      },
      onWarn: () => {},
      ...overrides,
    });
    if (handle === null) throw new Error('control server failed to start');
    handles.push(handle);
    return handle;
  }

  const validEvent = {
    runId: 'run-1',
    phase: 'execute',
    type: 'agent_status_changed',
    lifecycle: 'idle',
  };

  function post(
    handle: AgentControlServerHandle,
    body: unknown,
    token: string | null = handle.token,
  ): Promise<Response> {
    return fetch(handle.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('binds to loopback with a token that is not persisted anywhere', async () => {
    const handle = await start();
    expect(handle.url.startsWith('http://127.0.0.1:')).toBe(true);
    expect(handle.token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts a valid event and hands it over parsed', async () => {
    const handle = await start();
    const response = await post(handle, validEvent);

    expect(response.status).toBe(204);
    expect(received).toEqual([
      { runId: 'run-1', phase: 'execute', type: 'agent_status_changed', lifecycle: 'idle' },
    ]);
    expect(handle.accepted()).toBe(1);
  });

  it('answers 401 for a wrong token and for no token at all', async () => {
    const handle = await start();
    expect((await post(handle, validEvent, 'not-the-token')).status).toBe(401);
    expect((await post(handle, validEvent, null)).status).toBe(401);
    expect(received).toEqual([]);
    expect(handle.accepted()).toBe(0);
  });

  it('answers 400 for an unparseable body and for one that is not a known event', async () => {
    const handle = await start();
    expect((await post(handle, '{ not json')).status).toBe(400);
    expect((await post(handle, { runId: 'run-1', type: 'agent_status_changed' })).status).toBe(400);
    expect(received).toEqual([]);
  });

  it('answers 405 to anything that is not a POST', async () => {
    const handle = await start();
    const response = await fetch(handle.url, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(response.status).toBe(405);
  });

  // The hook waits for this response on the agent's hot path, so the handler
  // must not be charged to the agent's turn — and a handler that throws must
  // not turn into a failed hook.
  it('answers before handling, and survives a handler that throws', async () => {
    const warnings: string[] = [];
    const handle = await start({
      onEvent: () => {
        throw new Error('handler blew up');
      },
      onWarn: (message) => warnings.push(message),
    });

    expect((await post(handle, validEvent)).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(warnings.join('\n')).toContain('handler blew up');
  });
});
