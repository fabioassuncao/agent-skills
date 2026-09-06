import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createPortProbe } from './services.js';

/**
 * The port probe against real sockets. It lives here rather than in the default
 * suite because it binds real ports on real loopback addresses — the boundary
 * `docs/` reserves for the integration configuration.
 *
 * The two families are the point of this file. A server bound only to `::1`
 * refuses `127.0.0.1` and vice versa, and the upstream probes both in parallel
 * precisely so that neither case reports a running service as down. A unit test
 * with a fake socket cannot show that.
 */

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listenOn(host: string): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  return address.port;
}

/** Whether this host has a usable IPv6 loopback at all. */
async function hasIpv6Loopback(): Promise<boolean> {
  try {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', () => resolve());
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return true;
  } catch {
    return false;
  }
}

const ipv6Available = await hasIpv6Loopback();

describe('createPortProbe', () => {
  it('sees a server bound to 127.0.0.1', async () => {
    const port = await listenOn('127.0.0.1');
    await expect(createPortProbe().isListening(port)).resolves.toBe(true);
  });

  // The whole reason `::1` is in the list: this exact case answers `false` on a
  // probe that only tries IPv4.
  it.runIf(ipv6Available)('sees a server bound only to ::1', async () => {
    const port = await listenOn('::1');
    await expect(createPortProbe().isListening(port)).resolves.toBe(true);
    await expect(createPortProbe({ hostnames: ['127.0.0.1'] }).isListening(port)).resolves.toBe(
      false,
    );
  });

  it('answers false for a port nobody listens on', async () => {
    // Bind, read the port, release it: an ephemeral port that was just freed is
    // the closest thing to a guaranteed-closed one.
    const port = await listenOn('127.0.0.1');
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));

    await expect(createPortProbe().isListening(port)).resolves.toBe(false);
  });

  it('answers within its ceiling rather than hanging on a black hole', async () => {
    // 198.51.100.0/24 is TEST-NET-2 (RFC 5737): routable-looking and guaranteed
    // to belong to nobody, so the connect neither completes nor is refused.
    const probe = createPortProbe({ timeoutMs: 120, hostnames: ['198.51.100.1'] });
    const started = Date.now();

    await expect(probe.isListening(9)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not leave the event loop holding a socket after it answers', async () => {
    const port = await listenOn('127.0.0.1');
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    const sockets = () =>
      process.getActiveResourcesInfo().filter((name) => name.includes('TCPWRAP')).length;

    await createPortProbe().isListening(port);
    await settle();
    const before = sockets();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await createPortProbe().isListening(port);
    }
    await settle();

    // Destroying every socket before resolving is the adaptation Node needs and
    // Bun did not: probes must not accumulate handles, or a CLI that checked a
    // few services would never exit.
    expect(sockets()).toBe(before);
  });
});
