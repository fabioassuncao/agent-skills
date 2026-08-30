import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IssuePaths } from '../storage/paths.js';
import { rotateRunLogIfNeeded } from '../storage/run-log.js';

export function backgroundRejection(mode: string, env = process.env): string | null {
  if (mode === 'manual') {
    return '--background cannot be used with --mode manual: a detached run cannot answer prompts.';
  }
  const ci = env.CI;
  const inCi = ci !== undefined && ci !== '' && ci !== '0' && ci.toLowerCase() !== 'false';
  if (inCi || !process.stdout.isTTY) {
    return '--background needs an interactive terminal. In CI, run in the foreground so the exit code is visible.';
  }
  return null;
}

/** Strip detach flags and mark the child so it does not detach again. */
export function childArgv(argv: readonly string[]): string[] {
  const next: string[] = [];
  for (const arg of argv) {
    if (arg === '--background' || arg === '-d') continue;
    next.push(arg);
  }
  next.push('--detached-child');
  return next;
}

export interface SpawnDetachedRunInput {
  paths: IssuePaths;
  execPath?: string;
  entryScript?: string;
  argv?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
}

export async function spawnDetachedRun(
  input: SpawnDetachedRunInput,
): Promise<{ pid: number; logFile: string }> {
  const entryScript = input.entryScript ?? process.argv[1];
  if (entryScript === undefined) {
    throw new Error('Could not determine the CLI entry point to spawn a detached run.');
  }

  await mkdir(dirname(input.paths.runLogFile), { recursive: true });
  await rotateRunLogIfNeeded(input.paths.runLogFile, input.paths.rotatedRunLogFile);

  const log = await open(input.paths.runLogFile, 'a');
  try {
    const args = [entryScript, ...childArgv((input.argv ?? process.argv.slice(2)).slice())];
    const spawnFn = input.spawnFn ?? spawn;
    const child = spawnFn(input.execPath ?? process.execPath, args, {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      cwd: input.cwd ?? process.cwd(),
      env: input.env ?? process.env,
    });
    if (child.pid === undefined) {
      throw new Error('The detached run started but reported no pid.');
    }
    child.unref();
    return { pid: child.pid, logFile: input.paths.runLogFile };
  } finally {
    await log.close();
  }
}
