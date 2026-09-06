import { describe, expect, it } from 'vitest';
import {
  buildDockerRunArgs,
  CONTAINER_NAME_PREFIX,
  containerName,
  containerNamePrefix,
  DEFAULT_MEMORY_FRACTION,
  DEFAULT_NETWORK_MODE,
  DEFAULT_PIDS_LIMIT,
  isDockerSocketPath,
  isSecretLikeEnvKey,
  type LaunchContainerOpts,
  resolveCapAdd,
  resolveMemoryLimit,
  resolveNetworkMode,
  resolvePidsLimit,
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
 * criterion of phase 12 and the hardened baseline of phase 13 are both
 * verifiable on a machine with no docker installed.
 *
 * **C7 no longer matches the upstream, on purpose.** Phase 12 froze the
 * argument list as WebMux produces it; phase 13 hardens it, and §14 stage 2 is
 * precisely a list of things the upstream does not do. The test was not
 * weakened — it still compares the whole list literally — but the baseline it
 * compares against is now this project's, and every difference from the
 * upstream is enumerated in `docker run args differ from the upstream` below.
 */

const HOME = '/home/testuser';
const UID = 1000;
const GID = 1000;
/** 8 GiB, so the default `--memory` is a fixed `6144m` rather than this machine's. */
const HOST_MEMORY_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_MEMORY_FLAG = '6144m';

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
    hostTotalMemoryBytes: HOST_MEMORY_BYTES,
    ...(onWarn === undefined ? {} : { onWarn }),
  });
}

/** The hardening block every launch carries, in the order it is emitted. */
const HARDENING_ARGS = [
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--pids-limit',
  '2048',
  '--memory',
  DEFAULT_MEMORY_FLAG,
  '--network',
  'bridge',
];

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
//
// The baseline was the upstream's through phase 12 and is this project's
// hardened one since phase 13. Same comparison, new expected value.
// ---------------------------------------------------------------------------

