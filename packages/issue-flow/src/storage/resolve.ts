import { stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  loadGlobalConfig,
  PROJECT_CONFIG_FILENAME,
  readProjectConfigFile,
} from '../config/sources.js';
import { bindTelemetry } from '../telemetry/recorder.js';
import { printInfo } from '../ui/logger.js';
import { getProjectRoot } from '../utils/git.js';
import { type MigrationResult, migrateLegacyStorage, resolveStorageMode } from './compat.js';
import { importProjectArtifacts } from './db/import.js';
import { getDatabasePath } from './db/index.js';
import {
  registerPlanRepository,
  registerQueueRepository,
  registerStorageProjections,
  resetPlanRepositories,
  type StoredRetentionPolicy,
} from './db/repository.js';
import {
  type GetGlobalRootOptions,
  getGlobalRoot,
  getIssuePaths,
  getProjectDir,
  getQueuePaths,
  ISSUES_DIR_NAME,
  type IssuePaths,
  PROVIDERS_HEALTH_FILENAME,
  type QueuePaths,
  RUN_LOCK_FILENAME,
} from './paths.js';
import { storageConfigInputSchema } from './schemas.js';

/**
 * The single entry point every pipeline command uses to learn where an issue's
 * artifacts live.
 *
 * `paths.ts` and `compat.ts` stay pure and explicit — they take a `projectId` or
 * a `projectRoot` and never decide anything on their own. This module is the
 * opposite end: it knows the current repository, resolves the storage mode,
 * triggers the legacy migration when one is due, and caches all of that for the
 * lifetime of the process, so a call site is reduced to one line.
 *
 * It deliberately does **not** create the issue directory. Callers that write
 * keep doing their own `mkdir(..., { recursive: true })`, which preserves the
 * rule in `storage/CLAUDE.md` that path resolution never touches the
 * filesystem's shape.
 */

export interface ResolveIssuePathsOptions extends GetGlobalRootOptions {
  /**
   * Repository root. Defaults to {@link getProjectRoot}, i.e. the git toplevel
   * of the current working directory — which is what makes the result identical
   * from the repo root and from any subdirectory.
   */
  projectRoot?: string;
  /** Diagnostics are separate from structured command output. */
  notice?: (message: string) => void;
}

/** Everything the process needs to know about a project, resolved once. */
interface ProjectResolution {
  projectId: string;
  legacyDir: string;
  /** JSON remains active after a failed import or an explicit compatibility setting. */
  driver: 'sqlite' | 'json';
  retention?: StoredRetentionPolicy;
}

interface StorageResolutionConfig {
  driver: 'sqlite' | 'json';
  backupRetention?: number;
  retention?: StoredRetentionPolicy & { backups?: number };
}

/** Resolve only the storage knobs; invalid project input safely uses defaults. */
async function loadStorageResolutionConfig(
  projectRoot: string,
  options: ResolveIssuePathsOptions,
): Promise<StorageResolutionConfig> {
  const global = await loadGlobalConfig({ env: options.env, warn: options.notice ?? printInfo });
  const project = await readProjectConfigFile(projectRoot, options.notice ?? printInfo);
  const parsedProject = storageConfigInputSchema.safeParse(project?.storage);
  if (!parsedProject.success && project?.storage !== undefined) {
    (options.notice ?? printInfo)(
      `Ignoring "storage" key of ${PROJECT_CONFIG_FILENAME}: ${parsedProject.error.issues[0]?.message ?? 'invalid value'}.`,
    );
  }
  return {
    driver: parsedProject.success
      ? (parsedProject.data.driver ?? global.storage?.driver ?? 'sqlite')
      : (global.storage?.driver ?? 'sqlite'),
    backupRetention:
      (parsedProject.success ? parsedProject.data.backupRetention : undefined) ??
      global.storage?.backupRetention,
    retention:
      (parsedProject.success ? parsedProject.data.retention : undefined) ??
      global.storage?.retention,
  };
}

/**
 * Cached project resolutions, keyed by `<globalRoot>::<projectRoot>`.
 *
 * `projectRoot` is the identity of the project, but the global root takes part
 * in the key as well: `ISSUE_FLOW_HOME` decides *where* the resolution lands,
 * so two different roots must never share an entry (that would silently hand a
 * test the previous test's tree).
 *
 * The cached value is the in-flight promise rather than its result, so two
 * commands resolving concurrently share a single git call instead of racing
 * into two migrations.
 */
const projectCache = new Map<string, Promise<ProjectResolution>>();

/**
 * Issues whose global directory has already been checked in this process, so
 * the per-issue fallback below stats each issue at most once.
 */
const checkedIssues = new Set<string>();

/**
 * Drop every cached resolution.
 *
 * Exported for tests: the cache is keyed by project and global root, so a suite
 * that moves `ISSUE_FLOW_HOME` between cases must reset it in `beforeEach`.
 */
