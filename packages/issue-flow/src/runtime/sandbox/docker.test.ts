import { describe, expect, it } from 'vitest';
import {
  buildDockerRunArgs,
  CONTAINER_NAME_PREFIX,
  containerName,
  containerNamePrefix,
  type LaunchContainerOpts,
  type SandboxProfileConfig,
  sanitizeBranchForName,
  selectBranchContainers,
} from './docker.js';

/**
 * The 23 upstream cases of `backend/src/__tests__/docker.test.ts` @ d8c9d5f,
 * translated from `bun:test` to `vitest`, plus **C7** of §34 — the literal
 * comparison of the whole `docker run` argument list — and the cases the
 * upstream could not write because it read `Bun.env` from inside the function.
 *
 * Everything here exercises a pure function, which is the point: the parity
 * criterion of phase 12 is verifiable on a machine with no docker installed.
 */

const HOME = '/home/testuser';
const UID = 1000;
const GID = 1000;

/** Minimal valid opts; individual tests override what they need. */
function makeDockerProfile(overrides: Partial<SandboxProfileConfig> = {}): SandboxProfileConfig {
  return {
    runtime: 'docker',
    image: 'my-image:latest',
    envPassthrough: [],
    ...overrides,
  };
}

function makeOpts(overrides: Partial<LaunchContainerOpts> = {}): LaunchContainerOpts {
  return {
    branch: 'my-branch',
    wtDir: '/repos/my-branch',
    mainRepoDir: '/repos/main',
    sandboxConfig: makeDockerProfile(),
    services: [],
    runtimeEnv: {},
    ...overrides,
  };
}

/** Shorthand: call buildDockerRunArgs with test defaults for the context. */
function build(
  opts: LaunchContainerOpts,
  existingPaths = new Set<string>(),
  sshAuthSock?: string,
  hostEnv: Record<string, string | undefined> = {},
  onWarn?: (message: string) => void,
): string[] {
  return buildDockerRunArgs(opts, {
    existingPaths,
    home: HOME,
    name: 'if-test-123',
    sshAuthSock,
    hostUid: UID,
    hostGid: GID,
    hostEnv,
    ...(onWarn === undefined ? {} : { onWarn }),
  });
}

/** Pull all values of one repeated flag out of an args array. */
function flagValues(args: string[], flag: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) result.push(args[i + 1] as string);
  }
  return result;
}

const mounts = (args: string[]) => flagValues(args, '-v');
const ports = (args: string[]) => flagValues(args, '-p');
const envFlags = (args: string[]) => flagValues(args, '-e');

// ---------------------------------------------------------------------------
// C7 — the whole argument list, compared literally
// ---------------------------------------------------------------------------