describe('C7 — docker run args are exactly the hardened baseline', () => {
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
          security: { sshAgent: true },
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
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '2048',
      '--memory',
      DEFAULT_MEMORY_FLAG,
      '--network',
      'bridge',
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
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '2048',
      '--memory',
      DEFAULT_MEMORY_FLAG,
      '--network',
      'bridge',
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

  /**
   * Phase 12 asserted the *absence* of these five flags, as a tripwire against
   * hardening during a parity port (ADR-12). Phase 13 is that hardening, so the
   * tripwire inverts: the same five flags are now required, and the case still
   * fails loudly if one silently disappears.
   */
  it('carries every phase 13 hardening flag (was: asserted their absence)', () => {
    const args = build(makeOpts());
    for (const flag of ['--cap-drop', '--security-opt', '--pids-limit', '--memory', '--network']) {
      expect(args).toContain(flag);
    }
  });

  /**
   * The complete, enumerated divergence from `.references/webmux-main/backend/
   * src/adapters/docker.ts` @ d8c9d5f. C7 stopped matching the upstream here and
   * nowhere else; anything not on this list is still literally the upstream's.
   */
  it('docker run args differ from the upstream in exactly the §14 hardenings', () => {
    const sock = '/run/user/1000/keyring/ssh';
    const existing = new Set([`${HOME}/.ssh`, sock]);

    // 1. Added: --cap-drop=ALL, no-new-privileges, --pids-limit, --memory,
    //    --network — as one block, right after --user.
    const args = build(makeOpts());
    const userIdx = args.indexOf('--user');
    expect(args.slice(userIdx + 2, userIdx + 2 + HARDENING_ARGS.length)).toEqual(HARDENING_ARGS);

    // 2. Changed default: the upstream forwards SSH_AUTH_SOCK whenever the
    //    socket exists. Here it takes an explicit opt-in.
    const withoutOptIn = build(makeOpts(), existing, sock);
    expect(withoutOptIn.join('\n')).not.toContain(sock);
    const withOptIn = build(
      makeOpts({ sandboxConfig: makeDockerProfile({ security: { sshAgent: true } }) }),
      existing,
      sock,
    );
    expect(withOptIn).toContain(`type=bind,source=${sock},target=${sock}`);

    // 3. Changed default: nothing. The implicit credential mounts the upstream
    //    adds are still added — deprecated and reported, not removed.
    expect(mounts(build(makeOpts(), existing))).toContain(`${HOME}/.ssh:/root/.ssh:ro`);

    // 4. Added: a profile mount of a runtime socket is refused outright.
    const socketMount = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          mounts: [{ hostPath: '/var/run/docker.sock', writable: true }],
        }),
      }),
    );
    expect(socketMount.join('\n')).not.toContain('docker.sock');

    // 5. Unchanged: everything else. The tail of the list — image and command —
    //    is still the upstream's, and so is the order of what precedes it.
    expect(args.slice(-3)).toEqual(['my-image:latest', 'sleep', 'infinity']);
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
    // One per dropped key. Filtered because phase 13 added warnings of its own
    // (the deprecated implicit mounts) that this case is not about.
    expect(warnings.filter((w) => w.includes('invalid runtime env key'))).toHaveLength(2);
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
  /** Since phase 13 the forwarding is opt-in; the mechanics below are unchanged. */
  const optedIn = (overrides: Partial<SandboxProfileConfig> = {}) =>
    makeOpts({ sandboxConfig: makeDockerProfile({ ...overrides, security: { sshAgent: true } }) });

  it('mounts the socket via --mount and sets SSH_AUTH_SOCK when present', () => {
    const args = build(optedIn(), new Set([SOCK]), SOCK);
    expect(args).toContain(`type=bind,source=${SOCK},target=${SOCK}`);
    expect(envFlags(args)).toContain(`SSH_AUTH_SOCK=${SOCK}`);
  });

  it('never forwards the socket with -v, which would make docker mkdir the path', () => {
    const args = build(optedIn(), new Set([SOCK]), SOCK);
    expect(mounts(args).join('\n')).not.toContain(SOCK);
    const idx = args.indexOf(`type=bind,source=${SOCK},target=${SOCK}`);
    expect(args[idx - 1]).toBe('--mount');
  });

  it('does nothing when sshAuthSock is undefined', () => {
    const args = build(optedIn(), new Set(), undefined);
    expect(mounts(args).join('\n')).not.toContain('SSH_AUTH_SOCK');
    expect(envFlags(args).join('\n')).not.toContain('SSH_AUTH_SOCK');
  });

  it('does nothing when socket path is not in existingPaths', () => {
    const args = build(optedIn(), new Set(), SOCK);
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

  // ── phase 13: the opt-in itself ──
  it('is not forwarded by default, even when the socket exists and is vetted', () => {
    const args = build(makeOpts(), new Set([SOCK]), SOCK);
    expect(args.join('\n')).not.toContain(SOCK);
    expect(envFlags(args).join('\n')).not.toContain('SSH_AUTH_SOCK');
  });

  it('is not forwarded when the profile opts out explicitly', () => {
    const args = build(
      makeOpts({ sandboxConfig: makeDockerProfile({ security: { sshAgent: false } }) }),
      new Set([SOCK]),
      SOCK,
    );
    expect(args.join('\n')).not.toContain(SOCK);
  });

  it('signing still works for the profile that asks: mount and variable both arrive', () => {
    const args = build(optedIn(), new Set([SOCK]), SOCK);
    const idx = args.indexOf('--mount');
    expect(args[idx + 1]).toBe(`type=bind,source=${SOCK},target=${SOCK}`);
    expect(envFlags(args)).toContain(`SSH_AUTH_SOCK=${SOCK}`);
  });
});

// ---------------------------------------------------------------------------
// Phase 13 — the §14 threat model, hardening by hardening
//
// Every block below asserts two things: that the flag is in the argument list,
// and that the legitimate operation it could plausibly break is still expressed
// by that same list. A `--cap-drop` that stopped the agent from writing to its
// worktree would be a regression wearing a security flag.
// ---------------------------------------------------------------------------

