import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';
import { execa } from 'execa';
import { isoNow } from '../core/state-manager.js';
// The liveness probe is shared with `storage/lock.ts`, which generalised this
// module's guard into run ownership: one definition of "is that pid alive",
// with one place to get the EPERM case right.
import { isProcessAlive } from '../storage/lock.js';
import { type GetGlobalRootOptions, getGlobalRoot } from '../storage/paths.js';
import { type WebLock, webLockSchema } from '../storage/schemas.js';
import { printInfo, printWarning } from '../ui/logger.js';
import { startWebServer, type WebServerHandle, type WebServerOptions } from './server.js';

/**
 * Single-instance guard for the web monitoring server (`~/.issue-flow/web.lock`).
 *
 * A machine runs at most one monitoring server. Two entry points build on top
 * of the same lock:
 *
 * - `ensureSingleWebServer` binds (or reuses) a server **in the calling
 *   process**. It is the low-level primitive, used by the `web serve` command
 *   (the standalone process that ends up owning the lock) and by this
 *   module's own tests. Nothing else should call it directly.
 * - `ensureWebMonitor` (US-002) is what `run`/`execute` call: it reuses an
 *   active instance exactly like `ensureSingleWebServer`, but when none
 *   exists it spawns `web serve` as a **detached** child instead of binding
 *   locally, so the server outlives the pipeline process. Falls back to the
 *   legacy in-process `startWebServer` (US-006) when the global storage tree
 *   itself is unreachable.
 */

/** Lock file name, sibling of `config.json` at the global storage root. */
export const WEB_LOCK_FILENAME = 'web.lock';
export const WEB_RESTART_LOCK_FILENAME = 'web.restart.lock';

/** How long a health probe against a candidate instance waits before giving up. */
const HEALTH_PROBE_TIMEOUT_MS = 1000;

interface WebHealth {
  ok: true;
  pid?: number;
  instanceId?: string;
  startedAt?: string;
  uptime?: number;
  version?: string;
}

interface ManagedWebInstance {
  lock: WebLock;
  health: WebHealth;
  source: 'lock' | 'port';
}

export interface PortOwner {
  pid: number;
  command: string;
}

/**
 * A process that loses the atomic lock creation retries this many times,
 * waiting for the winner to finish starting up, before giving up.
 */
const LOCK_CLAIM_RETRIES = 5;
const LOCK_CLAIM_RETRY_DELAY_MS = 100;

export function getWebLockFile(options: GetGlobalRootOptions = {}): string {
  return join(getGlobalRoot(options), WEB_LOCK_FILENAME);
}