export function resetStorageResolutionCache(): void {
  projectCache.clear();
  checkedIssues.clear();
  // The path-to-repository registry has the same process lifetime as this
  // resolver cache. Clearing one without the other would leak a test's
  // temporary database into the next resolution.
  resetPlanRepositories();
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Tell the user that their artifacts moved, and that nothing was taken away.
 *
 * A migration that copied nothing stays silent: `migrateLegacyStorage` is
 * called speculatively (once per project, then once per issue seen for the
 * first time), and every one of those runs after the first copies zero files.
 * Printing on those would turn a one-time notice into noise on every command.
 *
 * The "one notice per process" guarantee falls out of the US-001 cache: the
 * project-level migration runs once, and the per-issue fallback only reaches a
 * second migration when an issue really is still legacy-only — in which case a
 * notice is the correct output, not a duplicate.
 */
function announceMigration(result: MigrationResult, notice = printInfo): void {
  if (result.copied.length === 0) return;

  const count = result.copied.length;
  const target = join(result.globalDir, ISSUES_DIR_NAME);

  notice(`Migrated ${count} file${count === 1 ? '' : 's'} from ${result.legacyDir} to ${target}`);
  notice(
    `The legacy directory was not modified or removed — ${result.legacyDir} is kept as-is, read-only, for compatibility.`,
  );
}

/**
 * Resolve the project id, migrating the legacy tree when it is the only thing
 * that exists yet.
 *
 * A migration failure is not swallowed: `migrateLegacyStorage` already names the
 * issue and file that failed and states that the legacy directory was left
 * untouched, which is exactly what the user needs to fix it and retry.
 */
async function resolveProject(
  projectRoot: string,
  options: ResolveIssuePathsOptions,
): Promise<ProjectResolution> {
  // resolveStorageMode returns the project id *and* the remote in a single git
  // call — calling getProjectId() afterwards would shell out to
  // `git remote get-url origin` a second time for the same answer.
  const status = await resolveStorageMode(projectRoot, options);
  const storage = await loadStorageResolutionConfig(projectRoot, options);

  if (status.mode === 'needs-migration') {
    announceMigration(
      await migrateLegacyStorage(projectRoot, options),
      options.notice ?? printInfo,
    );
  }

  const imported =
    storage.driver === 'sqlite'
      ? await importProjectArtifacts({
          ...options,
          projectId: status.projectId,
          projectDir: status.globalDir,
          projectRoot,
          remoteUrl: status.remoteUrl,
          ...((storage.retention?.backups ?? storage.backupRetention) === undefined
            ? {}
            : { backupRetention: storage.retention?.backups ?? storage.backupRetention }),
          ...(storage.retention === undefined ? {} : { retention: storage.retention }),
          onWarning: options.notice ?? printInfo,
        })
      : null;
  if (imported !== null && imported.imported > 0) {
    const counts = Object.entries(imported.tableCounts)
      .filter(([, count]) => count > 0)
      .map(([table, count]) => `${table}: ${count}`)
      .join(', ');
    (options.notice ?? printInfo)(
      `Imported ${imported.imported} structured artifact${imported.imported === 1 ? '' : 's'} from ${status.globalDir} into ${getDatabasePath(options)} (${counts || 'no rows'}). No source artifacts were removed.`,
    );
  }

  return {
    projectId: status.projectId,
    legacyDir: status.legacyDir,
    // An import failure is a successful *resolution* through the JSON
    // compatibility path. Do not subsequently register a SQLite repository,
    // or telemetry would create a fresh empty database and hide the fallback.
    driver: imported?.failed === true ? 'json' : storage.driver,
    retention: storage.retention,
  };
}

/** Cached half of {@link resolveIssuePaths}: one git call per project, per process. */
function getProjectResolution(
  projectRoot: string,
  options: ResolveIssuePathsOptions,
): Promise<ProjectResolution> {
  const key = `${getGlobalRoot(options)}::${projectRoot}`;

  const cached = projectCache.get(key);
  if (cached) return cached;

  // A rejected resolution is evicted so the next command retries instead of
  // inheriting a permanently failed promise.
  const pending = resolveProject(projectRoot, options).catch((err) => {
    projectCache.delete(key);
    throw err;
  });

  projectCache.set(key, pending);
  return pending;
}

/** Project-level directories of the current repository inside the global tree. */
export interface ProjectStoragePaths {
  /** Deterministic id derived from the repository's remote (or its path). */
  projectId: string;
  /** Active structured-state driver after migration/recovery resolution. */
  storageDriver: 'sqlite' | 'json';
  /** `<globalRoot>/projects/<projectId>`. */
  projectDir: string;
  /** `<projectDir>/issues` — the parent of every issue directory. */
  issuesDir: string;
  /**
   * `<projectDir>/run.lock` — who is running in this project right now.
   *
   * Project-level rather than per issue on purpose: two runs in one repository
   * share a working tree and a branch, so "a different issue" is not a
   * different lock.
   */
  runLockFile: string;
  /** `<projectDir>/providers.json` — persisted health/cooldown per agent provider. */
  providersHealthFile: string;
}

/**
 * Resolve the project-level directories, without naming an issue.
 *
 * The issue-agnostic half of {@link resolveIssuePaths}, for the two questions
 * that are about the project rather than about one issue: "can I write here?"
 * (`LocalFileIssueProvider.isAvailable`) and "which identifiers are taken?"
 * (`highestLocalNumber`, which walks `issuesDir`). It shares the same cache, so
 * asking here and then resolving an issue still costs a single git call.
 *
 * Like the rest of this module it creates nothing — a caller that needs the
 * directory to exist does its own `mkdir(..., { recursive: true })`.
 */
export async function resolveProjectPaths(
  options: ResolveIssuePathsOptions = {},
): Promise<ProjectStoragePaths> {
  const { projectRoot: projectRootOption, ...rootOptions } = options;
  const projectRoot = resolve(projectRootOption ?? (await getProjectRoot()));

  const project = await getProjectResolution(projectRoot, rootOptions);
  const projectDir = getProjectDir(project.projectId, rootOptions);
  const providersHealthFile = join(projectDir, PROVIDERS_HEALTH_FILENAME);
  if (project.driver === 'sqlite') {
    registerStorageProjections({
      context: {
        tasksPath: '',
        projectId: project.projectId,
        issueId: '',
        projectRoot,
        retention: project.retention,
      },
      providersHealthFile,
    });
  }

  return {
    projectId: project.projectId,
    storageDriver: project.driver,
    projectDir,
    issuesDir: join(projectDir, ISSUES_DIR_NAME),
    runLockFile: join(projectDir, RUN_LOCK_FILENAME),
    providersHealthFile,
  };
}

/**
 * Resolve the paths of a multi-issue execution queue in the current project.
 *
 * Shares the project cache with {@link resolveIssuePaths}, so a run that
 * resolves both still costs a single git call. There is no legacy tree for
 * queues — the concept did not exist before — so no migration is attempted.
 */
export async function resolveQueuePaths(
  queueId: string | number,
  options: ResolveIssuePathsOptions = {},
): Promise<QueuePaths> {
  const { projectRoot: projectRootOption, ...rootOptions } = options;
  const projectRoot = resolve(projectRootOption ?? (await getProjectRoot()));

  const project = await getProjectResolution(projectRoot, rootOptions);
  const paths = getQueuePaths(project.projectId, queueId, rootOptions);
  if (project.driver === 'sqlite') {
    registerQueueRepository({
      planFile: paths.planFile,
      projectId: project.projectId,
      projectRoot,
      retention: project.retention,
    });
  }
  return paths;
}

/**
 * Resolve every path of `issueNumber` under the global storage, migrating the
 * legacy `<projectRoot>/issues/` tree first when needed.
 *
 * The migration is triggered in two situations:
 *
 * 1. project level — the global project directory does not exist at all and the
 *    legacy one does (`mode === 'needs-migration'`);
 * 2. issue level — the project directory exists (so the mode is already
 *    `global`) but *this* issue is only present in the legacy tree. That
 *    happens whenever a project was migrated before an older issue was ever
 *    read, or when a collaborator on a previous version added an issue to the
 *    legacy directory afterwards. Re-running the migration is cheap and safe:
 *    it skips every destination that already exists.
 */
export async function resolveIssuePaths(
  issueNumber: string | number,
  options: ResolveIssuePathsOptions = {},
): Promise<IssuePaths> {
  const { projectRoot: projectRootOption, ...rootOptions } = options;
  const projectRoot = resolve(projectRootOption ?? (await getProjectRoot()));

  const project = await getProjectResolution(projectRoot, rootOptions);
  const paths = getIssuePaths(project.projectId, issueNumber, rootOptions);

  if (!checkedIssues.has(paths.issueDir)) {
    // `getIssuePaths` already validated and normalized the identifier, so the
    // last segment of issueDir is the safe form to look for under the legacy
    // tree.
    const legacyIssueDir = join(project.legacyDir, basename(paths.issueDir));

    if (!(await directoryExists(paths.issueDir)) && (await directoryExists(legacyIssueDir))) {
      announceMigration(await migrateLegacyStorage(projectRoot, rootOptions));
    }

    // Marked only once the check completed: a failed migration must be retried
    // by the next command, not remembered as done.
    checkedIssues.add(paths.issueDir);
  }

  if (project.driver === 'sqlite') {
    const context = {
      tasksPath: paths.tasksFile,
      projectId: project.projectId,
      issueId: basename(paths.issueDir),
      projectRoot,
      retention: project.retention,
    };
    registerPlanRepository(context);
    registerStorageProjections({
      context,
      verifyFile: paths.verifyFile,
      lastBranchFile: paths.lastBranchFile,
      providersHealthFile: join(
        getProjectDir(project.projectId, rootOptions),
        PROVIDERS_HEALTH_FILENAME,
      ),
    });
    bindTelemetry({ tasksPath: paths.tasksFile });
  } else {
    // The legacy state manager remains authoritative in JSON mode. Leaving a
    // telemetry binding here would lazily bootstrap a SQLite projection.
    bindTelemetry(null);
  }
  return paths;
}
