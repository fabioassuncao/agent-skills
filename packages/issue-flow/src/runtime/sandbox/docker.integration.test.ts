import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  containerNamePrefix,
  createDockerGateway,
  DEFAULT_NETWORK_MODE,
  DEFAULT_PIDS_LIMIT,
  type DockerGateway,
  type LaunchContainerOpts,
} from './docker.js';

/**
 * The docker gateway against a real daemon.
 *
 * Covers what a pure function cannot: that the argument list `buildDockerRunArgs`
 * produces is one docker actually accepts, that `launchContainer` is idempotent
 * per branch — the property §45.2-H names explicitly — and, since phase 13, that
 * the hardening flags reach the container as the kernel sees them while the
 * operations they could plausibly break still work.
 *
 * Docker may well not be installed, and that is not a failure of either phase:
 * parity (C7) and the whole §14 threat model are proven by `docker.test.ts`
 * alone. The probe below therefore runs **synchronously at module load** —
 * `it.runIf` is evaluated while the file is being collected, so a flag assigned
 * in `beforeAll` would still be false and every case would skip in silence.
 */

const TEST_IMAGE = process.env.ISSUE_FLOW_SANDBOX_TEST_IMAGE ?? 'alpine:latest';

function probeDocker(): boolean {
  if (spawnSync('docker', ['version', '--format', '{{.Server.Version}}']).status !== 0) {
    return false;
  }
  if (spawnSync('docker', ['image', 'inspect', TEST_IMAGE]).status === 0) return true;
  // A single pull attempt, so a machine with a daemon but no image still runs
  // the suite. No network means no image means the cases skip, as intended.
  return spawnSync('docker', ['pull', TEST_IMAGE], { timeout: 120_000 }).status === 0;
}

const dockerAvailable = probeDocker();

/** Force-remove every container of a branch, whatever state the test left it in. */
function purge(branch: string): void {
  const prefix = containerNamePrefix(branch);
  const listed = spawnSync('docker', [
    'ps',
    '-a',
    '--filter',
    `name=${prefix}`,
    '--format',
    '{{.Names}}',
  ]);
  const names = String(listed.stdout ?? '')
    .trim()
    .split('\n')
    .filter(Boolean);
  if (names.length > 0) spawnSync('docker', ['rm', '-f', ...names]);
}

