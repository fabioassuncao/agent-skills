import { stat } from 'node:fs/promises';
import { run } from '../../utils/shell.js';

/**
 * Docker container lifecycle for sandbox worktrees.
 *
 * Ported from WebMux `backend/src/adapters/docker.ts` @ d8c9d5f (384 LOC).
 * This is phase 12 — **parity only**. `--cap-drop`, `--security-opt
 * no-new-privileges`, resource limits and the network policy belong to phase 13
 * and are deliberately absent here (ADR-12: never port and harden in the same
 * change).
 *
 * The container never knows tmux exists: a pane runs `docker exec -it -w
 * <worktree> <container> …`, and the web terminal is exactly the same path.
 */

/** How long a `docker run` may take before the launch is abandoned. */
export const DOCKER_RUN_TIMEOUT_MS = 60_000;

/**
 * Prefix every container this project creates carries.
 *
 * Three characters, exactly like the upstream's `wm-`, so the 46-character
 * budget `sanitizeBranchForName` works to stays valid unchanged. It is *not*
 * `wm-`: `findContainer` and `removeContainer` select by prefix, so sharing the
 * upstream's would make this project adopt — and force-remove — containers
 * belonging to an actual WebMux install on the same machine.
 */
export const CONTAINER_NAME_PREFIX = 'if-';

/* ── configuration this module reads ────────────────────────────────────── */

/**
 * One extra bind mount declared by a profile.
 *
 * Structural subset of the upstream's `MountSpec` (`domain/config.ts:36`). The
 * profile configuration itself is phase 10's (§16, §19); declaring the shape
 * here keeps phase 12 self-contained, and phase 10's richer type only has to
 * stay assignable to it.
 */
export interface SandboxMountConfig {
  hostPath: string;
  guestPath?: string;
  writable?: boolean;
}

/** The docker slice of a runtime profile. Subset of the upstream `DockerProfileConfig`. */
export interface SandboxProfileConfig {
  runtime: 'docker';
  image: string;
  /** Host variables forwarded into the container. Reserved keys are never overridden. */
  envPassthrough?: string[];
  mounts?: SandboxMountConfig[];
}

/** A long-running service that claims a port. Subset of the upstream `ServiceSpec`. */
export interface SandboxServiceConfig {
  name: string;
  /** Variable in `runtimeEnv` holding the allocated port. */
  portEnv: string;
}

export interface LaunchContainerOpts {
  branch: string;
  wtDir: string;
  mainRepoDir: string;
  sandboxConfig: SandboxProfileConfig;
  services: SandboxServiceConfig[];
  runtimeEnv: Record<string, string>;
}

/**
 * Everything `buildDockerRunArgs` needs that it must not go and read itself.
 *
 * The upstream declares the same intent in a doc comment — "all I/O must be
 * resolved by the caller and passed in as parameters" — but still reads
 * `Bun.env` for the passthrough allowlist. `hostEnv` closes that one leak, which
 * is what makes the function genuinely pure and lets C7 (§34) compare the
 * argument list literally, with no process state involved.
 */
export interface DockerRunArgsContext {
  /** Host paths confirmed to exist; decides which credential mounts are included. */
  existingPaths: ReadonlySet<string>;
  /** Resolved home directory (`process.env.HOME ?? '/root'`). */
  home: string;
  /** Pre-generated container name. */
  name: string;
  /** Forwarded SSH agent socket, already vetted by the caller. */
  sshAuthSock?: string | undefined;
  hostUid: number;
  hostGid: number;
  /** Host environment the passthrough allowlist reads from. */
  hostEnv: Record<string, string | undefined>;
  /** Where a skipped value is reported. Nothing throws: a bad entry is dropped. */
  onWarn?: (message: string) => void;
}

export interface DockerGateway {
  /** Whether the docker CLI is installed and the daemon answers. */
  isAvailable(): Promise<boolean>;
  launchContainer(opts: LaunchContainerOpts): Promise<string>;
  findContainer(branch: string): Promise<string | null>;
  removeContainer(branch: string): Promise<void>;
}

export interface DockerGatewayOptions {
  /** Base environment credential resolution and the passthrough read from. */
  env?: Record<string, string | undefined>;
  onInfo?: (message: string) => void;
  onWarn?: (message: string) => void;
  onError?: (message: string) => void;
}

/* ── pure helpers ───────────────────────────────────────────────────────── */

/** Check if a path (file or directory) exists on the host. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitise a branch name into a Docker-safe segment.
 *
 * Docker container names must match `[a-zA-Z0-9][a-zA-Z0-9_.\-]*`. The `if-`
 * prefix (3) and `-<13-digit-ts>` suffix (14) consume 17 characters, leaving 46
 * for the branch segment (total ≤ 63).
 */