function getWebRestartLockFile(options: GetGlobalRootOptions = {}): string {
  return join(getGlobalRoot(options), WEB_RESTART_LOCK_FILENAME);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 0.0.0.0 is not a connectable address; probe loopback instead, same mapping
 * `startWebServer` uses to build its own display URL. */
function probeUrl(host: string, port: number): string {
  const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return `http://${probeHost}:${port}/api/health`;
}

async function probeHealth(host: string, port: number): Promise<WebHealth | null> {
  try {
    const res = await fetch(probeUrl(host, port), {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    if (body.ok !== true) return null;
    return {
      ok: true,
      ...(typeof body.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0
        ? { pid: body.pid }
        : {}),
      ...(typeof body.instanceId === 'string' && body.instanceId !== ''
        ? { instanceId: body.instanceId }
        : {}),
      ...(typeof body.startedAt === 'string' && body.startedAt !== ''
        ? { startedAt: body.startedAt }
        : {}),
      ...(typeof body.uptime === 'number' && Number.isFinite(body.uptime)
        ? { uptime: body.uptime }
        : {}),
      ...(typeof body.version === 'string' && body.version !== '' ? { version: body.version } : {}),
    };
  } catch {
    return null;
  }
}

function sameLock(a: WebLock | null, b: WebLock): boolean {
  return (
    a !== null &&
    a.pid === b.pid &&
    a.port === b.port &&
    a.host === b.host &&
    a.startedAt === b.startedAt &&
    a.instanceId === b.instanceId
  );
}

async function removeWebLockIfOwned(lockFile: string, expected: WebLock): Promise<void> {
  if (sameLock(await readWebLock(lockFile), expected)) {
    await removeWebLock(lockFile);
  }
}

async function inspectProcessCommand(pid: number): Promise<string | null> {
  const invocation =
    process.platform === 'win32'
      ? {
          command: 'powershell.exe',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
          ],
        }
      : { command: 'ps', args: ['-p', String(pid), '-o', 'command='] };
  try {
    const result = await execa(invocation.command, invocation.args, { reject: false });
    const command = result.stdout.trim();
    return result.exitCode === 0 && command !== '' ? command : null;
  } catch {
    return null;
  }
}

async function findListeningProcess(port: number): Promise<PortOwner | null> {
  try {
    let pids: number[];
    if (process.platform === 'win32') {
      const result = await execa(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join [Environment]::NewLine`,
        ],
        { reject: false },
      );
      pids = result.stdout
        .split(/\s+/)
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } else {
      const result = await execa('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
        reject: false,
      });
      pids = result.stdout
        .split(/\s+/)
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    }
    const unique = [...new Set(pids)];
    if (unique.length !== 1) return null;
    const pid = unique[0] as number;
    const command = await inspectProcessCommand(pid);
    return command === null ? null : { pid, command };
  } catch {
    return null;
  }
}

function isIssueFlowWebServe(owner: PortOwner, port: number): boolean {
  const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    /(?:^|\s)web\s+serve(?:\s|$)/.test(owner.command) &&
    new RegExp(`(?:^|\\s)--port(?:=|\\s+)${escapedPort}(?:\\s|$)`).test(owner.command) &&
    /issue-flow|(?:^|[/\\])dist[/\\]cli\.js/.test(owner.command)
  );
}

/** Malformed content (partial write, older/newer incompatible shape) reads as
 * "no lock" — the same degrade-to-absent behavior as `loadGlobalConfig()`. */
export async function readWebLock(lockFile: string): Promise<WebLock | null> {
  let raw: string;
  try {
    raw = await readFile(lockFile, 'utf-8');
  } catch {
    return null;
  }
  try {
    const result = webLockSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function removeWebLock(lockFile: string): Promise<void> {
  try {
    await rm(lockFile, { force: true });
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * A lock is only trustworthy when both signals agree: the owning process is
 * alive AND it answers `/api/health`. A dead pid is the obvious stale case;
 * a live pid that does not answer covers a process that still exists but
 * crashed before binding, was killed -9 leaving a zombie-adjacent state, or
 * whose port was reclaimed by something else entirely. Either way the lock is
 * removed so the next attempt starts clean instead of looping on it forever.
 */
export async function detectActiveInstance(lockFile: string): Promise<WebLock | null> {
  const lock = await readWebLock(lockFile);
  if (lock === null) return null;

  const health = isProcessAlive(lock.pid) ? await probeHealth(lock.host, lock.port) : null;
  if (health !== null && (lock.instanceId === undefined || health.instanceId === lock.instanceId)) {
    return lock;
  }

  await removeWebLockIfOwned(lockFile, lock);
  return null;
}

/**
 * Atomic exclusive create: `wx` fails with EEXIST when another process won
 * the race, which is what lets two concurrent invocations agree on a single
 * winner without a separate lock-of-the-lock.
 */
async function claimWebLock(lockFile: string, lock: WebLock): Promise<boolean> {
  try {
    await writeFile(lockFile, JSON.stringify(lock, null, 2), { encoding: 'utf-8', flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

interface RestartLock {
  pid: number;
  operationId: string;
  startedAt: string;
}

async function readRestartLock(file: string): Promise<RestartLock | null> {
  try {
    const value = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
    return typeof value.pid === 'number' &&
      Number.isInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.operationId === 'string' &&
      value.operationId !== '' &&
      typeof value.startedAt === 'string' &&
      value.startedAt !== ''
      ? { pid: value.pid, operationId: value.operationId, startedAt: value.startedAt }
      : null;
  } catch {
    return null;
  }
}

async function removeRestartLockIfOwned(file: string, expected: RestartLock): Promise<void> {
  const current = await readRestartLock(file);
  if (current?.operationId === expected.operationId) {
    await rm(file, { force: true }).catch(() => {});
  }
}

async function waitForRestart(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await readRestartLock(file);
    if (lock === null) {
      // Missing or malformed means there is no owner we can safely wait for.
      // Do not unlink here: a restart may have claimed the path between the
      // read and this branch. The explicit acquirer cleans malformed files.
      return true;
    }
    if (!isProcessAlive(lock.pid)) {
      await removeRestartLockIfOwned(file, lock);
      return true;
    }
    await sleep(LOCK_CLAIM_RETRY_DELAY_MS);
  }
  return false;
}

async function acquireRestartLock(
  file: string,
  timeoutMs: number,
): Promise<{ lock: RestartLock; waited: boolean; release: () => Promise<void> } | null> {
  const deadline = Date.now() + timeoutMs;
  let waited = false;
  while (Date.now() < deadline) {
    const lock: RestartLock = {
      pid: process.pid,
      operationId: randomUUID(),
      startedAt: isoNow(),
    };
    try {
      await writeFile(file, JSON.stringify(lock, null, 2), { encoding: 'utf-8', flag: 'wx' });
      return {
        lock,
        waited,
        release: () => removeRestartLockIfOwned(file, lock),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    waited = true;
    const existing = await readRestartLock(file);
    if (existing === null || !isProcessAlive(existing.pid)) {
      if (existing === null) await rm(file, { force: true }).catch(() => {});
      else await removeRestartLockIfOwned(file, existing);
      continue;
    }
    await sleep(LOCK_CLAIM_RETRY_DELAY_MS);
  }
  return null;
}

/** Handle returned when reusing an already-running instance instead of
 * binding a new one — there is no local `Server` to hold, and closing it
 * must not tear down a server another process owns. */
function reusedHandle(lock: WebLock): WebServerHandle {
  const displayHost = lock.host === '0.0.0.0' ? 'localhost' : lock.host;
  return {
    host: lock.host,
    port: lock.port,
    url: `http://${displayHost}:${lock.port}`,
    instanceId: lock.instanceId ?? `legacy-${lock.pid}-${lock.startedAt}`,
    close: async () => {},
  };
}

/**
 * Start the web monitoring server, first checking whether a live instance
 * already owns `web.lock` and reusing it instead of binding a second one.
 *
 * The lock is claimed only *after* a successful bind, never before: claiming
 * it with the port the server is about to (but hasn't yet) listen on would
 * make that lock briefly answer no health probe at all, and a concurrent
 * invocation would misread that gap as "stale" and delete a perfectly good
 * lock out from under its owner. Binding first also means two invocations
 * racing for the same fixed port never both reach the claim step — the OS
 * itself lets only one `listen()` succeed. The `wx` claim then exists for the
 * remaining race: two invocations that *both* manage to bind (only possible
 * with an ephemeral port) still agree on exactly one winner. The loser closes
 * the server it just opened and defers to whichever lock exists.
 *
 * Returns null exactly when `startWebServer` would: nothing here may affect
 * the pipeline, so a lock we cannot resolve after every retry degrades to "no
 * server" rather than throwing.
 */
export async function ensureSingleWebServer(
  options: WebServerOptions,
  lockOptions: GetGlobalRootOptions = {},
): Promise<WebServerHandle | null> {
  const warn = options.warn ?? printWarning;
  const info = options.info ?? printInfo;
  const lockFile = getWebLockFile(lockOptions);

  for (let attempt = 0; attempt <= LOCK_CLAIM_RETRIES; attempt++) {
    const active = await detectActiveInstance(lockFile);
    if (active !== null) {
      info(`Reusing existing web monitor at ${reusedHandle(active).url}`);
      return reusedHandle(active);
    }

    const handle = await startWebServer(options);
    if (handle === null) {
      // Could not bind. Most likely another instance's listen() won a race
      // on the same fixed port between our detection above and this call —
      // its lock should be visible shortly. Anything else (port taken by an
      // unrelated process, invalid host, ...) fails the same way on the next
      // retry too, and the loop's own limit stops it from spinning forever.
      await sleep(LOCK_CLAIM_RETRY_DELAY_MS);
      continue;
    }

    let claimed: boolean;
    try {
      claimed = await claimWebLock(lockFile, {
        pid: process.pid,
        port: handle.port,
        host: handle.host,
        startedAt: isoNow(),
        instanceId: handle.instanceId,
      });
    } catch (err) {
      await handle.close();
      throw err;
    }

    if (!claimed) {
      // We bound successfully (an ephemeral port let both of us through),
      // but another invocation's lock got written first. We are not the
      // canonical instance: close what we just opened and defer to it.
      await handle.close();
      await sleep(LOCK_CLAIM_RETRY_DELAY_MS);
      continue;
    }

    const originalClose = handle.close;
    handle.close = async () => {
      await originalClose();
      await removeWebLock(lockFile);
    };
    return handle;
  }

  warn('Could not determine the web monitor lock ownership. Continuing without the web server.');
  return null;
}

/** Bounded wait for a freshly spawned `web serve` child to claim the lock. */
const DETACHED_CLAIM_TIMEOUT_MS = 5000;
const DETACHED_CLAIM_POLL_MS = 150;

export interface EnsureWebMonitorOptions extends GetGlobalRootOptions {
  /** Injectable for tests. Defaults to `node:child_process`'s `spawn`. */
  spawn?: (
    command: string,
    args: string[],
    options: { detached: true; stdio: 'ignore' },
  ) => ChildProcess;
  /** Node executable to spawn. Defaults to `process.execPath`. */
  execPath?: string;
  /** CLI entry script re-invoked as `<entry> web serve ...`. Defaults to `process.argv[1]`. */
  entryScript?: string;
  /** How long to wait for the spawned instance's lock to become healthy. */
  claimTimeoutMs?: number;
  claimPollIntervalMs?: number;
  /** Explicitly replace any managed monitor before spawning this entry point. */
  restart?: boolean;
  /** Injectable process operations used by restart and orphan recovery tests. */
  kill?: typeof process.kill;
  isAlive?: (pid: number) => boolean;
  findPortOwner?: (port: number) => Promise<PortOwner | null>;
  inspectProcess?: (pid: number) => Promise<string | null>;
  shutdownTimeoutMs?: number;
  restartLockTimeoutMs?: number;
}

interface DiscoveryResult {
  instance: ManagedWebInstance | null;
  /** A monitor-like health endpoint answered, but ownership could not be proven. */
  unownedMonitor: boolean;
}

function inferredStartedAt(health: WebHealth): string {
  if (health.startedAt !== undefined) return health.startedAt;
  if (health.uptime !== undefined) {
    return new Date(Date.now() - Math.max(0, health.uptime) * 1000).toISOString();
  }
  return isoNow();
}

async function discoverManagedInstance(
  lockFile: string,
  options: WebServerOptions,
  monitorOptions: EnsureWebMonitorOptions,
): Promise<DiscoveryResult> {
  const existingLock = await readWebLock(lockFile);
  if (existingLock !== null) {
    const health = isProcessAlive(existingLock.pid)
      ? await probeHealth(existingLock.host, existingLock.port)
      : null;
    if (
      health !== null &&
      (existingLock.instanceId === undefined || health.instanceId === existingLock.instanceId)
    ) {
      return { instance: { lock: existingLock, health, source: 'lock' }, unownedMonitor: false };
    }
    await removeWebLockIfOwned(lockFile, existingLock);
  }

  // The global storage may have been deleted while the detached process kept
  // running. In that state there is no PID file to consult, so prove both
  // halves independently: an Issue Flow health endpoint and the command line
  // of the sole process listening on the configured port.
  const health = await probeHealth(options.host, options.port);
  if (health === null) return { instance: null, unownedMonitor: false };

  const inspect = monitorOptions.inspectProcess ?? inspectProcessCommand;
  let owner: PortOwner | null = null;
  if (health.pid !== undefined) {
    const command = await inspect(health.pid);
    if (command !== null) owner = { pid: health.pid, command };
  }
  owner ??= await (monitorOptions.findPortOwner ?? findListeningProcess)(options.port);
  if (owner === null || !isIssueFlowWebServe(owner, options.port)) {
    return { instance: null, unownedMonitor: true };
  }

  const recovered: WebLock = {
    pid: owner.pid,
    port: options.port,
    host: options.host,
    startedAt: inferredStartedAt(health),
    ...(health.instanceId === undefined ? {} : { instanceId: health.instanceId }),
  };
  const claimed = await claimWebLock(lockFile, recovered).catch(() => false);
  if (!claimed) {
    const winner = await readWebLock(lockFile);
    if (winner !== null) {
      const winnerHealth = await probeHealth(winner.host, winner.port);
      if (winnerHealth !== null) {
        return {
          instance: { lock: winner, health: winnerHealth, source: 'lock' },
          unownedMonitor: false,
        };
      }
    }
  }
  return { instance: { lock: recovered, health, source: 'port' }, unownedMonitor: false };
}

async function stopManagedInstance(
  instance: ManagedWebInstance,
  lockFile: string,
  options: WebServerOptions,
  monitorOptions: EnsureWebMonitorOptions,
): Promise<boolean> {
  const info = options.info ?? printInfo;
  const warn = options.warn ?? printWarning;
  const version =
    instance.health.version === undefined ? '' : `, version ${instance.health.version}`;
  info(`Web monitor: stopping previous instance (pid ${instance.lock.pid}${version}).`);

  try {
    (monitorOptions.kill ?? process.kill)(instance.lock.pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      await removeWebLockIfOwned(lockFile, instance.lock);
      info(`Web monitor: previous pid ${instance.lock.pid} was already gone; stale lock removed.`);
      return true;
    }
    warn(
      `Web monitor: failed to stop pid ${instance.lock.pid} (${err instanceof Error ? err.message : String(err)}). Continuing the pipeline without restarting it.`,
    );
    return false;
  }

  const isAlive = monitorOptions.isAlive ?? isProcessAlive;
  const deadline = Date.now() + (monitorOptions.shutdownTimeoutMs ?? 5000);
  const pollMs = monitorOptions.claimPollIntervalMs ?? DETACHED_CLAIM_POLL_MS;
  while (Date.now() < deadline) {
    const alive = isAlive(instance.lock.pid);
    const health = alive ? await probeHealth(instance.lock.host, instance.lock.port) : null;
    if (!alive || health === null) {
      await removeWebLockIfOwned(lockFile, instance.lock);
      info(`Web monitor: previous instance stopped (pid ${instance.lock.pid}).`);
      info(
        'Web monitor: process-local static asset and ETag caches invalidated; no on-disk web build cache exists.',
      );
      return true;
    }
    await sleep(pollMs);
  }

  warn(
    `Web monitor: pid ${instance.lock.pid} did not confirm shutdown in time. Continuing the pipeline without starting a competing instance.`,
  );
  return false;
}

export type StopWebMonitorResult = 'stopped' | 'not-running' | 'unowned' | 'failed';

/** Stop the managed monitor without starting a replacement. Shared by
 * `web stop` and the restart path so both use identical ownership checks. */
export async function stopWebMonitor(
  options: Pick<WebServerOptions, 'port' | 'host' | 'info' | 'warn'>,
  monitorOptions: EnsureWebMonitorOptions = {},
): Promise<StopWebMonitorResult> {
  const info = options.info ?? printInfo;
  const warn = options.warn ?? printWarning;
  let lockFile: string;
  let restartLockFile: string;
  try {
    await mkdir(getGlobalRoot(monitorOptions), { recursive: true });
    lockFile = getWebLockFile(monitorOptions);
    restartLockFile = getWebRestartLockFile(monitorOptions);
  } catch (err) {
    warn(
      `Web monitor: global storage unavailable (${err instanceof Error ? err.message : String(err)}).`,
    );
    return 'failed';
  }

  const lease = await acquireRestartLock(
    restartLockFile,
    monitorOptions.restartLockTimeoutMs ?? 5000,
  );
  if (lease === null) {
    warn('Web monitor: could not acquire the maintenance lock; no process was stopped.');
    return 'failed';
  }
  try {
    const stale = await readWebLock(lockFile);
    const discovered = await discoverManagedInstance(lockFile, options, monitorOptions);
    if (discovered.instance === null) {
      if (stale !== null && !isProcessAlive(stale.pid)) {
        info(`Web monitor: stale lock for dead pid ${stale.pid} removed.`);
      }
      if (discovered.unownedMonitor) {
        warn(
          `Web monitor: port ${options.port} looks like an Issue Flow monitor, but its process ownership could not be verified; it was left untouched.`,
        );
        return 'unowned';
      }
      info('No web monitor is currently running.');
      return 'not-running';
    }
    return (await stopManagedInstance(discovered.instance, lockFile, options, monitorOptions))
      ? 'stopped'
      : 'failed';
  } finally {
    await lease.release();
  }
}

/**
 * Entry point for `run`/`execute`: get a web monitor without binding one in
 * this process (US-002).
 *
 * 1. Reuse a live, healthy instance exactly like `ensureSingleWebServer`.
 * 2. Otherwise, spawn `<node> <cli> web serve --port … --host … [--refresh …]`
 *    detached (`{ detached: true, stdio: 'ignore' }`) and `unref()`ed, so it
 *    survives this process exiting and never pipes its own stdio back here.
 * 3. Poll the lock file (bounded) until the spawned instance claims it, then
 *    return a *reused* handle for it — this process never owns that `Server`,
 *    the same shape `ensureSingleWebServer`'s reuse path already returns.
 *
 * Two failure modes degrade gracefully rather than affecting the pipeline:
 * the global storage tree being unreachable (no resolvable home directory)
 * falls back to `startWebServer` bound right here, exactly the pre-US-001
 * behavior (US-006); a spawn or claim failure with the storage tree otherwise
 * healthy just returns null, same contract `startWebServer` itself has.
 */
export async function ensureWebMonitor(
  options: WebServerOptions,
  monitorOptions: EnsureWebMonitorOptions = {},
): Promise<WebServerHandle | null> {
  const warn = options.warn ?? printWarning;
  const info = options.info ?? printInfo;

  let lockFile: string;
  let restartLockFile: string;
  try {
    await mkdir(getGlobalRoot(monitorOptions), { recursive: true });
    lockFile = getWebLockFile(monitorOptions);
    restartLockFile = getWebRestartLockFile(monitorOptions);
  } catch (err) {
    warn(
      `Web monitor: global storage unavailable (${err instanceof Error ? err.message : String(err)}). Falling back to legacy in-process mode.`,
    );
    return startWebServer(options);
  }

  const coordinationTimeout = monitorOptions.restartLockTimeoutMs ?? 5000;
  const restartRequestedAt = Date.now();
  const restartLease = monitorOptions.restart
    ? await acquireRestartLock(restartLockFile, coordinationTimeout)
    : null;
  if (monitorOptions.restart && restartLease === null) {
    warn(
      'Web monitor: could not acquire the restart lock. Continuing the pipeline without changing the server.',
    );
    return null;
  }
  if (!monitorOptions.restart && !(await waitForRestart(restartLockFile, coordinationTimeout))) {
    warn(
      'Web monitor: another restart is still in progress. Continuing the pipeline without starting a competing instance.',
    );
    return null;
  }

  try {
    const discovered = await discoverManagedInstance(lockFile, options, monitorOptions);
    const active = discovered.instance;
    if (
      monitorOptions.restart &&
      restartLease?.waited === true &&
      active !== null &&
      Date.parse(active.lock.startedAt) >= restartRequestedAt
    ) {
      info(
        `Web monitor: a concurrent restart already started pid ${active.lock.pid}; reusing ${reusedHandle(active.lock).url}`,
      );
      return reusedHandle(active.lock);
    }

    if (active !== null && !monitorOptions.restart) {
      if (active.source === 'port') {
        info(
          `Recovered orphaned web monitor pid ${active.lock.pid} on port ${active.lock.port} and restored web.lock.`,
        );
      }
      info(`Reusing existing web monitor at ${reusedHandle(active.lock).url}`);
      return reusedHandle(active.lock);
    }

    if (active !== null && monitorOptions.restart) {
      if (!(await stopManagedInstance(active, lockFile, options, monitorOptions))) return null;
    } else if (discovered.unownedMonitor) {
      warn(
        `Web monitor: port ${options.port} answers an Issue Flow health check, but its owning process could not be verified. It was left untouched and no competing server was started.`,
      );
      return null;
    } else if (monitorOptions.restart) {
      info('Web monitor: no previous managed instance was found; starting a fresh one.');
      info('Web monitor: no on-disk web build cache exists; no files were removed.');
    }

    const execPath = monitorOptions.execPath ?? process.execPath;
    const entryScript = monitorOptions.entryScript ?? process.argv[1];
    if (entryScript === undefined) {
      warn('Web monitor: could not determine the CLI entry point to spawn a detached server.');
      return null;
    }

    const args = [
      entryScript,
      'web',
      'serve',
      '--port',
      String(options.port),
      '--host',
      options.host,
    ];
    if (options.refreshSeconds !== undefined) {
      args.push('--refresh', String(options.refreshSeconds));
    }

    const spawnFn = monitorOptions.spawn ?? nodeSpawn;
    try {
      const child = spawnFn(execPath, args, { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (err) {
      warn(
        `Web monitor: failed to start the detached server (${err instanceof Error ? err.message : String(err)}). Continuing without the web server.`,
      );
      return null;
    }

    const timeoutMs = monitorOptions.claimTimeoutMs ?? DETACHED_CLAIM_TIMEOUT_MS;
    const pollMs = monitorOptions.claimPollIntervalMs ?? DETACHED_CLAIM_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const claimed = await detectActiveInstance(lockFile);
      if (claimed !== null) {
        const handle = reusedHandle(claimed);
        const health = await probeHealth(claimed.host, claimed.port);
        if (monitorOptions.restart) {
          const version = health?.version === undefined ? '' : `, version ${health.version}`;
          info(
            `Web monitor: new instance started (pid ${claimed.pid}${version}) at ${chalk.bold.cyan(handle.url)}`,
          );
        } else {
          info(`Web monitor running at ${chalk.bold.cyan(handle.url)}`);
        }
        return handle;
      }
      await sleep(pollMs);
    }

    warn(
      'Web monitor: the detached server did not start in time. Continuing without the web server.',
    );
    return null;
  } finally {
    await restartLease?.release();
  }
}
