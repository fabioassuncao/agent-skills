import { loadWebConfig } from '../config.js';
import { stopWebMonitor } from '../web/lock.js';
import { type RunServeOptions, runServe } from './serve.js';

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

export type RunWebServeOptions = RunServeOptions;

export async function runWebServe(options: RunWebServeOptions): Promise<number> {
  return runServe(options);
}

/** Stop the single running web monitor instance, if any. */
export async function runWebStop(): Promise<number> {
  const webConfig = await loadWebConfig();
  const result = await stopWebMonitor({ port: webConfig.port, host: webConfig.host });
  return result === 'failed' || result === 'unowned' ? 1 : 0;
}