export function sanitizeBranchForName(branch: string): string {
  const s = branch
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 46);
  return s || 'x';
}

/** Container naming: `if-{sanitized-branch}-{timestamp}`. */
export function containerName(branch: string, now: number = Date.now()): string {
  return `${CONTAINER_NAME_PREFIX}${sanitizeBranchForName(branch)}-${now}`;
}

/**
 * Prefix every container of one branch shares.
 *
 * The two listing paths filter on it *and* require what follows to be only the
 * timestamp, so `main` never matches a `main-v2` container.
 */
export function containerNamePrefix(branch: string): string {
  return `${CONTAINER_NAME_PREFIX}${sanitizeBranchForName(branch)}-`;
}

/** Container names of `docker ps` output that belong to exactly this branch. */
export function selectBranchContainers(stdout: string, prefix: string): string[] {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)));
}

/** Return true if s is a valid port number string (integer 1–65535). */
export function isValidPort(s: string): boolean {
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** Return true if s is a valid environment variable key. */
export function isValidEnvKey(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

/**
 * Keys the container defines itself, which nothing may overwrite.
 *
 * Both passthrough loops consult it. `SSH_AUTH_SOCK` is in the set because the
 * socket is only usable when the matching bind mount exists — a passthrough that
 * set it alone would point the guest at a path that is not there.
 */
const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  'HOME',
  'TERM',
  'IS_SANDBOX',
  'SSH_AUTH_SOCK',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_KEY_1',
  'GIT_CONFIG_VALUE_1',
]);

/**
 * Build the `docker run` argument list from the given options.
 *
 * A pure function: every path check, environment read and clock read is
 * resolved by the caller and handed in through `context`. That is what C7 (§34)
 * compares literally, and the reason the whole parity criterion of this phase
 * can be met on a machine with no docker installed.
 */
export function buildDockerRunArgs(
  opts: LaunchContainerOpts,
  context: DockerRunArgsContext,
): string[] {
  const { wtDir, mainRepoDir, sandboxConfig, services, runtimeEnv } = opts;
  const { existingPaths, home, name, sshAuthSock, hostUid, hostGid, hostEnv } = context;
  const warn = context.onWarn ?? (() => {});

  const args: string[] = [
    'docker',
    'run',
    '-d',
    '--name',
    name,
    '-w',
    wtDir,
    '--add-host',
    'host.docker.internal:host-gateway',
    // Run as the host user so files created in mounted dirs (.git, worktree)
    // are owned by the right UID/GID instead of root.
    '--user',
    `${hostUid}:${hostGid}`,
  ];

  // Publish service ports bound to loopback only to avoid exposing dev services
  // on external interfaces. Skip invalid or duplicate port values.
  const seenPorts = new Set<string>();
  for (const svc of services) {
    const port = runtimeEnv[svc.portEnv];
    if (!port) continue;
    if (!isValidPort(port)) {
      warn(`[docker] skipping invalid port for ${svc.portEnv}: ${JSON.stringify(port)}`);
      continue;
    }
    if (seenPorts.has(port)) continue;
    seenPorts.add(port);
    args.push('-p', `127.0.0.1:${port}:${port}`);
  }

  // Core env vars — defined first so passthrough cannot override them.
  args.push('-e', 'HOME=/root');
  args.push('-e', 'TERM=xterm-256color');
  args.push('-e', 'IS_SANDBOX=1');

  // Git safe.directory config so git works in mounted worktrees. Both
  // directories are needed: the worktree and the main repository whose `.git`
  // the worktree points into.
  args.push('-e', 'GIT_CONFIG_COUNT=2');
  args.push('-e', 'GIT_CONFIG_KEY_0=safe.directory');
  args.push('-e', `GIT_CONFIG_VALUE_0=${wtDir}`);
  args.push('-e', 'GIT_CONFIG_KEY_1=safe.directory');
  args.push('-e', `GIT_CONFIG_VALUE_1=${mainRepoDir}`);

  // Pass through host env vars listed in the docker profile.
  if (sandboxConfig.envPassthrough) {
    for (const key of sandboxConfig.envPassthrough) {
      if (!isValidEnvKey(key)) {
        warn(`[docker] skipping invalid envPassthrough key: ${JSON.stringify(key)}`);
        continue;
      }
      if (RESERVED_ENV_KEYS.has(key)) continue;
      const val = hostEnv[key];
      if (val !== undefined) {
        args.push('-e', `${key}=${val}`);
      }
    }
  }

  // Pass through generated runtime env; skip reserved keys and invalid key names.
  for (const [key, val] of Object.entries(runtimeEnv)) {
    if (!isValidEnvKey(key)) {
      warn(`[docker] skipping invalid runtime env key: ${JSON.stringify(key)}`);
      continue;
    }
    if (RESERVED_ENV_KEYS.has(key)) continue;
    args.push('-e', `${key}=${val}`);
  }

  // Core mounts.
  args.push('-v', `${wtDir}:${wtDir}`);
  args.push('-v', `${mainRepoDir}/.git:${mainRepoDir}/.git`);
  args.push('-v', `${mainRepoDir}:${mainRepoDir}:ro`);

  // Agent config mounts.
  args.push('-v', `${home}/.claude:/root/.claude`);
  args.push('-v', `${home}/.claude.json:/root/.claude.json`);
  args.push('-v', `${home}/.codex:/root/.codex`);

  // Compute which guest paths are already covered by configured mounts so
  // credential mounts for the same path can be skipped (explicit mounts win).
  const extraMountGuestPaths = new Set<string>();
  if (sandboxConfig.mounts) {
    for (const mount of sandboxConfig.mounts) {
      const hostPath = mount.hostPath.replace(/^~/, home);
      if (!hostPath.startsWith('/')) continue;
      extraMountGuestPaths.add(mount.guestPath ?? hostPath);
    }
  }

  // Git/GitHub credential mounts (read-only, only if they exist on host and
  // are not overridden by a configured mount for the same guest path).
  const credentialMounts = [
    { hostPath: `${home}/.gitconfig`, guestPath: '/root/.gitconfig' },
    { hostPath: `${home}/.ssh`, guestPath: '/root/.ssh' },
    { hostPath: `${home}/.config/gh`, guestPath: '/root/.config/gh' },
  ];
  for (const { hostPath, guestPath } of credentialMounts) {
    if (extraMountGuestPaths.has(guestPath)) continue;
    if (existingPaths.has(hostPath)) {
      args.push('-v', `${hostPath}:${guestPath}:ro`);
    }
  }

  // SSH agent forwarding — mount the socket so git+ssh works with
  // passphrase-protected keys and hardware tokens. Use --mount instead of -v
  // because Docker's -v tries to mkdir socket paths and fails.
  if (sshAuthSock && existingPaths.has(sshAuthSock)) {
    args.push('--mount', `type=bind,source=${sshAuthSock},target=${sshAuthSock}`);
    args.push('-e', `SSH_AUTH_SOCK=${sshAuthSock}`);
  }

  // Additional mounts from config; require absolute host paths after ~ expansion.
  if (sandboxConfig.mounts) {
    for (const mount of sandboxConfig.mounts) {
      const hostPath = mount.hostPath.replace(/^~/, home);
      if (!hostPath.startsWith('/')) {
        warn(`[docker] skipping mount with non-absolute host path: ${JSON.stringify(hostPath)}`);
        continue;
      }
      const guestPath = mount.guestPath ?? hostPath;
      const suffix = mount.writable ? '' : ':ro';
      args.push('-v', `${hostPath}:${guestPath}${suffix}`);
    }
  }

  // Image + command.
  args.push(sandboxConfig.image, 'sleep', 'infinity');

  return args;
}