describe('C7 — docker run args are exactly the upstream ones', () => {
  it('produces the full argument list for a fully-configured launch', () => {
    const sock = '/run/user/1000/keyring/ssh';
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          image: 'sandbox:latest',
          envPassthrough: ['ANTHROPIC_API_KEY', 'HOME', 'not a key'],
          mounts: [
            { hostPath: '/data/cache', guestPath: '/mnt/cache', writable: true },
            { hostPath: '~/models' },
          ],
        }),
        services: [
          { name: 'web', portEnv: 'PORT' },
          { name: 'api', portEnv: 'API_PORT' },
        ],
        runtimeEnv: { PORT: '3000', API_PORT: '3001', ISSUE_FLOW_BRANCH: 'feat/63', HOME: '/evil' },
      }),
      new Set([`${HOME}/.gitconfig`, `${HOME}/.ssh`, `${HOME}/.config/gh`, sock]),
      sock,
      { ANTHROPIC_API_KEY: 'sk-test', HOME: '/home/testuser' },
    );

    expect(args).toEqual([
      'docker',
      'run',
      '-d',
      '--name',
      'if-test-123',
      '-w',
      '/repos/my-branch',
      '--add-host',
      'host.docker.internal:host-gateway',
      '--user',
      '1000:1000',
      '-p',
      '127.0.0.1:3000:3000',
      '-p',
      '127.0.0.1:3001:3001',
      '-e',
      'HOME=/root',
      '-e',
      'TERM=xterm-256color',
      '-e',
      'IS_SANDBOX=1',
      '-e',
      'GIT_CONFIG_COUNT=2',
      '-e',
      'GIT_CONFIG_KEY_0=safe.directory',
      '-e',
      'GIT_CONFIG_VALUE_0=/repos/my-branch',
      '-e',
      'GIT_CONFIG_KEY_1=safe.directory',
      '-e',
      'GIT_CONFIG_VALUE_1=/repos/main',
      '-e',
      'ANTHROPIC_API_KEY=sk-test',
      '-e',
      'PORT=3000',
      '-e',
      'API_PORT=3001',
      '-e',
      'ISSUE_FLOW_BRANCH=feat/63',
      '-v',
      '/repos/my-branch:/repos/my-branch',
      '-v',
      '/repos/main/.git:/repos/main/.git',
      '-v',
      '/repos/main:/repos/main:ro',
      '-v',
      '/home/testuser/.claude:/root/.claude',
      '-v',
      '/home/testuser/.claude.json:/root/.claude.json',
      '-v',
      '/home/testuser/.codex:/root/.codex',
      '-v',
      '/home/testuser/.gitconfig:/root/.gitconfig:ro',
      '-v',
      '/home/testuser/.ssh:/root/.ssh:ro',
      '-v',
      '/home/testuser/.config/gh:/root/.config/gh:ro',
      '--mount',
      'type=bind,source=/run/user/1000/keyring/ssh,target=/run/user/1000/keyring/ssh',
      '-e',
      'SSH_AUTH_SOCK=/run/user/1000/keyring/ssh',
      '-v',
      '/data/cache:/mnt/cache',
      '-v',
      '/home/testuser/models:/home/testuser/models:ro',
      'sandbox:latest',
      'sleep',
      'infinity',
    ]);
  });

  it('produces the minimal argument list when nothing optional is configured', () => {
    expect(build(makeOpts())).toEqual([
      'docker',
      'run',
      '-d',
      '--name',
      'if-test-123',
      '-w',
      '/repos/my-branch',
      '--add-host',
      'host.docker.internal:host-gateway',
      '--user',
      '1000:1000',
      '-e',
      'HOME=/root',
      '-e',
      'TERM=xterm-256color',
      '-e',
      'IS_SANDBOX=1',
      '-e',
      'GIT_CONFIG_COUNT=2',
      '-e',
      'GIT_CONFIG_KEY_0=safe.directory',
      '-e',
      'GIT_CONFIG_VALUE_0=/repos/my-branch',
      '-e',
      'GIT_CONFIG_KEY_1=safe.directory',
      '-e',
      'GIT_CONFIG_VALUE_1=/repos/main',
      '-v',
      '/repos/my-branch:/repos/my-branch',
      '-v',
      '/repos/main/.git:/repos/main/.git',
      '-v',
      '/repos/main:/repos/main:ro',
      '-v',
      '/home/testuser/.claude:/root/.claude',
      '-v',
      '/home/testuser/.claude.json:/root/.claude.json',
      '-v',
      '/home/testuser/.codex:/root/.codex',
      'my-image:latest',
      'sleep',
      'infinity',
    ]);
  });

  it('is pure: the same input produces the same list, twice', () => {
    const opts = makeOpts({ runtimeEnv: { A: '1' } });
    expect(build(opts)).toEqual(build(opts));
  });

  it('adds no hardening flags — that is phase 13 (ADR-12)', () => {
    const args = build(makeOpts());
    for (const flag of ['--cap-drop', '--security-opt', '--pids-limit', '--memory', '--network']) {
      expect(args).not.toContain(flag);
    }
  });

  it('never mounts the docker socket', () => {
    const args = build(makeOpts(), new Set(['/var/run/docker.sock']), undefined, {});
    expect(args.join('\n')).not.toContain('docker.sock');
  });
});

// ---------------------------------------------------------------------------
// --user flag
// ---------------------------------------------------------------------------

describe('buildDockerRunArgs — host user mapping', () => {
  it('passes --user with host UID:GID', () => {
    const args = build(makeOpts());
    const idx = args.indexOf('--user');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe(`${UID}:${GID}`);
  });
});

