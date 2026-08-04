import { afterEach, describe, expect, it, vi } from 'vitest';

// getGlobalRoot() (storage/paths.ts) falls back to node:os's homedir() when
// no ISSUE_FLOW_HOME override is set, and throws when that resolves to an
// empty string — the one case US-006 (ensureWebMonitor's legacy fallback)
// exists for. Mocked in its own file: forcing this everywhere else would
// break every other test that resolves a real path under a tmpdir.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => '' };
});

import { MemoryPublisher } from '../core/session-state.js';
import { ensureWebMonitor } from './lock.js';
import type { WebServerHandle } from './server.js';

const noop = (): void => {};

describe('ensureWebMonitor — legacy fallback (US-006)', () => {
  const handles: WebServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.close()));
  });

  it('falls back to binding inline (no lock, publisher-backed) when the global storage tree is unreachable', async () => {
    const spawn = vi.fn();
    const warn = vi.fn();
    const publisher = new MemoryPublisher({ onWarn: noop });
    publisher.publish({
      type: 'session:start',
      at: '2026-01-01T00:00:00Z',
      sessionId: 'legacy-session',
      issueNumber: 1,
      phases: ['init'],
    });

    const handle = await ensureWebMonitor(
      { publisher, port: 0, host: '127.0.0.1', info: noop, warn },
      { env: {}, spawn },
    );
    if (handle) handles.push(handle);

    expect(handle).not.toBeNull();
    // Bound right here, in this process — a real Server, not a reused handle.
    expect(handle?.server).toBeDefined();
    // Never attempted to spawn a detached instance: the storage tree needed
    // for the lock file is what failed in the first place.
    expect(spawn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Falling back to legacy in-process mode'),
    );

    // The legacy server still serves the publisher's own snapshot directly.
    const res = await fetch(`${handle?.url}/api/status`);
    expect((await res.json()).sessionId).toBe('legacy-session');
  });
});