/* ── the gateway ────────────────────────────────────────────────────────── */

/**
 * Whether a socket may be forwarded to the daemon.
 *
 * The Docker daemon is a separate process, so it can only bind-mount the agent
 * socket when the socket is world-accessible. A socket that is not is dropped
 * rather than producing a `docker run` that fails at mount time.
 */
function isForwardableSocket(mode: number, isSocket: boolean): boolean {
  return isSocket && (mode & 0o007) !== 0;
}

export function createDockerGateway(options: DockerGatewayOptions = {}): DockerGateway {
  const env = options.env ?? process.env;
  const info = options.onInfo ?? (() => {});
  const warn = options.onWarn ?? (() => {});
  const error = options.onError ?? (() => {});

  /**
   * Every docker invocation of this project, through the one shell chokepoint.
   *
   * `diagnostics` is off by default because most calls here are *probes*: a
   * machine with no daemon answers non-zero to `docker version` and `docker ps`
   * as a legitimate result, and writing a diagnostic for each would bury the one
   * failure that matters. `docker run` turns it back on — that one is a real
   * failure with real stderr, and losing it would be the regression §45.3 warns
   * about.
   */
  async function docker(
    args: string[],
    opts: { cancelSignal?: AbortSignal; diagnostics?: boolean } = {},
  ) {
    return run('docker', args, {
      ...(opts.cancelSignal === undefined ? {} : { cancelSignal: opts.cancelSignal }),
      diagnostics: opts.diagnostics ?? false,
    });
  }

  async function listContainers(branch: string, includeStopped: boolean) {
    const prefix = containerNamePrefix(branch);
    const args = ['ps'];
    if (includeStopped) args.push('-a');
    args.push('--filter', `name=${prefix}`, '--format', '{{.Names}}');
    const result = await docker(args);
    return { prefix, result };
  }

  /**
   * Find the most-recently-started running container for a branch.
   *
   * Returns the container name, or `null` if none is running. Throws if the
   * Docker daemon cannot be reached: "the daemon is down" is not "no container",
   * and answering `null` there would make `launchContainer` start a second one.
   */
  async function findContainer(branch: string): Promise<string | null> {
    const { prefix, result } = await listContainers(branch, false);
    if (result.exitCode !== 0) {
      throw new Error(`docker ps failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    // docker ps lists containers newest-first; return the first match.
    return selectBranchContainers(result.stdout, prefix).at(0) ?? null;
  }

  return {
    async isAvailable(): Promise<boolean> {
      const result = await run('docker', ['version', '--format', '{{.Server.Version}}'], {
        diagnostics: false,
      });
      return result.exitCode === 0;
    },

    findContainer,

    /**
     * Launch a sandbox container for a worktree. Returns the container name.
     *
     * Idempotent per branch: a container already running for it is reused rather
     * than joined by a second one.
     */
    async launchContainer(opts: LaunchContainerOpts): Promise<string> {
      const { branch } = opts;

      const existing = await findContainer(branch);
      if (existing) {
        info(`[docker] reusing existing container ${existing} for branch ${branch}`);
        return existing;
      }

      if (!opts.sandboxConfig.image) {
        throw new Error('sandboxConfig.image is required but was empty');
      }

      const name = containerName(branch);
      const home = env.HOME ?? '/root';

      // Resolve which credential paths exist on the host before building args.
      let sshAuthSock = env.SSH_AUTH_SOCK;
      if (sshAuthSock) {
        try {
          const st = await stat(sshAuthSock);
          if (!isForwardableSocket(st.mode, st.isSocket())) {
            warn(`[docker] skipping SSH_AUTH_SOCK (not world-accessible): ${sshAuthSock}`);
            sshAuthSock = undefined;
          }
        } catch {
          sshAuthSock = undefined;
        }
      }

      const credentialHostPaths = [
        `${home}/.gitconfig`,
        `${home}/.ssh`,
        `${home}/.config/gh`,
        ...(sshAuthSock ? [sshAuthSock] : []),
      ];
      const existingPaths = new Set<string>();
      await Promise.all(
        credentialHostPaths.map(async (p) => {
          if (await pathExists(p)) existingPaths.add(p);
        }),
      );

      const args = buildDockerRunArgs(opts, {
        existingPaths,
        home,
        name,
        sshAuthSock,
        hostUid: process.getuid?.() ?? 0,
        hostGid: process.getgid?.() ?? 0,
        hostEnv: env,
        onWarn: warn,
      });

      info(`[docker] launching container: ${name}`);

      // A hung daemon or a slow image pull must not block the caller
      // indefinitely. `run()` is the only shell path of this project, so the
      // upstream's manual race against `Bun.sleep` becomes an abort signal it
      // forwards to execa. The flag — not the elapsed time — is what tells a
      // timeout apart from a plain failure, which the two report differently.
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, DOCKER_RUN_TIMEOUT_MS);
      // `docker run` is not a process this project has to outlive.
      timer.unref?.();

      let result: Awaited<ReturnType<typeof docker>>;
      try {
        result = await docker(args.slice(1), {
          cancelSignal: controller.signal,
          diagnostics: true,
        });
      } finally {
        clearTimeout(timer);
      }

      if (result.exitCode !== 0) {
        // Clean up any stopped container docker may have left behind.
        await docker(['rm', '-f', name]);
        throw timedOut
          ? new Error(`docker run timed out after ${DOCKER_RUN_TIMEOUT_MS / 1000}s`)
          : new Error(`docker run failed (exit ${result.exitCode}): ${result.stderr}`);
      }

      info(`[docker] container ${name} ready (id=${result.stdout.trim().slice(0, 12)})`);
      return name;
    },

    /**
     * Remove all containers (running or stopped) for a branch.
     *
     * Individual removal errors are reported but do not abort the remaining
     * removals: a teardown that stopped at the first failure would leave the
     * rest of the branch's containers behind for good.
     */
    async removeContainer(branch: string): Promise<void> {
      const { prefix, result } = await listContainers(branch, true);
      if (result.exitCode !== 0) {
        error(`[docker] removeContainer: docker ps failed for ${branch}: ${result.stderr}`);
        return;
      }

      const names = selectBranchContainers(result.stdout, prefix);
      await Promise.all(
        names.map(async (cname) => {
          info(`[docker] removing container: ${cname}`);
          const rm = await docker(['rm', '-f', cname]);
          if (rm.exitCode !== 0) {
            error(`[docker] failed to remove container ${cname}: ${rm.stderr}`);
          }
        }),
      );
    },
  };
}
