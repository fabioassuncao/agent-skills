import { basename, join, resolve } from 'node:path';
import { loadGlobalConfig, readProjectConfigFile } from '../config/sources.js';
import { bindTelemetry } from '../telemetry/recorder.js';
import { printInfo } from '../ui/logger.js';
import { getProjectRoot } from '../utils/git.js';
import {
  directoryExists,
  ensureWorkspaceStorageIgnored,
  selectArtifactStorage,
  WORKSPACE_STORAGE_DIR,
} from './artifact-storage.js';
import { registerProjectDatabaseOptions, resetProjectDatabaseOptions } from './db/index.js';
import {
  registerPlanRepository,
  registerQueueRepository,
  registerStorageProjections,
  resetPlanRepositories,
  type StoredRetentionPolicy,
} from './db/repository.js';
import {
  type GetGlobalRootOptions,
  GLOBAL_ROOT_ENV,
  getGlobalRoot,
  getIssuePathsAt,
  getProjectId,
  getQueuePathsAt,
  ISSUES_DIR_NAME,
  type IssuePaths,
  type QueuePaths,
  RUN_LOCK_FILENAME,
} from './paths.js';
import { storageConfigInputSchema } from './schemas.js';

export interface ResolveIssuePathsOptions extends GetGlobalRootOptions {
  projectRoot?: string;
  notice?: (message: string) => void;
}

interface ProjectResolution {
  projectId: string;
  projectDir: string;
  storageMode: 'global' | 'workspace';
  databaseOptions: GetGlobalRootOptions;
  retention?: StoredRetentionPolicy;
}

const projectCache = new Map<string, Promise<ProjectResolution>>();

export function resetStorageResolutionCache(): void {
  projectCache.clear();
  resetPlanRepositories();
  resetProjectDatabaseOptions();
}

function databaseOptionsFor(
  projectRoot: string,
  storageMode: 'global' | 'workspace',
  options: ResolveIssuePathsOptions,
): GetGlobalRootOptions {
  if (storageMode === 'global') return options.env === undefined ? {} : { env: options.env };
  return {
    env: {
      ...(options.env ?? process.env),
      [GLOBAL_ROOT_ENV]: join(projectRoot, WORKSPACE_STORAGE_DIR),
    },
  };
}

async function loadRetention(
  projectRoot: string,
  options: ResolveIssuePathsOptions,
): Promise<StoredRetentionPolicy | undefined> {
  const warn = options.notice ?? printInfo;
  const [global, project] = await Promise.all([
    loadGlobalConfig({ env: options.env, warn }),
    readProjectConfigFile(projectRoot, warn),
  ]);
  const parsed = storageConfigInputSchema.safeParse(project?.storage);
  if (!parsed.success && project?.storage !== undefined) {
    throw new Error(
      `Invalid storage configuration: ${parsed.error.issues[0]?.message ?? 'invalid value'}`,
    );
  }
  return parsed.success
    ? (parsed.data.retention ?? global.storage?.retention)
    : global.storage?.retention;
}

async function resolveProject(
  projectRoot: string,
  options: ResolveIssuePathsOptions,
): Promise<ProjectResolution> {
  const projectId = await getProjectId(projectRoot);
  const workspaceIssuesDir = join(projectRoot, WORKSPACE_STORAGE_DIR, ISSUES_DIR_NAME);
  const selected = selectArtifactStorage(
    projectRoot,
    getGlobalRoot(options),
    projectId,
    await directoryExists(workspaceIssuesDir),
  );
  const databaseOptions = databaseOptionsFor(projectRoot, selected.storageMode, options);
  registerProjectDatabaseOptions(projectId, databaseOptions);
  if (selected.storageMode === 'workspace') await ensureWorkspaceStorageIgnored(projectRoot);
  return {
    projectId,
    projectDir: selected.projectDir,
    storageMode: selected.storageMode,
    databaseOptions,
    retention: await loadRetention(projectRoot, options),
  };
}

function getProjectResolution(
  projectRoot: string,
  options: ResolveIssuePathsOptions,
): Promise<ProjectResolution> {
  const key = `${getGlobalRoot(options)}::${projectRoot}`;
  const cached = projectCache.get(key);
  if (cached) return cached;
  const pending = resolveProject(projectRoot, options).catch((error) => {
    projectCache.delete(key);
    throw error;
  });
  projectCache.set(key, pending);
  return pending;
}

export interface ProjectStoragePaths {
  projectId: string;
  storageMode: 'global' | 'workspace';
  databaseOptions: GetGlobalRootOptions;
  projectDir: string;
  issuesDir: string;
  runLockFile: string;
  providerHealthContext: {
    tasksPath: string;
    projectId: string;
    issueId: string;
    projectRoot: string;
    databaseOptions: GetGlobalRootOptions;
    retention?: StoredRetentionPolicy;
  };
}

export async function resolveProjectPaths(
  options: ResolveIssuePathsOptions = {},
): Promise<ProjectStoragePaths> {
  const { projectRoot: projectRootOption, ...rootOptions } = options;
  const projectRoot = resolve(projectRootOption ?? (await getProjectRoot()));
  const project = await getProjectResolution(projectRoot, rootOptions);
  return {
    projectId: project.projectId,
    storageMode: project.storageMode,
    databaseOptions: project.databaseOptions,
    projectDir: project.projectDir,
    issuesDir: join(project.projectDir, ISSUES_DIR_NAME),
    runLockFile: join(project.projectDir, RUN_LOCK_FILENAME),
    providerHealthContext: {
      tasksPath: join(project.projectDir, 'provider-health'),
      projectId: project.projectId,
      issueId: 'provider-health',
      projectRoot,
      databaseOptions: project.databaseOptions,
      retention: project.retention,
    },
  };
}

export async function resolveQueuePaths(
  queueId: string | number,
  options: ResolveIssuePathsOptions = {},
): Promise<QueuePaths> {
  const { projectRoot: projectRootOption, ...rootOptions } = options;
  const projectRoot = resolve(projectRootOption ?? (await getProjectRoot()));
  const project = await getProjectResolution(projectRoot, rootOptions);
  const paths = getQueuePathsAt(project.projectDir, queueId);
  registerQueueRepository({
    planFile: paths.planFile,
    projectId: project.projectId,
    projectRoot,
    databaseOptions: project.databaseOptions,
    retention: project.retention,
  });
  return paths;
}

export async function resolveIssuePaths(
  issueNumber: string | number,
  options: ResolveIssuePathsOptions = {},
): Promise<IssuePaths> {
  const { projectRoot: projectRootOption, ...rootOptions } = options;
  const projectRoot = resolve(projectRootOption ?? (await getProjectRoot()));
  const project = await getProjectResolution(projectRoot, rootOptions);
  const paths = getIssuePathsAt(project.projectDir, issueNumber);
  const context = {
    tasksPath: paths.tasksFile,
    projectId: project.projectId,
    issueId: basename(paths.issueDir),
    projectRoot,
    databaseOptions: project.databaseOptions,
    retention: project.retention,
  };
  registerPlanRepository(context);
  registerStorageProjections({
    context,
    verifyFile: paths.verifyFile,
    lastBranchFile: paths.lastBranchFile,
  });
  bindTelemetry({ tasksPath: paths.tasksFile });
  return paths;
}
