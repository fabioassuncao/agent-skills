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

/**
 * Bind (or defer to) the single web monitor instance and keep the process
 * alive for as long as it stays bound.
 *
 * `issue-flow web serve` is now an alias of `issue-flow serve` (§47.4). One
 * body, not two: the lock, the detached-spawn contract and the silence on the
 * happy path are unchanged, and the only difference the rename could have
 * introduced — a second way to bind — is exactly what `web/AGENTS.md` forbids.
 */
export async function runWebServe(options: RunWebServeOptions): Promise<number> {
  return runServe(options);
}

/** Stop the single running web monitor instance, if any. */
export async function runWebStop(): Promise<number> {
  const webConfig = await loadWebConfig();
  const result = await stopWebMonitor({ port: webConfig.port, host: webConfig.host });
  return result === 'failed' || result === 'unowned' ? 1 : 0;
}