describe('docker gateway against a real daemon', () => {
  let gateway: DockerGateway;
  let root: string;
  let branch: string;
  const branches: string[] = [];
  const dirs: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'issue-flow-sandbox-'));
    dirs.push(root);
    // HOME points into the temporary tree: the credential and agent-config
    // mounts make docker create any missing host path, and doing that in the
    // developer's real home would be a side effect of running the suite.
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    await mkdir(join(root, 'worktree'), { recursive: true });
    gateway = createDockerGateway({ env: { HOME: join(root, 'home') } });
    branch = `it-${randomUUID().slice(0, 8)}`;
    branches.push(branch);
  });

  afterEach(async () => {
    for (const name of branches.splice(0)) purge(name);
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function opts(): LaunchContainerOpts {
    return {
      branch,
      wtDir: join(root, 'worktree'),
      mainRepoDir: join(root, 'repo'),
      sandboxConfig: { runtime: 'docker', image: TEST_IMAGE, envPassthrough: [] },
      services: [],
      runtimeEnv: { ISSUE_FLOW_BRANCH: branch },
    };
  }

  it.runIf(dockerAvailable)('reports the daemon as available', async () => {
    await expect(gateway.isAvailable()).resolves.toBe(true);
  });

  it.runIf(dockerAvailable)(
    'launches a container docker accepts',
    async () => {
      const name = await gateway.launchContainer(opts());
      expect(name.startsWith(containerNamePrefix(branch))).toBe(true);
      await expect(gateway.findContainer(branch)).resolves.toBe(name);
    },
    120_000,
  );

  it.runIf(dockerAvailable)(
    'is idempotent per branch: a second launch reuses the first',
    async () => {
      const first = await gateway.launchContainer(opts());
      const second = await gateway.launchContainer(opts());
      expect(second).toBe(first);

      const listed = spawnSync('docker', [
        'ps',
        '--filter',
        `name=${containerNamePrefix(branch)}`,
        '--format',
        '{{.Names}}',
      ]);
      expect(String(listed.stdout).trim().split('\n').filter(Boolean)).toHaveLength(1);
    },
    120_000,
  );

  it.runIf(dockerAvailable)(
    'removes every container of the branch',
    async () => {
      await gateway.launchContainer(opts());
      await gateway.removeContainer(branch);
      await expect(gateway.findContainer(branch)).resolves.toBeNull();
    },
    120_000,
  );

  it.runIf(dockerAvailable)('finds nothing for a branch that never had a container', async () => {
    await expect(gateway.findContainer(`absent-${randomUUID().slice(0, 8)}`)).resolves.toBeNull();
  });

  it.runIf(dockerAvailable)('removing a branch with no container is a no-op', async () => {
    await expect(
      gateway.removeContainer(`absent-${randomUUID().slice(0, 8)}`),
    ).resolves.toBeUndefined();
  });

  it.runIf(dockerAvailable)('refuses a profile with no image', async () => {
    await expect(
      gateway.launchContainer({
        ...opts(),
        sandboxConfig: { runtime: 'docker', image: '', envPassthrough: [] },
      }),
    ).rejects.toThrow('sandboxConfig.image is required');
  });

  it.runIf(dockerAvailable)(
    'reports a docker run failure with the daemon stderr',
    async () => {
      await expect(
        gateway.launchContainer({
          ...opts(),
          sandboxConfig: {
            runtime: 'docker',
            image: 'issue-flow-nonexistent-image:does-not-exist',
            envPassthrough: [],
          },
        }),
      ).rejects.toThrow(/docker run failed \(exit \d+\)/);
    },
    120_000,
  );

  /* ── phase 13: the hardening, as the daemon and the kernel see it ─────── */

  /** `docker inspect` of one container, as JSON. */
  function inspect(name: string): Record<string, unknown> {
    const out = spawnSync('docker', ['inspect', name], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    const [container] = JSON.parse(out.stdout) as Array<Record<string, unknown>>;
    return container as Record<string, unknown>;
  }

  /** Run a shell command inside a launched container and return its stdout. */
  function exec(name: string, script: string): { status: number | null; stdout: string } {
    const out = spawnSync('docker', ['exec', name, '/bin/sh', '-c', script], {
      encoding: 'utf8',
    });
    return { status: out.status, stdout: String(out.stdout ?? '') };
  }

  const hostConfig = (name: string) => inspect(name).HostConfig as Record<string, unknown>;

  it.runIf(dockerAvailable)(
    'the hardened argument list is one docker accepts, and the flags land',
    async () => {
      const name = await gateway.launchContainer(opts());
      const hc = hostConfig(name);

      expect(hc.CapDrop).toEqual(['ALL']);
      expect(hc.SecurityOpt).toContain('no-new-privileges:true');
      expect(hc.PidsLimit).toBe(DEFAULT_PIDS_LIMIT);
      expect(hc.NetworkMode).toBe(DEFAULT_NETWORK_MODE);
      expect(Number(hc.Memory)).toBeGreaterThan(0);
    },
    120_000,
  );

  it.runIf(dockerAvailable)(
    'no-new-privileges is set in the kernel, not just in the argument list',
    async () => {
      const name = await gateway.launchContainer(opts());
      // The flag's whole effect: a process in this container can no longer gain
      // privileges through a setuid binary, whatever the image ships.
      const { stdout } = exec(name, 'grep NoNewPrivs /proc/self/status');
      expect(stdout).toMatch(/NoNewPrivs:\s*1/);
    },
    120_000,
  );

  it.runIf(dockerAvailable)(
    'the agent can still write to its worktree under cap-drop=ALL',
    async () => {
      // The regression this guards against: a hardening flag that quietly costs
      // the sandbox the one thing it exists to do.
      const name = await gateway.launchContainer(opts());
      const wtDir = join(root, 'worktree');
      const written = exec(name, `printf hardened > ${wtDir}/proof.txt && cat ${wtDir}/proof.txt`);
      expect(written.status).toBe(0);
      expect(written.stdout).toBe('hardened');
      expect(readFileSync(join(wtDir, 'proof.txt'), 'utf8')).toBe('hardened');
    },
    120_000,
  );

  it.runIf(dockerAvailable)(
    'the agent can still spawn the processes a build needs under the pids limit',
    async () => {
      const name = await gateway.launchContainer(opts());
      // Fifty concurrent processes is far more than a build's steady state and
      // far below the limit: the point is that the limit is not in the way.
      const spawned = exec(name, 'for i in $(seq 1 50); do sleep 1 & done; wait; echo ok');
      expect(spawned.status).toBe(0);
      expect(spawned.stdout.trim()).toBe('ok');
    },
    120_000,
  );

  it.runIf(dockerAvailable)(
    'the pids limit actually stops a runaway',
    async () => {
      const name = await gateway.launchContainer({
        ...opts(),
        sandboxConfig: { ...opts().sandboxConfig, security: { pidsLimit: 16 } },
      });
      expect(hostConfig(name).PidsLimit).toBe(16);
      // Well past the limit: the shell fails to fork rather than the host
      // running out of process slots.
      const runaway = exec(name, 'i=0; while [ $i -lt 200 ]; do sleep 5 & i=$((i+1)); done');
      expect(runaway.status).not.toBe(0);
    },
    120_000,
  );

  it.runIf(dockerAvailable)(
    'network=none leaves the container with nothing but loopback',
    async () => {
      const name = await gateway.launchContainer({
        ...opts(),
        sandboxConfig: { ...opts().sandboxConfig, security: { network: 'none' } },
      });
      expect(hostConfig(name).NetworkMode).toBe('none');
      // Checked against the kernel's interface list rather than by reaching for
      // the internet, so the case means the same thing on a machine with no
      // network at all.
      const { stdout } = exec(name, 'ls /sys/class/net');
      expect(stdout.trim().split(/\s+/).filter(Boolean)).toEqual(['lo']);
    },
    120_000,
  );

  it.runIf(dockerAvailable)(
    'network=none with declared services still launches, without published ports',
    async () => {
      // docker refuses `--network none` together with `-p`. Dropping the ports
      // is what keeps an isolated profile launchable at all.
      const name = await gateway.launchContainer({
        ...opts(),
        sandboxConfig: { ...opts().sandboxConfig, security: { network: 'none' } },
        services: [{ name: 'web', portEnv: 'PORT' }],
        runtimeEnv: { PORT: '3111' },
      });
      expect(hostConfig(name).PortBindings).toEqual({});
    },
    120_000,
  );

  it.runIf(dockerAvailable)(
    'the default network still publishes a service port, on loopback only',
    async () => {
      const name = await gateway.launchContainer({
        ...opts(),
        services: [{ name: 'web', portEnv: 'PORT' }],
        runtimeEnv: { PORT: '3112' },
      });
      expect(hostConfig(name).PortBindings).toEqual({
        '3112/tcp': [{ HostIp: '127.0.0.1', HostPort: '3112' }],
      });
    },
    120_000,
  );

  it.runIf(dockerAvailable)(
    'SSH_AUTH_SOCK is not in the container unless the profile asked for it',
    async () => {
      const withSock = createDockerGateway({
        env: { HOME: join(root, 'home'), SSH_AUTH_SOCK: '/tmp/agent.sock' },
      });
      const name = await withSock.launchContainer(opts());
      const { stdout } = exec(name, 'env');
      expect(stdout).not.toContain('SSH_AUTH_SOCK');
    },
    120_000,
  );
});