// ---------------------------------------------------------------------------
// extraMounts
// ---------------------------------------------------------------------------

describe('buildDockerRunArgs — extraMounts', () => {
  it('adds a read-only mount when writable is false', () => {
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          image: 'img',
          mounts: [{ hostPath: '/data/shared', guestPath: '/mnt/shared', writable: false }],
        }),
      }),
    );
    expect(mounts(args)).toContain('/data/shared:/mnt/shared:ro');
  });

  it('adds a writable mount when writable is true', () => {
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          image: 'img',
          mounts: [{ hostPath: '/data/shared', guestPath: '/mnt/shared', writable: true }],
        }),
      }),
    );
    expect(mounts(args)).toContain('/data/shared:/mnt/shared');
    expect(mounts(args)).not.toContain('/data/shared:/mnt/shared:ro');
  });

  it('defaults to read-only when writable is omitted', () => {
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          image: 'img',
          mounts: [{ hostPath: '/data/shared', guestPath: '/mnt/shared' }],
        }),
      }),
    );
    expect(mounts(args)).toContain('/data/shared:/mnt/shared:ro');
  });

  it('uses hostPath as guestPath when guestPath is omitted', () => {
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({ image: 'img', mounts: [{ hostPath: '/data/shared' }] }),
      }),
    );
    expect(mounts(args)).toContain('/data/shared:/data/shared:ro');
  });

  it('expands ~ to the home directory', () => {
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          image: 'img',
          mounts: [{ hostPath: '~/projects', guestPath: '/root/projects' }],
        }),
      }),
    );
    expect(mounts(args)).toContain(`${HOME}/projects:/root/projects:ro`);
  });

  it('skips mounts with non-absolute paths after ~ expansion', () => {
    const warnings: string[] = [];
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          image: 'img',
          mounts: [{ hostPath: 'relative/path', guestPath: '/mnt/data' }],
        }),
      }),
      new Set(),
      undefined,
      {},
      (message) => warnings.push(message),
    );
    expect(mounts(args).join('\n')).not.toContain('/mnt/data');
    expect(warnings).toContain(
      '[docker] skipping mount with non-absolute host path: "relative/path"',
    );
  });

  it('includes multiple extra mounts in order', () => {
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          image: 'img',
          mounts: [
            { hostPath: '/data/a', guestPath: '/mnt/a', writable: true },
            { hostPath: '/data/b', guestPath: '/mnt/b' },
          ],
        }),
      }),
    );
    const m = mounts(args);
    expect(m).toContain('/data/a:/mnt/a');
    expect(m).toContain('/data/b:/mnt/b:ro');
    expect(m.indexOf('/data/a:/mnt/a')).toBeLessThan(m.indexOf('/data/b:/mnt/b:ro'));
  });
});

// ---------------------------------------------------------------------------
// extraMounts conflict resolution: config wins over credential defaults
// ---------------------------------------------------------------------------