describe('hardening — capabilities', () => {
  it('drops every capability by default', () => {
    const args = build(makeOpts());
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
  });

  it('still runs as the host user, so the mounted worktree stays writable', () => {
    // The uid mapping is what makes writes work; capabilities were never part
    // of it. Dropping them cannot cost the agent its own worktree.
    const args = build(makeOpts());
    expect(args[args.indexOf('--user') + 1]).toBe(`${UID}:${GID}`);
    expect(mounts(args)).toContain('/repos/my-branch:/repos/my-branch');
    expect(mounts(args)).toContain('/repos/main/.git:/repos/main/.git');
  });

  it('grants back exactly the capabilities a profile names, normalised', () => {
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          security: { capAdd: ['net_admin', 'CAP_SYS_PTRACE', 'NET_ADMIN'] },
        }),
      }),
    );
    expect(flagValues(args, '--cap-add')).toEqual(['NET_ADMIN', 'CAP_SYS_PTRACE']);
  });

  it('drops a capAdd entry that is not a capability name, with a warning', () => {
    const warnings: string[] = [];
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({ security: { capAdd: ['--privileged', 'NET_ADMIN'] } }),
      }),
      new Set(),
      undefined,
      {},
      (message) => warnings.push(message),
    );
    expect(flagValues(args, '--cap-add')).toEqual(['NET_ADMIN']);
    expect(warnings).toContain('[docker] skipping invalid capAdd entry: "--privileged"');
  });

  it('resolveCapAdd is empty when a profile says nothing', () => {
    expect(resolveCapAdd(undefined, () => {})).toEqual([]);
  });
});

describe('hardening — no-new-privileges', () => {
  it('is set by default', () => {
    const args = build(makeOpts());
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges:true');
  });

  it('can be declined by a profile that needs setuid inside the container', () => {
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({ security: { noNewPrivileges: false } }),
      }),
    );
    expect(args).not.toContain('--security-opt');
    // Declining one flag must not quietly decline the rest of the block.
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args).toContain('--pids-limit');
  });
});

describe('hardening — resource limits', () => {
  it('caps the process table by default', () => {
    expect(build(makeOpts())[build(makeOpts()).indexOf('--pids-limit') + 1]).toBe(
      String(DEFAULT_PIDS_LIMIT),
    );
  });

  it('leaves headroom a real build needs: the default is in the thousands', () => {
    // A `npm ci` with native modules or a Chromium run peaks in the low
    // hundreds. A default that could not fit one would be the regression.
    expect(DEFAULT_PIDS_LIMIT).toBeGreaterThanOrEqual(1024);
  });

  it('honours a profile pids limit and omits the flag for a non-positive one', () => {
    const withLimit = build(
      makeOpts({ sandboxConfig: makeDockerProfile({ security: { pidsLimit: 64 } }) }),
    );
    expect(withLimit[withLimit.indexOf('--pids-limit') + 1]).toBe('64');
    expect(resolvePidsLimit({ pidsLimit: 0 })).toBeUndefined();
    expect(resolvePidsLimit({ pidsLimit: -1 })).toBeUndefined();
    expect(resolvePidsLimit({ pidsLimit: 1.5 })).toBeUndefined();
    expect(resolvePidsLimit(undefined)).toBe(DEFAULT_PIDS_LIMIT);
  });

  it('defaults memory to a share of the host rather than a fixed number', () => {
    const args = build(makeOpts());
    expect(args[args.indexOf('--memory') + 1]).toBe(DEFAULT_MEMORY_FLAG);
    // Which is the point: on a bigger machine the limit is bigger, so the flag
    // never becomes the reason a build that fits the host gets OOM-killed.
    expect(resolveMemoryLimit(undefined, 64 * 1024 * 1024 * 1024)).toBe('49152m');
    expect(DEFAULT_MEMORY_FRACTION).toBeLessThan(1);
  });

  it('honours an explicit memory value verbatim, and "0" means no limit', () => {
    const args = build(
      makeOpts({ sandboxConfig: makeDockerProfile({ security: { memory: '2g' } }) }),
    );
    expect(args[args.indexOf('--memory') + 1]).toBe('2g');
    expect(resolveMemoryLimit({ memory: '0' }, HOST_MEMORY_BYTES)).toBeUndefined();
    expect(
      build(makeOpts({ sandboxConfig: makeDockerProfile({ security: { memory: '0' } }) })),
    ).not.toContain('--memory');
  });

  it('omits the flag rather than emitting one docker would reject', () => {
    expect(resolveMemoryLimit(undefined, 0)).toBeUndefined();
    expect(resolveMemoryLimit(undefined, Number.NaN)).toBeUndefined();
    expect(resolveMemoryLimit(undefined, 1024)).toBeUndefined();
  });
});

