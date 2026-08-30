import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isProcessAlive, isRunLockStale, readRunLock } from '../storage/lock.js';
import {
  type GetGlobalRootOptions,
  getGlobalRoot,
  getIssuePaths,
  PROJECTS_DIR_NAME,
  RUN_LOCK_FILENAME,
} from '../storage/paths.js';
import type { RunLock } from '../storage/schemas.js';
import { readSessionFile } from '../storage/session-file.js';

export type LiveRunStatus = 'running' | 'unsignaled' | 'orphan';

export interface LiveRun {
  projectId: string;
  target: string;
  pid: number;
  host: string;
  detached: boolean;
  status: LiveRunStatus;
  startedAt: string;
  lastHeartbeatAt: string;
  issue: number | null;
  phase: string | null;
  storiesCompleted: number | null;
  storiesTotal: number | null;
  elapsedSeconds: number | null;
  lockFile: string;
}

export function classifyRunLock(lock: RunLock): LiveRunStatus {
  if (!isProcessAlive(lock.pid)) return 'orphan';
  if (isRunLockStale(lock)) return 'unsignaled';
  return 'running';
}

/**
 * Every run.lock under the global projects tree, enriched with session.json
 * when one exists. The lock is the source of truth for existence; the
 * snapshot only fills phase and progress.
 */
export async function listLiveRuns(options: GetGlobalRootOptions = {}): Promise<LiveRun[]> {
  const root = getGlobalRoot(options);
  const projectsDir = join(root, PROJECTS_DIR_NAME);
  let projectIds: string[];
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    projectIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }

  const runs = await Promise.all(
    projectIds.map(async (projectId) => {
      const lockFile = join(projectsDir, projectId, RUN_LOCK_FILENAME);
      const lock = await readRunLock(lockFile);
      if (lock === null) return null;
      return enrichRun(projectId, lockFile, lock, options);
    }),
  );

  return runs
    .filter((run): run is LiveRun => run !== null)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

async function enrichRun(
  projectId: string,
  lockFile: string,
  lock: RunLock,
  options: GetGlobalRootOptions,
): Promise<LiveRun> {
  const session = await readSessionFile(getIssuePaths(projectId, lock.target, options).sessionFile);

  return {
    projectId,
    target: lock.target,
    pid: lock.pid,
    host: lock.host,
    detached: lock.detached === true,
    status: classifyRunLock(lock),
    startedAt: lock.startedAt,
    lastHeartbeatAt: lock.lastHeartbeatAt,
    issue: session?.snapshot.issue.number ?? numericTarget(lock.target),
    phase: session?.snapshot.currentPhase ?? null,
    storiesCompleted: session?.snapshot.progress.storiesCompleted ?? null,
    storiesTotal: session?.snapshot.progress.storiesTotal ?? null,
    elapsedSeconds: session?.snapshot.elapsedSeconds ?? null,
    lockFile,
  };
}

function numericTarget(target: string): number | null {
  return /^\d+$/.test(target) ? Number(target) : null;
}