describe('buildDockerRunArgs — extraMounts override credential mounts', () => {
  it('config ~/.ssh writable overrides the default read-only credential mount', () => {
    const existingPaths = new Set([`${HOME}/.ssh`]);
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          image: 'img',
          mounts: [{ hostPath: '~/.ssh', guestPath: '/root/.ssh', writable: true }],
        }),
      }),
      existingPaths,
    );
    const m = mounts(args);
    expect(m).toContain(`${HOME}/.ssh:/root/.ssh`);
    expect(m).not.toContain(`${HOME}/.ssh:/root/.ssh:ro`);
  });

  it('config ~/.ssh read-only still suppresses the credential mount (config controls it)', () => {
    const existingPaths = new Set([`${HOME}/.ssh`]);
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          image: 'img',
          mounts: [{ hostPath: '~/.ssh', guestPath: '/root/.ssh', writable: false }],
        }),
      }),
      existingPaths,
    );
    const sshMounts = mounts(args).filter((v) => v.includes('/root/.ssh'));
    expect(sshMounts).toHaveLength(1);
    expect(sshMounts[0]).toBe(`${HOME}/.ssh:/root/.ssh:ro`);
  });

  it('config ~/.gitconfig override does not affect unrelated credential mounts', () => {
    const existingPaths = new Set([`${HOME}/.gitconfig`, `${HOME}/.ssh`]);
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          image: 'img',
          mounts: [{ hostPath: '~/.gitconfig', guestPath: '/root/.gitconfig', writable: true }],
        }),
      }),
      existingPaths,
    );
    const m = mounts(args);
    expect(m).toContain(`${HOME}/.gitconfig:/root/.gitconfig`);
    expect(m).not.toContain(`${HOME}/.gitconfig:/root/.gitconfig:ro`);
    expect(m).toContain(`${HOME}/.ssh:/root/.ssh:ro`);
  });

  it('credential mounts are included normally when there are no extraMounts', () => {
    const existingPaths = new Set([`${HOME}/.gitconfig`, `${HOME}/.ssh`]);
    const m = mounts(build(makeOpts(), existingPaths));
    expect(m).toContain(`${HOME}/.gitconfig:/root/.gitconfig:ro`);
    expect(m).toContain(`${HOME}/.ssh:/root/.ssh:ro`);
  });

  it('credential mounts are omitted for paths that do not exist on the host', () => {
    const m = mounts(build(makeOpts()));
    expect(m).not.toContain(`${HOME}/.gitconfig:/root/.gitconfig:ro`);
    expect(m).not.toContain(`${HOME}/.ssh:/root/.ssh:ro`);
  });
});

// ---------------------------------------------------------------------------
// Port handling
// ---------------------------------------------------------------------------

describe('buildDockerRunArgs — ports', () => {
  it('binds valid ports to loopback only', () => {
    const args = build(
      makeOpts({
        services: [{ name: 'web', portEnv: 'PORT' }],
        runtimeEnv: { PORT: '3000' },
      }),
    );
    expect(ports(args)).toContain('127.0.0.1:3000:3000');
  });

  it('skips ports with non-numeric values', () => {
    const warnings: string[] = [];
    const args = build(
      makeOpts({
        services: [{ name: 'web', portEnv: 'PORT' }],
        runtimeEnv: { PORT: 'auto' },
      }),
      new Set(),
      undefined,
      {},
      (message) => warnings.push(message),
    );
    expect(ports(args)).toHaveLength(0);
    expect(warnings).toContain('[docker] skipping invalid port for PORT: "auto"');
  });

  it('deduplicates ports that appear more than once', () => {
    const args = build(
      makeOpts({
        services: [
          { name: 'web', portEnv: 'PORT' },
          { name: 'api', portEnv: 'API_PORT' },
        ],
        runtimeEnv: { PORT: '3000', API_PORT: '3000' },
      }),
    );
    expect(ports(args).filter((p) => p.startsWith('127.0.0.1:3000'))).toHaveLength(1);
  });

  it('never binds a published port to a non-loopback interface', () => {
    const args = build(
      makeOpts({
        services: [{ name: 'web', portEnv: 'PORT' }],
        runtimeEnv: { PORT: '8080' },
      }),
    );
    expect(ports(args).every((p) => p.startsWith('127.0.0.1:'))).toBe(true);
    expect(args.join('\n')).not.toContain('0.0.0.0');
  });
});

// ---------------------------------------------------------------------------
// Reserved env var protection
// ---------------------------------------------------------------------------

