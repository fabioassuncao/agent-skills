import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  containerNamePrefix,
  createDockerGateway,
  type DockerGateway,
  type LaunchContainerOpts,
} from './docker.js';

/**
 * The docker gateway against a real daemon.
 *
 * Covers what a pure function cannot: that the argument list `buildDockerRunArgs`
 * produces is one docker actually accepts, and that `launchContainer` is
 * idempotent per branch — the property §45.2-H names explicitly.
 *
 * Docker may well not be installed, and that is not a failure of this phase:
 * parity (C7) is proven by `docker.test.ts` alone. The probe below therefore
 * runs **synchronously at module load** — `it.runIf` is evaluated while the file
 * is being collected, so a flag assigned in `beforeAll` would still be false and
 * every case would skip in silence.
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
});
