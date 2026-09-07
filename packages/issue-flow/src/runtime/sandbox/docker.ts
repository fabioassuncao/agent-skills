import { stat } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { run } from '../../utils/shell.js';

/**
 * Docker container lifecycle for sandbox worktrees.
 *
 * Ported from WebMux `backend/src/adapters/docker.ts` @ d8c9d5f (384 LOC) in
 * phase 12, and hardened in phase 13 against the threat model of §14.
 *
 * Phase 13 adds, and the argument list therefore **diverges deliberately from
 * the upstream**: `--cap-drop=ALL`, `--security-opt no-new-privileges`,
 * `--pids-limit`, `--memory` and an explicit `--network`. It also flips two
 * defaults the upstream leaves open — `SSH_AUTH_SOCK` forwarding is opt-in, and
 * the implicit credential mounts are deprecated and reported. Every divergence
 * is asserted by `C7` in `docker.test.ts`, which now compares against the
 * hardened baseline and documents, case by case, what changed and why.
 *
 * The container never knows tmux exists: a pane runs `docker exec -it -w
 * <worktree> <container> …`, and the web terminal is exactly the same path.
 *
 * **What this is not.** The container runs as the host user with the worktree
 * bind-mounted. It confines dependencies and limits the blast radius of a
 * mistake; it is *not* a boundary against deliberately malicious code, which
 * already has the host user's access to those directories by construction.
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

/* ── hardening defaults (phase 13, §14 stage 2) ─────────────────────────── */

/**
 * The network the container gets when a profile says nothing.
 *
 * `bridge` is what §14 fixes as the default, and it is also what docker would
 * pick — but the flag is written explicitly all the same: a daemon configured
 * with a different default network would otherwise silently change what a
 * sandbox can reach. The value being in the argument list is what makes the
 * policy reviewable in `docker inspect` and in C7.
 */
export const DEFAULT_NETWORK_MODE = 'bridge' as const;

/**
 * `--pids-limit` when a profile says nothing.
 *
 * High enough that nothing legitimate notices — a `npm ci` with native builds
 * or a Chromium test run peaks in the low hundreds of processes — and low
 * enough that a fork bomb hits a wall instead of the host's process table.
 */
export const DEFAULT_PIDS_LIMIT = 2048;

/**
 * Share of host RAM the container may use when a profile sets no `--memory`.
 *
 * A fixed default would be wrong on every machine but one: 4g starves a
 * Chromium test run on a 64 GB workstation and overcommits an 8 GB laptop.
 * A fraction of the host is never below what a build that fits the machine
 * needs, while still leaving the host enough to stay responsive when an agent
 * runs away — which is the actual threat, "the container takes the machine
 * down", not "the container uses a lot of memory".
 */
export const DEFAULT_MEMORY_FRACTION = 0.75;

/** Docker refuses `--memory` below 6 MB; below that the flag is dropped. */
const MIN_MEMORY_MB = 6;

/**
 * Environment variable names that look like they carry a credential.
 *
 * Used to report — never to block. §14 asks for `envPassthrough` to be
 * "validated against secret patterns and what was passed logged": the profile
 * is an allowlist a human wrote, so refusing an entry would break the very
 * launches the allowlist exists for. What the check buys is that forwarding a
 * credential into a sandbox is a visible act instead of a silent one.
 */
const SECRET_LIKE_ENV_KEY =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY)S?$|API_?KEY|ACCESS_KEY|AUTH$/;

/** Capability names docker accepts, with or without the `CAP_` prefix. */
const VALID_CAPABILITY = /^(?:CAP_)?[A-Z][A-Z0-9_]*$/;

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

/** Network policy a sandbox container may be given (§14). */
export type SandboxNetworkMode = 'none' | 'bridge';

/**
 * The hardening knobs of a docker profile (phase 13, §14 stage 2).
 *
 * Every field is optional and every default is the safe one, so a profile that
 * declares nothing still gets the whole hardened argument list. The fields exist
 * for the launches the defaults would otherwise break — an agent that genuinely
 * needs the host's SSH agent, a build that genuinely needs a capability — and
 * make each of those an explicit, reviewable decision instead of an ambient one.
 */
