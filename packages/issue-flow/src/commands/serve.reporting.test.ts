import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { NetworkInterfaceInfo } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValidatedSessionSnapshot } from '../storage/session-file.js';
import type { WebServerHandle } from '../web/server.js';
import type {
  ActiveSession,
  SessionDirectoryChange,
  SessionDirectoryHandle,
} from '../web/session-directory.js';

/**
 * What `serve` tells the person who typed it.
 *
 * `web serve` could afford to say nothing: it is spawned detached with
 * `stdio: 'ignore'`, so there is nobody to talk to. `serve` inherited that
 * silence when it became the canonical command (§47.4) and kept passing
 * `info: noop, warn: noop` into the bind — which made every outcome look
 * identical from a terminal. A foreground server that prints nothing cannot be
 * told apart from one that hung, and an invocation that exits 0 without a word
 * cannot be told apart from one that did nothing.
 *
 * These cases pin the three outcomes to output. They deliberately assert *that
 * something was said* rather than the exact wording, which is copy and moves.
 */

const bind = vi.hoisted(() => ({
  result: null as WebServerHandle | null,
  options: null as { info?: (m: string) => void; warn?: (m: string) => void } | null,
}));

vi.mock('../web/lock.js', () => ({
  ensureSingleWebServer: vi.fn(async (options: Record<string, unknown>) => {
    bind.options = options as { info?: (m: string) => void; warn?: (m: string) => void };
    return bind.result;
  }),
}));

const printed = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('../ui/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/logger.js')>();
  return {
    ...actual,
    printInfo: (message: string) => printed.lines.push(`info: ${message}`),
    printWarning: (message: string) => printed.lines.push(`warn: ${message}`),
    printError: (message: string) => printed.lines.push(`error: ${message}`),
    printSubsystem: (subsystem: string, message: string) =>
      printed.lines.push(`subsystem: [${subsystem}] ${message}`),
  };
});

const {
  installServeShutdown,
  listNetworkUrls,
  runProjectMaintenance,
  runServe,
  startServeActivityLogging,
} = await import('./serve.js');

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

