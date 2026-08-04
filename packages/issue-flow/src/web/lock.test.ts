import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryPublisher } from '../core/session-state.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import {
  detectActiveInstance,
  ensureSingleWebServer,
  getWebLockFile,
  readWebLock,
  removeWebLock,
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
});
