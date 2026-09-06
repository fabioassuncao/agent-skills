import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importProjectArtifacts } from '../storage/db/import.js';
import { getDatabasePath, openIssueFlowDatabase } from '../storage/db/index.js';
import { exportStoredState } from '../storage/db/repository.js';
import { verifyProjectProjections } from '../storage/db/verify.js';
import { resolveProjectPaths } from '../storage/resolve.js';
import { printError, printInfo } from '../ui/logger.js';
import { getProjectRoot, getRemoteUrl } from '../utils/git.js';

function failure(action: string, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  printError(`Database ${action} failed: ${message}`);
  return 1;
}

export async function runDbCheck(): Promise<number> {
  try {
    const project = await resolveProjectPaths();
    const database = await openIssueFlowDatabase(project.databaseOptions);
    try {
      const result = database.integrityCheck();
      if (result !== 'ok') {
        printError(
          `Database integrity check failed: ${result}. Restore a backup or re-import the preserved JSON state.`,
        );
        return 1;
      }
      printInfo(`Database is healthy: ${getDatabasePath(project.databaseOptions)}`);
      return 0;
    } finally {
      database.close();
    }
  } catch (error) {
    return failure('check', error);
  }
}

export async function runDbBackup(destination?: string): Promise<number> {
  try {
    const project = await resolveProjectPaths();
    const target =
      destination ?? join(project.projectDir, 'backups', `issue-flow-${Date.now()}.db`);
    const database = await openIssueFlowDatabase(project.databaseOptions);
    try {
      database.backup(target);
      printInfo(`Database backup created: ${target}`);
      return 0;
    } finally {
      database.close();
    }
  } catch (error) {
    return failure('backup', error);
  }
}

export async function runDbVacuum(): Promise<number> {
  try {
    const project = await resolveProjectPaths();
    const database = await openIssueFlowDatabase(project.databaseOptions);
    try {
      database.vacuum();
      printInfo(`Database vacuum completed: ${getDatabasePath(project.databaseOptions)}`);
      return 0;
    } finally {
      database.close();
    }
  } catch (error) {
    return failure('vacuum', error);
  }
}

/** Export the relational state as portable, readable JSON for diagnostics. */
export async function runDbExport(destination?: string): Promise<number> {
  try {
    const project = await resolveProjectPaths();
    const payload = JSON.stringify(
      {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        database: getDatabasePath(project.databaseOptions),
        tables: await exportStoredState(project.databaseOptions),
      },
      null,
      2,
    );
    if (destination === undefined) {
      printInfo(payload);
    } else {
      await writeFile(destination, `${payload}\n`, 'utf-8');
      printInfo(`Database export written: ${destination}`);
    }
    return 0;
  } catch (error) {
    return failure('export', error);
  }
}

export async function runDbVerify(): Promise<number> {
  try {
    const project = await resolveProjectPaths();
    if (project.storageDriver !== 'sqlite') {
      printError('Database verification requires storage.driver=sqlite.');
      return 1;
    }
    const projectRoot = await getProjectRoot();
    const result = await verifyProjectProjections({
      projectId: project.projectId,
      projectDir: project.projectDir,
      projectRoot,
      databaseOptions: project.databaseOptions,
    });
    if (result.divergences.length > 0) {
      printError(`Database verification found ${result.divergences.length} divergence(s):`);
      for (const divergence of result.divergences) printError(`  ${divergence}`);
      return 1;
    }
    printInfo(`Database verification passed: ${result.checked} projection(s) match SQLite.`);
    return 0;
  } catch (error) {
    return failure('verification', error);
  }
}

export async function runDbImport(options: { withEvents?: boolean } = {}): Promise<number> {
  try {
    const project = await resolveProjectPaths();
    const projectRoot = await getProjectRoot();
    const result = await importProjectArtifacts({
      projectId: project.projectId,
      projectDir: project.projectDir,
      projectRoot,
      remoteUrl: await getRemoteUrl(projectRoot),
      ...project.databaseOptions,
      withEvents: options.withEvents === true,
      onWarning: printInfo,
    });
    if (result.failed) return 1;
    printInfo(
      `Database import completed: ${result.imported} artifact(s) imported, ${result.skipped} unchanged.`,
    );
    return 0;
  } catch (error) {
    return failure('import', error);
  }
}

export function databaseExists(options: Parameters<typeof getDatabasePath>[0] = {}): boolean {
  return existsSync(getDatabasePath(options));
}