describe('hardening — network policy', () => {
  it('writes the default network explicitly instead of inheriting the daemon default', () => {
    const args = build(makeOpts());
    expect(args[args.indexOf('--network') + 1]).toBe(DEFAULT_NETWORK_MODE);
    expect(DEFAULT_NETWORK_MODE).toBe('bridge');
  });

  it('an agent on the default profile still reaches the network and publishes ports', () => {
    const args = build(
      makeOpts({
        services: [{ name: 'web', portEnv: 'PORT' }],
        runtimeEnv: { PORT: '3000' },
      }),
    );
    expect(args[args.indexOf('--network') + 1]).toBe('bridge');
    expect(ports(args)).toEqual(['127.0.0.1:3000:3000']);
  });

  it('isolates the container when the profile asks for it', () => {
    const args = build(
      makeOpts({ sandboxConfig: makeDockerProfile({ security: { network: 'none' } }) }),
    );
    expect(args[args.indexOf('--network') + 1]).toBe('none');
  });

  it('drops published ports under network=none, which docker would refuse to combine', () => {
    const warnings: string[] = [];
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({ security: { network: 'none' } }),
        services: [{ name: 'web', portEnv: 'PORT' }],
        runtimeEnv: { PORT: '3000' },
      }),
      new Set(),
      undefined,
      {},
      (message) => warnings.push(message),
    );
    expect(ports(args)).toEqual([]);
    expect(warnings).toContain('[docker] not publishing port 3000 for PORT: network is "none"');
  });

  it('resolveNetworkMode falls back to the default for anything unrecognised', () => {
    expect(resolveNetworkMode(undefined)).toBe('bridge');
    expect(resolveNetworkMode({})).toBe('bridge');
    expect(resolveNetworkMode({ network: 'none' })).toBe('none');
  });
});

describe('hardening — envPassthrough is reported, never silently forwarded', () => {
  it('names every key it forwarded', () => {
    const warnings: string[] = [];
    build(
      makeOpts({
        sandboxConfig: makeDockerProfile({ envPassthrough: ['ANTHROPIC_API_KEY', 'CI'] }),
      }),
      new Set(),
      undefined,
      { ANTHROPIC_API_KEY: 'sk-secret-value', CI: 'true' },
      (message) => warnings.push(message),
    );
    expect(warnings).toContain(
      '[docker] forwarding host environment into the sandbox: ANTHROPIC_API_KEY, CI',
    );
  });

  it('flags the credential-shaped ones separately', () => {
    const warnings: string[] = [];
    build(
      makeOpts({
        sandboxConfig: makeDockerProfile({ envPassthrough: ['GITHUB_TOKEN', 'CI'] }),
      }),
      new Set(),
      undefined,
      { GITHUB_TOKEN: 'ghp_secret', CI: 'true' },
      (message) => warnings.push(message),
    );
    expect(warnings.join('\n')).toContain('credential-shaped keys');
    expect(warnings.join('\n')).toContain('GITHUB_TOKEN');
  });

  it('never puts a value in a warning', () => {
    const warnings: string[] = [];
    build(
      makeOpts({
        sandboxConfig: makeDockerProfile({ envPassthrough: ['GITHUB_TOKEN'] }),
      }),
      new Set(),
      undefined,
      { GITHUB_TOKEN: 'ghp_do_not_log_me' },
      (message) => warnings.push(message),
    );
    expect(warnings.join('\n')).not.toContain('ghp_do_not_log_me');
  });

  it('reports rather than refuses: the key is still forwarded', () => {
    const flags = envFlags(
      build(
        makeOpts({ sandboxConfig: makeDockerProfile({ envPassthrough: ['ANTHROPIC_API_KEY'] }) }),
        new Set(),
        undefined,
        { ANTHROPIC_API_KEY: 'sk-test' },
      ),
    );
    expect(flags).toContain('ANTHROPIC_API_KEY=sk-test');
  });

  it('says nothing when nothing was forwarded', () => {
    const warnings: string[] = [];
    build(makeOpts(), new Set(), undefined, {}, (message) => warnings.push(message));
    expect(warnings.filter((w) => w.includes('forwarding host environment'))).toEqual([]);
  });

  it('isSecretLikeEnvKey knows the shapes and leaves ordinary names alone', () => {
    for (const key of [
      'GITHUB_TOKEN',
      'ANTHROPIC_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'DB_PASSWORD',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'NPM_AUTH',
      'SSH_PRIVATE_KEY',
    ]) {
      expect(isSecretLikeEnvKey(key)).toBe(true);
    }
    for (const key of ['CI', 'PATH', 'NODE_ENV', 'PORT', 'TOKENIZER_PATH']) {
      expect(isSecretLikeEnvKey(key)).toBe(false);
    }
  });
});

