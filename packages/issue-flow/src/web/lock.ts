import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';
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

/** How long a health probe against a candidate instance waits before giving up. */
const HEALTH_PROBE_TIMEOUT_MS = 1000;

/**
 * A process that loses the atomic lock creation retries this many times,
 * waiting for the winner to finish starting up, before giving up.
 */
const LOCK_CLAIM_RETRIES = 5;
const LOCK_CLAIM_RETRY_DELAY_MS = 100;

export function getWebLockFile(options: GetGlobalRootOptions = {}): string {
  return join(getGlobalRoot(options), WEB_LOCK_FILENAME);
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

async function probeHealth(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(probeUrl(host, port), {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
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

  if (isProcessAlive(lock.pid) && (await probeHealth(lock.host, lock.port))) {
    return lock;
  }

  await removeWebLock(lockFile);
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

/** Handle returned when reusing an already-running instance instead of
 * binding a new one — there is no local `Server` to hold, and closing it
 * must not tear down a server another process owns. */
function reusedHandle(lock: WebLock): WebServerHandle {
  const displayHost = lock.host === '0.0.0.0' ? 'localhost' : lock.host;
  return {
    host: lock.host,
    port: lock.port,
    url: `http://${displayHost}:${lock.port}`,
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
  try {
    lockFile = getWebLockFile(monitorOptions);
  } catch (err) {
    warn(
      `Web monitor: global storage unavailable (${err instanceof Error ? err.message : String(err)}). Falling back to legacy in-process mode.`,
    );
    return startWebServer(options);
  }

  const active = await detectActiveInstance(lockFile);
  if (active !== null) {
    info(`Reusing existing web monitor at ${reusedHandle(active).url}`);
    return reusedHandle(active);
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
      info(`Web monitor running at ${chalk.bold.cyan(reusedHandle(claimed).url)}`);
      return reusedHandle(claimed);
    }
    await sleep(pollMs);
  }

  warn(
    'Web monitor: the detached server did not start in time. Continuing without the web server.',
  );
  return null;
}