describe('buildDockerRunArgs — reserved env vars', () => {
  it('HOME from runtime env does not override the hardcoded HOME=/root', () => {
    const flags = envFlags(build(makeOpts({ runtimeEnv: { HOME: '/attacker' } })));
    expect(flags).toContain('HOME=/root');
    expect(flags).not.toContain('HOME=/attacker');
  });

  it('IS_SANDBOX from runtime env is silently dropped', () => {
    const flags = envFlags(build(makeOpts({ runtimeEnv: { IS_SANDBOX: '0' } })));
    expect(flags).toContain('IS_SANDBOX=1');
    expect(flags.filter((f) => f.startsWith('IS_SANDBOX='))).toHaveLength(1);
  });

  it('does not inject legacy workmux rpc env vars', () => {
    const flags = envFlags(build(makeOpts()));
    expect(flags.some((flag) => flag.startsWith('WORKMUX_RPC_'))).toBe(false);
  });

  it('every GIT_CONFIG reserved key resists both passthrough and runtime env', () => {
    const flags = envFlags(
      build(
        makeOpts({
          sandboxConfig: makeDockerProfile({
            image: 'img',
            envPassthrough: ['GIT_CONFIG_COUNT', 'GIT_CONFIG_VALUE_0'],
          }),
          runtimeEnv: { GIT_CONFIG_COUNT: '9', GIT_CONFIG_KEY_1: 'core.pager' },
        }),
        new Set(),
        undefined,
        { GIT_CONFIG_COUNT: '9', GIT_CONFIG_VALUE_0: '/evil' },
      ),
    );
    expect(flags.filter((f) => f.startsWith('GIT_CONFIG_COUNT='))).toEqual(['GIT_CONFIG_COUNT=2']);
    expect(flags).toContain('GIT_CONFIG_VALUE_0=/repos/my-branch');
    expect(flags).toContain('GIT_CONFIG_KEY_1=safe.directory');
    expect(flags).not.toContain('GIT_CONFIG_KEY_1=core.pager');
  });

  it('safe.directory covers both the worktree and the main repository', () => {
    const flags = envFlags(build(makeOpts()));
    expect(flags).toContain('GIT_CONFIG_COUNT=2');
    expect(flags).toContain('GIT_CONFIG_VALUE_0=/repos/my-branch');
    expect(flags).toContain('GIT_CONFIG_VALUE_1=/repos/main');
  });

  it('drops runtime env keys that are not valid variable names', () => {
    const warnings: string[] = [];
    const flags = envFlags(
      build(
        makeOpts({ runtimeEnv: { '1BAD': 'x', 'a-b': 'y', GOOD_KEY: 'z' } }),
        new Set(),
        undefined,
        {},
        (message) => warnings.push(message),
      ),
    );
    expect(flags).toContain('GOOD_KEY=z');
    expect(flags.join('\n')).not.toContain('1BAD');
    expect(flags.join('\n')).not.toContain('a-b');
    expect(warnings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// envPassthrough — reads `hostEnv`, never the process (see DockerRunArgsContext)
// ---------------------------------------------------------------------------

describe('buildDockerRunArgs — envPassthrough', () => {
  it('forwards an allowlisted key with the host value', () => {
    const flags = envFlags(
      build(
        makeOpts({
          sandboxConfig: makeDockerProfile({ image: 'img', envPassthrough: ['ANTHROPIC_API_KEY'] }),
        }),
        new Set(),
        undefined,
        { ANTHROPIC_API_KEY: 'sk-test' },
      ),
    );
    expect(flags).toContain('ANTHROPIC_API_KEY=sk-test');
  });

  it('omits an allowlisted key the host does not define', () => {
    const flags = envFlags(
      build(
        makeOpts({
          sandboxConfig: makeDockerProfile({ image: 'img', envPassthrough: ['MISSING_KEY'] }),
        }),
      ),
    );
    expect(flags.join('\n')).not.toContain('MISSING_KEY');
  });

  it('drops a malformed passthrough key with a warning', () => {
    const warnings: string[] = [];
    const flags = envFlags(
      build(
        makeOpts({
          sandboxConfig: makeDockerProfile({ image: 'img', envPassthrough: ['not a key'] }),
        }),
        new Set(),
        undefined,
        { 'not a key': 'value' },
        (message) => warnings.push(message),
      ),
    );
    expect(flags.join('\n')).not.toContain('not a key');
    expect(warnings).toContain('[docker] skipping invalid envPassthrough key: "not a key"');
  });

  it('reads no process state: an unrelated process variable never leaks in', () => {
    process.env.ISSUE_FLOW_DOCKER_TEST_LEAK = 'leaked';
    try {
      const flags = envFlags(
        build(
          makeOpts({
            sandboxConfig: makeDockerProfile({
              image: 'img',
              envPassthrough: ['ISSUE_FLOW_DOCKER_TEST_LEAK'],
            }),
          }),
        ),
      );
      expect(flags.join('\n')).not.toContain('leaked');
    } finally {
      delete process.env.ISSUE_FLOW_DOCKER_TEST_LEAK;
    }
  });
});

// ---------------------------------------------------------------------------
// SSH agent forwarding
// ---------------------------------------------------------------------------

describe('buildDockerRunArgs — SSH agent forwarding', () => {
  const SOCK = '/run/user/1000/keyring/ssh';

  it('mounts the socket via --mount and sets SSH_AUTH_SOCK when present', () => {
    const args = build(makeOpts(), new Set([SOCK]), SOCK);
    expect(args).toContain(`type=bind,source=${SOCK},target=${SOCK}`);
    expect(envFlags(args)).toContain(`SSH_AUTH_SOCK=${SOCK}`);
  });

  it('never forwards the socket with -v, which would make docker mkdir the path', () => {
    const args = build(makeOpts(), new Set([SOCK]), SOCK);
    expect(mounts(args).join('\n')).not.toContain(SOCK);
    const idx = args.indexOf(`type=bind,source=${SOCK},target=${SOCK}`);
    expect(args[idx - 1]).toBe('--mount');
  });

  it('does nothing when sshAuthSock is undefined', () => {
    const args = build(makeOpts(), new Set(), undefined);
    expect(mounts(args).join('\n')).not.toContain('SSH_AUTH_SOCK');
    expect(envFlags(args).join('\n')).not.toContain('SSH_AUTH_SOCK');
  });

  it('does nothing when socket path is not in existingPaths', () => {
    const args = build(makeOpts(), new Set(), SOCK);
    expect(mounts(args).join('\n')).not.toContain(SOCK);
    expect(envFlags(args).join('\n')).not.toContain('SSH_AUTH_SOCK');
  });

  it('SSH_AUTH_SOCK from envPassthrough is blocked by reservedKeys', () => {
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({ image: 'img', envPassthrough: ['SSH_AUTH_SOCK'] }),
      }),
      new Set(),
      undefined,
      { SSH_AUTH_SOCK: '/tmp/attacker.sock' },
    );
    expect(envFlags(args).filter((f) => f.startsWith('SSH_AUTH_SOCK='))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Container naming and selection
// ---------------------------------------------------------------------------

describe('container naming', () => {
  it('replaces characters docker refuses in a name', () => {
    expect(sanitizeBranchForName('feat/63-add:thing')).toBe('feat-63-add-thing');
  });

  it('collapses runs of dashes and trims the ends', () => {
    expect(sanitizeBranchForName('--a///b--')).toBe('a-b');
  });

  it('falls back to "x" when nothing survives sanitisation', () => {
    expect(sanitizeBranchForName('///')).toBe('x');
  });

  it('caps the branch segment at 46 characters, keeping the name within 63', () => {
    const name = containerName('a'.repeat(80), 1_757_160_000_000);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(sanitizeBranchForName('a'.repeat(80))).toHaveLength(46);
  });

  it('is prefixed for this project, not for the upstream', () => {
    expect(CONTAINER_NAME_PREFIX).toBe('if-');
    expect(CONTAINER_NAME_PREFIX).toHaveLength(3);
    expect(containerName('my-branch', 1_757_160_000_000)).toBe('if-my-branch-1757160000000');
  });

  it('matches only names whose suffix is exactly the timestamp', () => {
    const prefix = containerNamePrefix('main');
    expect(prefix).toBe('if-main-');
    const listed = ['if-main-1757160000000', 'if-main-v2-1757160000001', 'if-main-abc', ''].join(
      '\n',
    );
    expect(selectBranchContainers(listed, prefix)).toEqual(['if-main-1757160000000']);
  });

  it('keeps the newest-first order docker ps returns', () => {
    const prefix = containerNamePrefix('main');
    const listed = 'if-main-3\nif-main-2\nif-main-1';
    expect(selectBranchContainers(listed, prefix)).toEqual(['if-main-3', 'if-main-2', 'if-main-1']);
  });

  it('returns nothing for empty output', () => {
    expect(selectBranchContainers('', containerNamePrefix('main'))).toEqual([]);
  });
});
