import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import type { WebServerHandle } from '../web/server.js';

/**
 * `runWebServe` resolves its port through `loadWebConfig()`, whose schema
 * requires `port >= 1` — ephemeral port `0` (the shortcut every other web
 * test uses) fails that validation and silently falls back to the default.
 * Allocate and release a real free port instead.
 */
async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

// Wrap the real ensureSingleWebServer so tests can capture (and clean up)
// whatever `runWebServe` actually bound, the same pattern run.test.ts uses
// for startWebServer.
const serverHandles: WebServerHandle[] = [];
vi.mock('../web/lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/lock.js')>();
  return {
    ...actual,
    ensureSingleWebServer: vi.fn(
      async (...args: Parameters<typeof actual.ensureSingleWebServer>) => {
        const handle = await actual.ensureSingleWebServer(...args);
        if (handle) serverHandles.push(handle);
        return handle;
      },
    ),
  };
});

import {
  detectActiveInstance,
  ensureSingleWebServer,
  getWebLockFile,
  removeWebLock,
} from '../web/lock.js';
import { runWebServe, runWebStop } from './web.js';

describe('commands/web', () => {
  let home: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-web-cmd-'));
    // runWebServe/runWebStop call getWebLockFile()/loadWebConfig() with no
    // options, so isolation has to go through the real process.env, same
    // discipline storage/CLAUDE.md documents for command-level tests.
    savedEnv.set(GLOBAL_ROOT_ENV, process.env[GLOBAL_ROOT_ENV]);
    process.env[GLOBAL_ROOT_ENV] = home;
  });

  afterEach(async () => {
    await Promise.all(serverHandles.splice(0).map((h) => h.close()));
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });

  describe('runWebServe', () => {
    it('binds the server and answers /api/health', async () => {
      const code = await runWebServe({ port: await getFreePort(), host: '127.0.0.1' });
      expect(code).toBe(0);

      const handle = serverHandles[0];
      expect(handle).toBeDefined();
      expect(handle.server).toBeDefined();

      const res = await fetch(`${handle.url}/api/health`);
      expect(res.status).toBe(200);
    });

    it('claims the lock with this process pid', async () => {
      await runWebServe({ port: await getFreePort(), host: '127.0.0.1' });

      const lock = await detectActiveInstance(getWebLockFile());
      expect(lock?.pid).toBe(process.pid);
    });

    it('exits cleanly without binding when an instance is already active', async () => {
      const existing = await ensureSingleWebServer({
        port: 0,
        host: '127.0.0.1',
        info: () => {},
        warn: () => {},
      });
      expect(existing).not.toBeNull();

      const code = await runWebServe({ port: await getFreePort(), host: '127.0.0.1' });

      expect(code).toBe(0);
      // The reused instance never gets its own local Server: no second bind.
      const reused = serverHandles.at(-1);
      expect(reused?.server).toBeUndefined();
    });
  });

  describe('runWebStop', () => {
    it('reports no running instance when there is no lock', async () => {
      const code = await runWebStop();
      expect(code).toBe(0);
    });

    it('cleans up a lock referencing a dead process', async () => {
      const lockFile = getWebLockFile();
      await writeFile(
        lockFile,
        JSON.stringify({
          pid: 999999999,
          port: 3737,
          host: '127.0.0.1',
          startedAt: '2020-01-01T00:00:00Z',
        }),
        'utf-8',
      );

      const code = await runWebStop();

      expect(code).toBe(0);
      expect(await detectActiveInstance(lockFile)).toBeNull();
    });

    it('sends SIGTERM to the lock pid and waits for the lock to be removed', async () => {
      const lockFile = getWebLockFile();
      await writeFile(
        lockFile,
        JSON.stringify({
          pid: 4242,
          port: 3737,
          host: '127.0.0.1',
          startedAt: '2020-01-01T00:00:00Z',
        }),
        'utf-8',
      );
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
        pid: number,
        signal?: string | number,
      ) => {
        expect(pid).toBe(4242);
        expect(signal).toBe('SIGTERM');
        // Simulate the target's own graceful shutdown removing the lock —
        // the real signal handler lives in server.ts, exercised elsewhere.
        void removeWebLock(lockFile);
        return true;
      }) as typeof process.kill);

      try {
        const code = await runWebStop();
        expect(code).toBe(0);
      } finally {
        killSpy.mockRestore();
      }
    });

    it('returns non-zero when kill fails for a reason other than a dead process', async () => {
      const lockFile = getWebLockFile();
      await writeFile(
        lockFile,
        JSON.stringify({
          pid: 4242,
          port: 3737,
          host: '127.0.0.1',
          startedAt: '2020-01-01T00:00:00Z',
        }),
        'utf-8',
      );
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        const err = new Error('EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      });

      try {
        const code = await runWebStop();
        expect(code).toBe(1);
      } finally {
        killSpy.mockRestore();
      }
    });
  });
});