export interface SandboxSecurityConfig {
  /** `--network`. Default {@link DEFAULT_NETWORK_MODE}. `none` also drops published ports. */
  network?: SandboxNetworkMode;
  /** `--pids-limit`. Default {@link DEFAULT_PIDS_LIMIT}; `0` omits the flag. */
  pidsLimit?: number;
  /**
   * `--memory`, as a docker size string (`'4g'`, `'512m'`). Default: a
   * {@link DEFAULT_MEMORY_FRACTION} share of host RAM; `'0'` omits the flag.
   */
  memory?: string;
  /**
   * Capabilities granted back on top of `--cap-drop=ALL`.
   *
   * Nothing the sandbox does needs one — the container already runs as an
   * unprivileged uid — so the list is empty unless a profile has a reason and
   * names it.
   */
  capAdd?: string[];
  /** `--security-opt no-new-privileges`. Default `true`; see the module docs before disabling. */
  noNewPrivileges?: boolean;
  /**
   * Forward the host's `SSH_AUTH_SOCK` into the container. Default `false`.
   *
   * §14 makes this opt-in: the socket lets anything in the container sign and
   * push with the user's key, including for repositories the sandbox has
   * nothing to do with. The upstream forwards it whenever it exists.
   */
  sshAgent?: boolean;
  /**
   * The implicit agent-config and credential mounts. Default `true`, deprecated.
   *
   * `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.gitconfig`, `~/.ssh` and
   * `~/.config/gh` are mounted because the upstream mounts them and agents
   * inside the sandbox stop authenticating without them. Phase 13 deprecates the
   * *implicitness*, not the mounts: they are reported through `onWarn` on every
   * launch, and `false` turns them off in favour of an explicit `mounts` list.
   */
  implicitMounts?: boolean;
}