describe('network addresses', () => {
  it('lists every distinct external IPv4 address using the bound port', () => {
    expect(
      listNetworkUrls(5111, {
        lo0: [ipv4('127.0.0.1', true)],
        en0: [ipv4('192.168.15.8'), ipv4('192.168.15.8')],
        utun4: [ipv4('100.71.21.121')],
      }),
    ).toEqual(['http://192.168.15.8:5111', 'http://100.71.21.121:5111']);
  });

  it('ignores IPv6 and internal addresses', () => {
    expect(
      listNetworkUrls(3737, {
        lo0: [ipv4('127.0.0.1', true)],
        en0: [
          {
            ...ipv4('fe80::1'),
            family: 'IPv6',
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe('serve activity', () => {
  it('reports lifecycle transitions but ignores ordinary snapshot writes', () => {
    let listener: ((change: SessionDirectoryChange) => void) | null = null;
    const sessions = new Map<string, ActiveSession>();
    const directory = {
      sessions: () => [...sessions.values()],
      getSession: (id: string) => sessions.get(id),
      subscribe: (next: (change: SessionDirectoryChange) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    } as Pick<SessionDirectoryHandle, 'sessions' | 'getSession' | 'subscribe'>;
    const lines: string[] = [];
    const snapshot = (status: 'running' | 'completed', phase: string) =>
      ({
        sessionId: 'run-1',
        status,
        currentPhase: phase,
        repository: { branch: 'feature/one' },
        git: { branch: 'feature/one' },
      }) as ValidatedSessionSnapshot;

    const stop = startServeActivityLogging(directory, (subsystem, message) => {
      lines.push(`[${subsystem}] ${message}`);
    });
    sessions.set('run-1', {
      projectId: 'project-1',
      issueId: '42',
      snapshot: snapshot('running', 'execute'),
      updatedAtMs: 1,
    });
    listener?.({ added: ['run-1'], updated: [], removed: [], revision: 1 });
    listener?.({ added: [], updated: ['run-1'], removed: [], revision: 2 });
    sessions.set('run-1', {
      projectId: 'project-1',
      issueId: '42',
      snapshot: snapshot('completed', 'review'),
      updatedAtMs: 2,
    });
    listener?.({ added: [], updated: ['run-1'], removed: [], revision: 3 });
    sessions.delete('run-1');
    listener?.({ added: [], updated: [], removed: ['run-1'], revision: 4 });
    stop();

    expect(lines).toEqual([
      '[run:open] project=project-1 run=run-1 branch=feature/one',
      '[run:state] project=project-1 run=run-1 branch=feature/one status=completed phase=review',
      '[run:close] project=project-1 run=run-1 branch=feature/one',
    ]);
  });
});

describe('serve shutdown', () => {
  it('aborts and drains an in-flight maintenance fetch before closing, idempotently', async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let created = false;
    const fetching = new Promise<void>((resolve) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          events.push('fetch-drained');
          resolve();
        },
        { once: true },
      );
    });
    const maintenance = fetching.then(() => {
      if (!controller.signal.aborted) created = true;
    });
    const originalClose = vi.fn(async () => {
      events.push('server-close');
    });
    const handle = { close: originalClose } as unknown as WebServerHandle;
    installServeShutdown(handle, {
      stopMaintenance: async () => {
        events.push('maintenance-stop');
        controller.abort();
        await maintenance;
      },
      stopActivityLogging: () => {},
      stopPullRequestMonitors: () => {},
      closeSessions: () => {},
    });

    await Promise.all([handle.close(), handle.close()]);

    expect(created).toBe(false);
    expect(events).toEqual(['maintenance-stop', 'fetch-drained', 'server-close']);
    expect(originalClose).toHaveBeenCalledOnce();
  });

  it('clears the pickup epoch while Linear auto-create is disabled', async () => {
    const home = await mkdtemp(join(tmpdir(), 'issue-flow-maintenance-reset-'));
    const processed = new Set(['linear-1']);
    try {
      await runProjectMaintenance({
        context: { projectRoot: home } as never,
        env: { ISSUE_FLOW_HOME: home },
        linearProcessed: processed,
      });
      expect(processed.size).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('still runs GitHub GC when the independent Linear pass fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'issue-flow-maintenance-isolation-'));
    const autoRemove = vi.fn(async () => ({ removed: [], skipped: [], inconclusive: false }));
    try {
      await writeFile(
        join(home, '.issue-flow.json'),
        JSON.stringify({
          linear: { autoCreateWorktrees: true },
          github: { autoRemoveOnMerge: true },
        }),
      );
      await runProjectMaintenance({
        context: { projectRoot: home } as never,
        env: { ISSUE_FLOW_HOME: home, LINEAR_API_KEY: 'maintenance-secret' },
        linearProcessed: new Set(),
        createLinear: () => ({
          fetchAssignedIssues: async () => {
            throw new Error('Linear failed with maintenance-secret');
          },
          postConversation: vi.fn(),
        }),
        autoRemove,
      });
      expect(autoRemove).toHaveBeenCalledOnce();
      expect(printed.lines.join('\n')).not.toContain('maintenance-secret');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('what serve reports', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-serve-report-'));
    printed.lines = [];
    bind.options = null;
    bind.result = null;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function run() {
    // A real port: 0 is rejected by the web config schema, which would make
    // the run fall back to the defaults and the assertions describe those.
    return runServe({
      cwd: home,
      env: { ISSUE_FLOW_HOME: home },
      host: '127.0.0.1',
      port: 3939,
      networkInterfaces: () => ({ en0: [ipv4('192.168.1.20')] }),
    });
  }

  function boundHandle(): WebServerHandle {
    return {
      server: { close: (cb?: () => void) => cb?.() } as unknown as WebServerHandle['server'],
      host: '127.0.0.1',
      port: 3737,
      url: 'http://localhost:3737',
      instanceId: 'test-instance',
      close: async () => {},
    };
  }

  // The regression itself: silencing the bind's own reporters is what made
  // every outcome indistinguishable, including the two warnings that say the
  // monitor is reachable from the network and the terminal is therefore off.
  it('never silences the reporters it hands to the bind', async () => {
    bind.result = boundHandle();
    await run();

    expect(bind.options).not.toBeNull();
    bind.options?.info?.('something worth knowing');
    bind.options?.warn?.('something worth worrying about');

    expect(printed.lines).toContain('info: something worth knowing');
    expect(printed.lines).toContain('warn: something worth worrying about');
  });

  // A foreground server that says nothing reads as a hung one — which is
  // exactly how this was reported.
  it('says it is staying in the foreground once it is serving', async () => {
    bind.result = boundHandle();
    const code = await run();

    expect(code).toBe(0);
    expect(printed.lines.join('\n')).toMatch(/foreground|Ctrl\+C/i);
  });

  it('reports background observers and their intervals', async () => {
    bind.result = boundHandle();
    await run();

    const output = printed.lines.join('\n');
    expect(output).toMatch(/session-directory.*3000ms/i);
    expect(output).toMatch(/pr-ci.*10000ms.*activity-gated/i);
    expect(output).toMatch(/reconciliation.*on demand/i);
    expect(output).toMatch(/worktree-gc.*scheduled.*60000ms/i);
  });

  it('does not advertise network addresses on loopback', async () => {
    bind.result = boundHandle();
    await run();

    expect(printed.lines.join('\n')).not.toContain('Network:');
  });

  it('advertises external addresses when bound beyond loopback', async () => {
    bind.result = { ...boundHandle(), host: '0.0.0.0' };
    await runServe({
      cwd: home,
      env: { ISSUE_FLOW_HOME: home },
      host: '0.0.0.0',
      port: 3939,
      networkInterfaces: () => ({
        en0: [ipv4('192.168.1.20')],
        utun4: [ipv4('100.71.21.121')],
      }),
    });

    expect(printed.lines).toContain('subsystem: [serve] Network: http://192.168.1.20:3737');
    expect(printed.lines).toContain('subsystem: [serve] Network: http://100.71.21.121:3737');
  });

  // Exiting 0 without a word looks like a command that did nothing at all.
  it('explains itself when another instance already owns the lock', async () => {
    bind.result = { ...boundHandle(), server: undefined };
    const code = await run();

    expect(code).toBe(0);
    expect(printed.lines.length).toBeGreaterThan(0);
    expect(printed.lines.join('\n')).toMatch(/exiting/i);
  });

  it('names the address it could not take when the bind fails', async () => {
    bind.result = null;
    const code = await run();

    expect(code).toBe(1);
    expect(printed.lines.join('\n')).toMatch(/error:/);
    expect(printed.lines.join('\n')).toContain('127.0.0.1:3939');
  });
});
