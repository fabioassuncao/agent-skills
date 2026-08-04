import { loadWebConfig } from '../config.js';
import type { WebConfig } from '../schemas.js';
import { printError, printInfo, printWarning } from '../ui/logger.js';
import { ensureSingleWebServer, getWebLockFile, readWebLock, removeWebLock } from '../web/lock.js';
import { watchSessionDirectory } from '../web/session-directory.js';

/**
 * `issue-flow web serve` / `issue-flow web stop` (US-002).
 *
 * `serve` is the process `ensureWebMonitor()` (`web/lock.ts`) spawns detached
 * — it is not meant to be run interactively, though nothing stops a user from
 * doing so to watch every session on the machine without going through a
 * pipeline command first. It never exits on its own: the server stays bound
 * (see `unref: false` in `web/server.ts`) until `stop` sends it `SIGTERM`, at
 * which point `startWebServer`'s own signal handler closes it (removing the
 * lock) and re-raises the signal for the default termination behavior.
 */

const STOP_POLL_INTERVAL_MS = 100;
const STOP_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RunWebServeOptions {
  port?: number;
  host?: string;
  refresh?: number;
}

/**
 * Bind (or defer to) the single web monitor instance and keep the process
 * alive for as long as it stays bound. Logging is intentionally silent on the
 * happy path: this process is spawned with `stdio: 'ignore'`, so anything
 * printed here goes nowhere — the caller (`ensureWebMonitor`) is the one that
 * tells the user the server is up.
 */
export async function runWebServe(options: RunWebServeOptions): Promise<number> {
  // Built conditionally, not `{ port: options.port, ... }`: loadWebConfig()
  // spreads this object directly over the lower-precedence layers, and an
  // explicit `undefined` value would overwrite an env/.issue-flow.json
  // setting instead of falling through to it (only an *absent* key does).
  const cli: Partial<WebConfig> = {};
  if (options.port !== undefined) cli.port = options.port;
  if (options.host !== undefined) cli.host = options.host;
  if (options.refresh !== undefined) cli.refreshSeconds = options.refresh;
  const webConfig = await loadWebConfig({ cli });

  const sessions = watchSessionDirectory();

  const noop = (): void => {};
  const handle = await ensureSingleWebServer({
    sessions,
    port: webConfig.port,
    host: webConfig.host,
    refreshSeconds: webConfig.refreshSeconds,
    unref: false,
    info: noop,
    warn: noop,
  });

  if (handle === null) {
    sessions.close();
    return 1;
  }

  if (handle.server === undefined) {
    // Another instance already won the race (or was already running by the
    // time this process got here): nothing to serve, so it exits right away
    // instead of idling as a redundant detached process.
    sessions.close();
    return 0;
  }

  const originalClose = handle.close;
  handle.close = async () => {
    await originalClose();
    sessions.close();
  };

  return 0;
}

/** Stop the single running web monitor instance, if any. */
export async function runWebStop(): Promise<number> {
  const lockFile = getWebLockFile();
  const lock = await readWebLock(lockFile);
  if (lock === null) {
    printInfo('No web monitor is currently running.');
    return 0;
  }

  try {
    process.kill(lock.pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      printWarning(
        'The web monitor lock referenced a process that is no longer running; removing it.',
      );
      await removeWebLock(lockFile);
      return 0;
    }
    printError(
      `Failed to stop the web monitor: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await readWebLock(lockFile)) === null) {
      printInfo(`Web monitor (pid ${lock.pid}) stopped.`);
      return 0;
    }
    await sleep(STOP_POLL_INTERVAL_MS);
  }

  printWarning('Sent the stop signal, but the web monitor did not confirm shutdown in time.');
  return 0;
}
