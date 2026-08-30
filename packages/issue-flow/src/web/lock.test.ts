import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPublisher } from '../core/session-state.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import {
  detectActiveInstance,
  ensureSingleWebServer,
  ensureWebMonitor,
  getWebLockFile,
  readWebLock,
  removeWebLock,
  stopWebMonitor,
  WEB_LOCK_FILENAME,
} from './lock.js';
import type { WebServerHandle } from './server.js';

const noop = (): void => {};

function makePublisher(): MemoryPublisher {
  return new MemoryPublisher({ onWarn: noop });
}

/** Guaranteed to not be a live process on any platform's real pid range. */
const DEAD_PID = 999999999;

describe('web/lock', () => {
  let home: string;
  let envOptions: { env: NodeJS.ProcessEnv };
  const handles: WebServerHandle[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-web-lock-'));
    envOptions = { env: { [GLOBAL_ROOT_ENV]: home } };
  });

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.close()));
    await rm(home, { recursive: true, force: true });
  });

  async function start(port = 0): Promise<WebServerHandle> {
    const handle = await ensureSingleWebServer(
      {
        publisher: makePublisher(),
        port,
        host: '127.0.0.1',
        info: noop,
        warn: noop,
      },
      envOptions,
    );
    if (handle === null) throw new Error('server failed to start');
    handles.push(handle);
    return handle;
  }

  /** Same path as `start`, but the instance reports a different release. */
  async function startWithVersion(version: string): Promise<WebServerHandle> {
    const handle = await ensureSingleWebServer(
      { publisher: makePublisher(), port: 0, host: '127.0.0.1', version, info: noop, warn: noop },
      envOptions,
    );
    if (handle === null) throw new Error('server failed to start');
    handles.push(handle);
    return handle;
  }

  it('getWebLockFile resolves to <globalRoot>/web.lock', () => {
    expect(getWebLockFile(envOptions)).toBe(join(home, WEB_LOCK_FILENAME));
  });

  it('first invocation binds a server and writes pid + port to the lock file', async () => {
    const handle = await start();

    const lock = await readWebLock(getWebLockFile(envOptions));
    expect(lock).not.toBeNull();
    expect(lock?.pid).toBe(process.pid);
    expect(lock?.port).toBe(handle.port);
    expect(lock?.host).toBe('127.0.0.1');
  });

  it('a second invocation reuses the live instance instead of binding a new one', async () => {
    const first = await start();

    const second = await ensureSingleWebServer(
      { publisher: makePublisher(), port: 0, host: '127.0.0.1', info: noop, warn: noop },
      envOptions,
    );

    expect(second).not.toBeNull();
    expect(second?.port).toBe(first.port);
    // Reused handles own no local server and must not tear down the real one.
    expect(second?.server).toBeUndefined();
    await second?.close();
    // The original instance is unaffected by the reused handle's close().
    const stillAlive = await detectActiveInstance(getWebLockFile(envOptions));
    expect(stillAlive?.pid).toBe(process.pid);
  });

  it('a lock referencing a dead pid is treated as stale and replaced', async () => {
    const lockFile = getWebLockFile(envOptions);
    await writeFile(
      lockFile,
      JSON.stringify({
        pid: DEAD_PID,
        port: 59999,
        host: '127.0.0.1',
        startedAt: '2020-01-01T00:00:00Z',
      }),
      'utf-8',
    );

    const handle = await start();

    const lock = await readWebLock(lockFile);
    expect(lock?.pid).toBe(process.pid);
    expect(lock?.port).toBe(handle.port);
  });

  it('a lock whose owner is alive but does not answer /api/health is treated as stale', async () => {
    const lockFile = getWebLockFile(envOptions);
    // Our own pid is very much alive, but nothing is listening on this port.
    await writeFile(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        port: 1,
        host: '127.0.0.1',
        startedAt: '2020-01-01T00:00:00Z',
      }),
      'utf-8',
    );

    const handle = await start();

    const lock = await readWebLock(lockFile);
    expect(lock?.port).toBe(handle.port);
    expect(lock?.port).not.toBe(1);
  });

  it('closing the server that created the lock removes it', async () => {
    const handle = await start();
    const lockFile = getWebLockFile(envOptions);
    expect(await readWebLock(lockFile)).not.toBeNull();

    await handle.close();
    handles.length = 0;

    expect(await readWebLock(lockFile)).toBeNull();
  });

  it('detectActiveInstance returns null and clears the file when no lock exists', async () => {
    const lockFile = getWebLockFile(envOptions);
    expect(await detectActiveInstance(lockFile)).toBeNull();
    await removeWebLock(lockFile); // idempotent on an absent file
  });

  it('readWebLock ignores a malformed lock file instead of throwing', async () => {
    const lockFile = getWebLockFile(envOptions);
    await writeFile(lockFile, 'not json', 'utf-8');
    expect(await readWebLock(lockFile)).toBeNull();
  });

  it('two concurrent invocations converge on a single bound instance', async () => {
    const [a, b] = await Promise.all([
      ensureSingleWebServer(
        { publisher: makePublisher(), port: 0, host: '127.0.0.1', info: noop, warn: noop },
        envOptions,
      ),
      ensureSingleWebServer(
        { publisher: makePublisher(), port: 0, host: '127.0.0.1', info: noop, warn: noop },
        envOptions,
      ),
    ]);
    if (a) handles.push(a);
    if (b) handles.push(b);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.port).toBe(b?.port);
    // Exactly one of the two owns a local server; the other reused it.
    const owners = [a, b].filter((h) => h?.server !== undefined);
    expect(owners).toHaveLength(1);
  });

  describe('ensureWebMonitor (US-002)', () => {
    /** A ChildProcess-shaped double: only `.unref()` is ever called on it. */
    function fakeChild(): { unref: () => void } {
      return { unref: () => {} };
    }

    it('reuses an active instance without spawning anything', async () => {
      const existing = await start();
      const spawn = vi.fn();

      const handle = await ensureWebMonitor(
        { publisher: makePublisher(), port: 0, host: '127.0.0.1', info: noop, warn: noop },
        { ...envOptions, spawn },
      );
      if (handle) handles.push(handle);

      expect(handle?.port).toBe(existing.port);
      expect(handle?.server).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('names the version of the monitor it reuses', async () => {
      await start();
      const lines: string[] = [];

      const handle = await ensureWebMonitor(
        {
          publisher: makePublisher(),
          port: 0,
          host: '127.0.0.1',
          info: (m) => lines.push(m),
          warn: (m) => lines.push(m),
        },
        { ...envOptions, spawn: vi.fn() },
      );
      if (handle) handles.push(handle);

      expect(lines.some((l) => /Reusing existing web monitor v\d+\.\d+\.\d+ at /.test(l))).toBe(
        true,
      );
      // Same release on both sides: nothing to warn about.
      expect(lines.some((l) => l.includes('--restart-web'))).toBe(false);
    });

    it('warns that the dashboard is older when the reused monitor is another release', async () => {
      await startWithVersion('0.0.1-old');
      const warnings: string[] = [];

      const handle = await ensureWebMonitor(
        {
          publisher: makePublisher(),
          port: 0,
          host: '127.0.0.1',
          info: noop,
          warn: (m) => warnings.push(m),
        },
        { ...envOptions, spawn: vi.fn() },
      );
      if (handle) handles.push(handle);

      // The pipeline still reuses it: the mismatch is reported, never enforced.
      expect(handle).not.toBeNull();
      expect(warnings.some((w) => w.includes('v0.0.1-old') && w.includes('--restart-web'))).toBe(
        true,
      );
    });

    it('spawns a detached, stdio-ignored child when no instance is active', async () => {
      const spawn = vi.fn((_command: string, _args: string[], _opts: unknown) => {
        // Simulate the detached `web serve` process binding and claiming the
        // lock, using the exact same low-level path production code takes.
        void ensureSingleWebServer(
          { publisher: makePublisher(), port: 0, host: '127.0.0.1', info: noop, warn: noop },
          envOptions,
        ).then((h) => {
          if (h) handles.push(h);
        });
        return fakeChild();
      });

      const handle = await ensureWebMonitor(
        { publisher: makePublisher(), port: 0, host: '127.0.0.1', info: noop, warn: noop },
        { ...envOptions, spawn, entryScript: '/cli.js', claimPollIntervalMs: 10 },
      );
      if (handle) handles.push(handle);

      expect(handle).not.toBeNull();
      // This process never owns the spawned instance's Server.
      expect(handle?.server).toBeUndefined();
      expect(spawn).toHaveBeenCalledTimes(1);
      const [command, args, opts] = spawn.mock.calls[0] as [string, string[], unknown];
      expect(command).toBe(process.execPath);
      expect(args).toEqual(['/cli.js', 'web', 'serve', '--port', '0', '--host', '127.0.0.1']);
      expect(opts).toEqual({ detached: true, stdio: 'ignore' });
    });

    it('includes --refresh only when refreshSeconds is set', async () => {
      const spawn = vi.fn((_c: string, _a: string[]) => fakeChild());

      await ensureWebMonitor(
        { publisher: makePublisher(), port: 0, host: '127.0.0.1', info: noop, warn: noop },
        {
          ...envOptions,
          spawn,
          entryScript: '/cli.js',
          claimTimeoutMs: 30,
          claimPollIntervalMs: 10,
        },
      );

      const [, argsWithout] = spawn.mock.calls[0] as [string, string[]];
      expect(argsWithout).not.toContain('--refresh');

      await ensureWebMonitor(
        {
          publisher: makePublisher(),
          port: 0,
          host: '127.0.0.1',
          refreshSeconds: 7,
          info: noop,
          warn: noop,
        },
        {
          ...envOptions,
          spawn,
          entryScript: '/cli.js',
          claimTimeoutMs: 30,
          claimPollIntervalMs: 10,
        },
      );
      const [, argsWith] = spawn.mock.calls[1] as [string, string[]];
      expect(argsWith).toEqual(expect.arrayContaining(['--refresh', '7']));
    });

    it('gives up and returns null (never affecting the pipeline) when the spawned instance never claims the lock', async () => {
      const warn = vi.fn();
      const spawn = vi.fn((_c: string, _a: string[]) => fakeChild()); // never actually binds

      const handle = await ensureWebMonitor(
        { publisher: makePublisher(), port: 0, host: '127.0.0.1', info: noop, warn },
        {
          ...envOptions,
          spawn,
          entryScript: '/cli.js',
          claimTimeoutMs: 30,
          claimPollIntervalMs: 10,
        },
      );

      expect(handle).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not start in time'));
    });

    it('returns null (and warns) instead of throwing when spawn itself fails', async () => {
      const warn = vi.fn();
      const spawn = vi.fn(() => {
        throw new Error('ENOENT: no such file');
      });

      const handle = await ensureWebMonitor(
        { publisher: makePublisher(), port: 0, host: '127.0.0.1', info: noop, warn },
        { ...envOptions, spawn, entryScript: '/cli.js' },
      );

      expect(handle).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('failed to start the detached server'),
      );
    });

    it('never spawns when the entry script cannot be determined', async () => {
      const spawn = vi.fn();
      const warn = vi.fn();
      const originalArgv1 = process.argv[1];
      // ensureWebMonitor falls back to process.argv[1] when no entryScript is
      // injected; the only way to exercise "cannot be determined" is to make
      // that fallback itself absent, same as a Node embedding with no script.
      process.argv[1] = undefined as unknown as string;

      try {
        const handle = await ensureWebMonitor(
          { publisher: makePublisher(), port: 0, host: '127.0.0.1', info: noop, warn },
          { ...envOptions, spawn },
        );

        expect(handle).toBeNull();
        expect(spawn).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('could not determine the CLI entry point'),
        );
      } finally {
        process.argv[1] = originalArgv1;
      }
    });

    it('restart stops the verified instance, invalidates memory caches and spawns a replacement', async () => {
      const existing = await start();
      const oldLock = await readWebLock(getWebLockFile(envOptions));
      const info = vi.fn();
      const kill = vi.fn(() => true) as unknown as typeof process.kill;
      const spawn = vi.fn((_command: string, _args: string[]) => {
        void ensureSingleWebServer(
          { publisher: makePublisher(), port: 0, host: '127.0.0.1', info: noop, warn: noop },
          envOptions,
        ).then((handle) => {
          if (handle) handles.push(handle);
        });
        return fakeChild();
      });

      const replacement = await ensureWebMonitor(
        { publisher: makePublisher(), port: 0, host: '127.0.0.1', info, warn: noop },
        {
          ...envOptions,
          restart: true,
          kill,
          isAlive: () => false,
          spawn,
          entryScript: '/cli.js',
          claimPollIntervalMs: 10,
        },
      );
      if (replacement) handles.push(replacement);

      expect(kill).toHaveBeenCalledWith(oldLock?.pid, 'SIGTERM');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(replacement).not.toBeNull();
      expect(replacement?.instanceId).not.toBe(existing.instanceId);
      expect(info).toHaveBeenCalledWith(expect.stringContaining('caches invalidated'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('new instance started'));
    });

    it('restart does not spawn a competing process when shutdown times out', async () => {
      await start();
      const warn = vi.fn();
      const spawn = vi.fn();

      const result = await ensureWebMonitor(
        { publisher: makePublisher(), port: 0, host: '127.0.0.1', info: noop, warn },
        {
          ...envOptions,
          restart: true,
          kill: vi.fn(() => true) as unknown as typeof process.kill,
          isAlive: () => true,
          spawn,
          shutdownTimeoutMs: 25,
          claimPollIntervalMs: 5,
        },
      );

      expect(result).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not confirm shutdown'));
    });

    it('recovers a healthy orphan after the whole global root was deleted', async () => {
      const existing = await start();
      await rm(home, { recursive: true, force: true });
      const info = vi.fn();

      const recovered = await ensureWebMonitor(
        {
          publisher: makePublisher(),
          port: existing.port,
          host: '127.0.0.1',
          info,
          warn: noop,
        },
        {
          ...envOptions,
          inspectProcess: async () =>
            `node /opt/issue-flow/dist/cli.js web serve --port ${existing.port} --host 127.0.0.1`,
        },
      );
      if (recovered) handles.push(recovered);

      expect(recovered?.port).toBe(existing.port);
      expect((await readWebLock(getWebLockFile(envOptions)))?.pid).toBe(process.pid);
      expect(info).toHaveBeenCalledWith(expect.stringContaining('Recovered orphaned'));
    });

    it('leaves a monitor-like orphan untouched when process ownership is ambiguous', async () => {
      const existing = await start();
      await removeWebLock(getWebLockFile(envOptions));
      const warn = vi.fn();
      const kill = vi.fn();
      const spawn = vi.fn();

      const result = await ensureWebMonitor(
        {
          publisher: makePublisher(),
          port: existing.port,
          host: '127.0.0.1',
          info: noop,
          warn,
        },
        {
          ...envOptions,
          restart: true,
          kill,
          spawn,
          inspectProcess: async () => 'node unrelated-service.js',
          findPortOwner: async () => null,
        },
      );

      expect(result).toBeNull();
      expect(kill).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be verified'));
    });
  });

  it('stopWebMonitor cleans a dead lock without signalling an unrelated pid', async () => {
    const lockFile = getWebLockFile(envOptions);
    await writeFile(
      lockFile,
      JSON.stringify({
        pid: DEAD_PID,
        port: 59999,
        host: '127.0.0.1',
        startedAt: '2020-01-01T00:00:00Z',
      }),
      'utf-8',
    );
    const kill = vi.fn();

    const result = await stopWebMonitor(
      { port: 59999, host: '127.0.0.1', info: noop, warn: noop },
      { ...envOptions, kill },
    );

    expect(result).toBe('not-running');
    expect(kill).not.toHaveBeenCalled();
    expect(await readWebLock(lockFile)).toBeNull();
  });
});