/** The docker slice of a runtime profile. Subset of the upstream `DockerProfileConfig`. */
export interface SandboxProfileConfig {
  runtime: 'docker';
  image: string;
  /** Host variables forwarded into the container. Reserved keys are never overridden. */
  envPassthrough?: string[];
  mounts?: SandboxMountConfig[];
  /** Phase 13 hardening. Absent means "every default", which is the hardened set. */
  security?: SandboxSecurityConfig;
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
  /**
   * Total RAM of the host, in bytes — what the default `--memory` is a share of.
   *
   * It is a parameter and not an `os.totalmem()` call for the same reason
   * `hostEnv` is: the moment the function reads process state, C7 stops being a
   * literal comparison and the hardened baseline stops being reproducible.
   */
  hostTotalMemoryBytes: number;
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

/* ── hardening helpers (phase 13) ───────────────────────────────────────── */

/**
 * Whether a variable name reads like a credential.
 *
 * Reporting only — see {@link SECRET_LIKE_ENV_KEY}. A false positive costs one
 * line on stderr; a false negative costs nothing that was not already true
 * before phase 13.
 */
export function isSecretLikeEnvKey(key: string): boolean {
  return SECRET_LIKE_ENV_KEY.test(key.toUpperCase());
}

/**
 * Whether a host path is the Docker daemon's own socket.
 *
 * §14 keeps "the docker socket is not mounted" as an explicit invariant rather
 * than an accident of the upstream never having written the line: a profile
 * mount is arbitrary user configuration, and `-v /var/run/docker.sock:…` inside
 * a container that already runs as the host user is a complete handover of the
 * host daemon — every other flag in this file becomes decorative.
 */
export function isDockerSocketPath(hostPath: string): boolean {
  return /(?:^|\/)(?:docker|containerd|podman)\.sock$/.test(hostPath);
}

/** The container's network, defaulting to {@link DEFAULT_NETWORK_MODE}. */
export function resolveNetworkMode(
  security: SandboxSecurityConfig | undefined,
): SandboxNetworkMode {
  return security?.network === 'none' ? 'none' : DEFAULT_NETWORK_MODE;
}

/**
 * The `--pids-limit` value, or `undefined` when the flag is omitted.
 *
 * A non-positive or non-integer value omits the flag rather than throwing,
 * which is the tolerance rule every parser in this project follows: a typo in a
 * profile costs a warning, never the run.
 */
export function resolvePidsLimit(security: SandboxSecurityConfig | undefined): number | undefined {
  const configured = security?.pidsLimit;
  if (configured === undefined) return DEFAULT_PIDS_LIMIT;
  if (!Number.isInteger(configured) || configured <= 0) return undefined;
  return configured;
}

/**
 * The `--memory` value, or `undefined` when the flag is omitted.
 *
 * An explicit profile value wins verbatim, so any unit docker understands works
 * and `'0'` — docker's own spelling of "no limit" — turns the limit off.
 * Otherwise it is {@link DEFAULT_MEMORY_FRACTION} of the host, floored to whole
 * megabytes so the flag is stable across the rounding of `os.totalmem()`.
 */
export function resolveMemoryLimit(
  security: SandboxSecurityConfig | undefined,
  hostTotalMemoryBytes: number,
): string | undefined {
  const configured = security?.memory?.trim();
  if (configured !== undefined && configured !== '') {
    return /^0[a-z]*$/i.test(configured) ? undefined : configured;
  }
  if (!Number.isFinite(hostTotalMemoryBytes) || hostTotalMemoryBytes <= 0) return undefined;
  const megabytes = Math.floor((hostTotalMemoryBytes * DEFAULT_MEMORY_FRACTION) / 1024 / 1024);
  return megabytes >= MIN_MEMORY_MB ? `${megabytes}m` : undefined;
}

/**
 * The capabilities added back on top of `--cap-drop=ALL`, normalised and vetted.
 *
 * Docker accepts `NET_ADMIN` and `CAP_NET_ADMIN` alike; anything that is not a
 * capability name at all is dropped rather than passed on, for the same reason
 * `isValidEnvKey` drops a malformed key: the container never receives a flag
 * this project could not validate.
 */
export function resolveCapAdd(
  security: SandboxSecurityConfig | undefined,
  warn: (message: string) => void,
): string[] {
  const result: string[] = [];
  for (const raw of security?.capAdd ?? []) {
    const cap = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
    if (!VALID_CAPABILITY.test(cap)) {
      warn(`[docker] skipping invalid capAdd entry: ${JSON.stringify(raw)}`);
      continue;
    }
    if (!result.includes(cap)) result.push(cap);
  }
  return result;
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
 * compares literally, and the reason the whole parity criterion of phase 12 —
 * and the hardened baseline of phase 13 — can be verified on a machine with no
 * docker installed.
 */
export function buildDockerRunArgs(
  opts: LaunchContainerOpts,
  context: DockerRunArgsContext,
): string[] {
  const { wtDir, mainRepoDir, sandboxConfig, services, runtimeEnv } = opts;
  const { existingPaths, home, name, sshAuthSock, hostUid, hostGid, hostEnv } = context;
  const warn = context.onWarn ?? (() => {});
  const security = sandboxConfig.security;

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

  /* ── hardening (phase 13, §14 stage 2) ────────────────────────────────── */

  // Nothing the sandbox does needs a Linux capability: the agent compiles, runs
  // tests and talks to git, all as an unprivileged uid. Dropping the set removes
  // the tools of an in-container escalation without touching any of that.
  args.push('--cap-drop', 'ALL');
  for (const cap of resolveCapAdd(security, warn)) {
    args.push('--cap-add', cap);
  }

  // Blocks setuid binaries from raising privileges. This is what makes
  // `--cap-drop=ALL` hold: without it a setuid root binary in the image walks
  // straight back out of the empty capability set.
  if (security?.noNewPrivileges !== false) {
    args.push('--security-opt', 'no-new-privileges:true');
  }

  const pidsLimit = resolvePidsLimit(security);
  if (pidsLimit !== undefined) args.push('--pids-limit', String(pidsLimit));

  const memory = resolveMemoryLimit(security, context.hostTotalMemoryBytes);
  if (memory !== undefined) args.push('--memory', memory);

  // Written even for the default, so the sandbox's reach does not depend on how
  // the host's daemon happens to be configured.
  const network = resolveNetworkMode(security);
  args.push('--network', network);

  /* ── published ports ──────────────────────────────────────────────────── */

  // Publish service ports bound to loopback only to avoid exposing dev services
  // on external interfaces. Skip invalid or duplicate port values.
  //
  // `--network none` and `-p` are mutually exclusive: docker rejects the pair
  // outright ("conflicting options: port publishing and the container type
  // network mode"), so an isolated profile that also declares services would
  // fail to launch at all. The ports are dropped with a warning instead — the
  // isolation is the thing that was asked for, and a service nothing can reach
  // has nothing to publish.
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
    if (network === 'none') {
      warn(`[docker] not publishing port ${port} for ${svc.portEnv}: network is "none"`);
      continue;
    }
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
  //
  // §14 asks for two things here that the upstream does not do: check the names
  // against secret patterns, and report what was actually forwarded. Both are
  // reports, never refusals — the allowlist is a decision a human already made,
  // and a sandbox that silently loses `ANTHROPIC_API_KEY` is a broken sandbox.
  // Only names are ever reported; a value never reaches a log line.
  const forwarded: string[] = [];
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
        forwarded.push(key);
      }
    }
  }
  if (forwarded.length > 0) {
    warn(`[docker] forwarding host environment into the sandbox: ${forwarded.join(', ')}`);
    const secretLike = forwarded.filter(isSecretLikeEnvKey);
    if (secretLike.length > 0) {
      warn(
        `[docker] envPassthrough carries credential-shaped keys, readable by anything in the container: ${secretLike.join(', ')}`,
      );
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

  // Core mounts. These are the sandbox's reason to exist — the worktree the
  // agent works in and the object store its `.git` points at — and are not
  // subject to `implicitMounts`.
  args.push('-v', `${wtDir}:${wtDir}`);
  args.push('-v', `${mainRepoDir}/.git:${mainRepoDir}/.git`);
  args.push('-v', `${mainRepoDir}:${mainRepoDir}:ro`);

  // The implicit mounts phase 13 deprecates: agent configuration and host
  // credentials, mounted because they exist rather than because a profile asked
  // for them. They stay on by default — turning them off silently would leave
  // every agent in the sandbox unauthenticated — but the launch now says which
  // of the user's directories it reached into, and a profile can decline.
  const implicitMounts = security?.implicitMounts !== false;
  const implicit: string[] = [];

  if (implicitMounts) {
    args.push('-v', `${home}/.claude:/root/.claude`);
    args.push('-v', `${home}/.claude.json:/root/.claude.json`);
    args.push('-v', `${home}/.codex:/root/.codex`);
    implicit.push(`${home}/.claude`, `${home}/.claude.json`, `${home}/.codex`);
  }

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
  if (implicitMounts) {
    for (const { hostPath, guestPath } of credentialMounts) {
      if (extraMountGuestPaths.has(guestPath)) continue;
      if (existingPaths.has(hostPath)) {
        args.push('-v', `${hostPath}:${guestPath}:ro`);
        implicit.push(hostPath);
      }
    }
  }

  if (implicit.length > 0) {
    warn(
      `[docker] implicit credential mounts (deprecated — set security.implicitMounts=false and declare them): ${implicit.join(', ')}`,
    );
  }

  // SSH agent forwarding — mount the socket so git+ssh works with
  // passphrase-protected keys and hardware tokens. Use --mount instead of -v
  // because Docker's -v tries to mkdir socket paths and fails.
  //
  // Opt-in since phase 13 (§14): the socket is not a file the container can
  // read, it is the user's key answering signature requests for as long as the
  // container lives, for every repository and host that key reaches.
  if (security?.sshAgent === true && sshAuthSock && existingPaths.has(sshAuthSock)) {
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
      // The one mount no configuration may ask for. Everything above assumes
      // the container cannot reach the daemon that runs it.
      if (isDockerSocketPath(hostPath) || isDockerSocketPath(guestPath)) {
        warn(`[docker] refusing to mount a container runtime socket: ${JSON.stringify(hostPath)}`);
        continue;
      }
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
      //
      // The socket is not even looked at unless the profile opted in: probing it
      // otherwise would emit a "not world-accessible" warning about a socket
      // this launch was never going to forward.
      let sshAuthSock =
        opts.sandboxConfig.security?.sshAgent === true ? env.SSH_AUTH_SOCK : undefined;
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
        hostTotalMemoryBytes: totalmem(),
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