describe('hardening — the docker socket stays forbidden, explicitly', () => {
  it('refuses a profile mount of the daemon socket', () => {
    const warnings: string[] = [];
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          mounts: [{ hostPath: '/var/run/docker.sock', guestPath: '/var/run/docker.sock' }],
        }),
      }),
      new Set(),
      undefined,
      {},
      (message) => warnings.push(message),
    );
    expect(args.join('\n')).not.toContain('docker.sock');
    expect(warnings).toContain(
      '[docker] refusing to mount a container runtime socket: "/var/run/docker.sock"',
    );
  });

  it('refuses it under any guest path, and refuses the other runtimes too', () => {
    for (const hostPath of [
      '/var/run/docker.sock',
      '/run/docker.sock',
      `${HOME}/.docker/run/docker.sock`,
      '/run/containerd/containerd.sock',
      '/run/podman/podman.sock',
    ]) {
      expect(isDockerSocketPath(hostPath)).toBe(true);
    }
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          mounts: [{ hostPath: '/var/run/docker.sock', guestPath: '/mnt/innocent' }],
        }),
      }),
    );
    expect(mounts(args).join('\n')).not.toContain('/mnt/innocent');
  });

  it('an ordinary application socket is still mountable', () => {
    expect(isDockerSocketPath('/tmp/postgres.sock')).toBe(false);
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          mounts: [{ hostPath: '/tmp/postgres.sock', guestPath: '/tmp/postgres.sock' }],
        }),
      }),
    );
    expect(mounts(args)).toContain('/tmp/postgres.sock:/tmp/postgres.sock:ro');
  });
});

describe('hardening — implicit mounts are deprecated, not removed', () => {
  const existing = new Set([`${HOME}/.gitconfig`, `${HOME}/.ssh`, `${HOME}/.config/gh`]);

  it('still mounts them by default, so agents in the sandbox stay authenticated', () => {
    const m = mounts(build(makeOpts(), existing));
    expect(m).toContain(`${HOME}/.claude:/root/.claude`);
    expect(m).toContain(`${HOME}/.codex:/root/.codex`);
    expect(m).toContain(`${HOME}/.gitconfig:/root/.gitconfig:ro`);
  });

  it('names every host directory it reached into', () => {
    const warnings: string[] = [];
    build(makeOpts(), existing, undefined, {}, (message) => warnings.push(message));
    const line = warnings.find((w) => w.includes('implicit credential mounts'));
    expect(line).toBeDefined();
    expect(line).toContain('deprecated');
    for (const path of [
      `${HOME}/.claude`,
      `${HOME}/.claude.json`,
      `${HOME}/.codex`,
      `${HOME}/.gitconfig`,
      `${HOME}/.ssh`,
      `${HOME}/.config/gh`,
    ]) {
      expect(line).toContain(path);
    }
  });

  it('a profile can decline them, and the worktree keeps working without them', () => {
    const args = build(
      makeOpts({ sandboxConfig: makeDockerProfile({ security: { implicitMounts: false } }) }),
      existing,
    );
    const m = mounts(args);
    expect(m.join('\n')).not.toContain('/root/.claude');
    expect(m.join('\n')).not.toContain('/root/.ssh');
    // The three mounts the sandbox exists for are not implicit and never go.
    expect(m).toContain('/repos/my-branch:/repos/my-branch');
    expect(m).toContain('/repos/main/.git:/repos/main/.git');
    expect(m).toContain('/repos/main:/repos/main:ro');
  });

  it('declining them leaves an explicit mount of the same path free to work', () => {
    const args = build(
      makeOpts({
        sandboxConfig: makeDockerProfile({
          mounts: [{ hostPath: '~/.gitconfig', guestPath: '/root/.gitconfig' }],
          security: { implicitMounts: false },
        }),
      }),
      existing,
    );
    expect(mounts(args)).toContain(`${HOME}/.gitconfig:/root/.gitconfig:ro`);
  });

  it('says nothing about implicit mounts when there are none to report', () => {
    const warnings: string[] = [];
    build(
      makeOpts({ sandboxConfig: makeDockerProfile({ security: { implicitMounts: false } }) }),
      existing,
      undefined,
      {},
      (message) => warnings.push(message),
    );
    expect(warnings.join('\n')).not.toContain('implicit credential mounts');
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
