import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { listStoredRunSnapshots, type StoredSession } from '../storage/db/repository.js';
import { isProcessAlive, isRunLockStale, readRunLock } from '../storage/lock.js';
import {
  type GetGlobalRootOptions,
  getGlobalRoot,
  getIssuePaths,
  PROJECTS_DIR_NAME,
  RUN_LOCK_FILENAME,
  UNIT_LOCKS_DIR_NAME,
} from '../storage/paths.js';
import { createProjectRegistry, type ProjectRegistry } from '../storage/projects/registry.js';
import type { RunLock } from '../storage/schemas.js';
import { readSessionFile } from '../storage/session-file.js';

export type LiveRunStatus = 'running' | 'unsignaled' | 'orphan';

export interface LiveRun {
  projectId: string;
  /**
   * The project's label from the registry, `null` when it has none.
   *
   * Additive on purpose: a consumer that only knew `projectId` keeps working,
   * and one that can show a name no longer has to print a slug plus a hash at
   * the user (§47.5).
   */
  projectName: string | null;
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
 * Every run lock under the global projects tree, enriched from indexed SQLite
 * run/snapshot rows. The lock remains the source of truth for existence and
 * liveness; the database only fills phase and progress.
 *
 * "Every lock" means both shapes a run can hold (§31.3): the project-wide
 * `run.lock`, and — once `runtime.maxConcurrent` is above 1 — one lock per
 * execution unit under `locks/`. Reading only the first would make `ps` blind
 * exactly when there is more than one run to see.
 */
export interface ListLiveRunsOptions extends GetGlobalRootOptions {
  storageDriver?: 'sqlite' | 'json';
  /** Project labels. Injected for tests; reads are tolerant and never throw. */
  registry?: ProjectRegistry;
}

/**
 * Where a run's lock can be, for one project.
 *
 * `run.lock` is the project-wide one, always looked for. `locks/*.lock` is the
 * per-unit shape, which only exists once a project has actually run with a
 * raised `runtime.maxConcurrent` — a missing directory is the ordinary case and
 * means no unit lock has ever been taken here, not an error.
 */
async function runLockFilesOf(
  projectsDir: string,
  projectId: string,
): Promise<Array<{ projectId: string; lockFile: string }>> {
  const files = [join(projectsDir, projectId, RUN_LOCK_FILENAME)];
  const unitDir = join(projectsDir, projectId, UNIT_LOCKS_DIR_NAME);
  try {
    for (const name of await readdir(unitDir)) {
      if (name.endsWith('.lock')) files.push(join(unitDir, name));
    }
  } catch {
    // No directory: this project has never taken a per-unit lock.
  }
  return files.map((lockFile) => ({ projectId, lockFile }));
}

export async function listLiveRuns(options: ListLiveRunsOptions = {}): Promise<LiveRun[]> {
  const root = getGlobalRoot(options);
  const projectsDir = join(root, PROJECTS_DIR_NAME);
  let projectIds: string[];
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    projectIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }

  const registry =
    options.registry ??
    createProjectRegistry({
      databaseOptions: options.env === undefined ? {} : { env: options.env },
    });
  const names = new Map(
    (await registry.list()).map((project) => [project.id, project.name] as const),
  );

  const stored =
    options.storageDriver === 'json'
      ? []
      : await listStoredRunSnapshots({
          ...(options.env === undefined ? {} : { databaseOptions: { env: options.env } }),
        }).catch(() => []);
  const byProjectIssue = new Map(
    stored.map((session) => [`${session.projectId}:${session.issueId}`, session]),
  );
  const candidates = (
    await Promise.all(projectIds.map((projectId) => runLockFilesOf(projectsDir, projectId)))
  ).flat();

  const runs = await Promise.all(
    candidates.map(async ({ projectId, lockFile }) => {
      const lock = await readRunLock(lockFile);
      if (lock === null) return null;
      const session =
        options.storageDriver === 'json'
          ? await readSessionFile(getIssuePaths(projectId, lock.target, options).sessionFile).then(
              (result) =>
                result === null
                  ? undefined
                  : {
                      projectId,
                      issueId: lock.target,
                      sessionId: String(result.snapshot.sessionId ?? ''),
                      snapshot: result.snapshot,
                      updatedAt: new Date(result.updatedAtMs).toISOString(),
                    },
            )
          : byProjectIssue.get(`${projectId}:${lock.target}`);
      return enrichRun(projectId, names.get(projectId) ?? null, lockFile, lock, session);
    }),
  );

  return runs
    .filter((run): run is LiveRun => run !== null)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function enrichRun(
  projectId: string,
  projectName: string | null,
  lockFile: string,
  lock: RunLock,
  session: StoredSession | undefined,
): LiveRun {
  return {
    projectId,
    projectName,
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
