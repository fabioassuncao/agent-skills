import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDatabasePath, openIssueFlowDatabase } from '../storage/db/index.js';
import { exportStoredState } from '../storage/db/repository.js';
import { getGlobalRoot } from '../storage/paths.js';
import { printError, printInfo } from '../ui/logger.js';

function failure(action: string, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  printError(`Database ${action} failed: ${message}`);
  return 1;
}

export async function runDbCheck(): Promise<number> {
  try {
    const database = await openIssueFlowDatabase();
    try {
      const result = database.integrityCheck();
      if (result !== 'ok') {
        printError(
          `Database integrity check failed: ${result}. Restore a backup or re-import the preserved JSON state.`,
        );
        return 1;
      }
      printInfo(`Database is healthy: ${getDatabasePath()}`);
      return 0;
    } finally {
      database.close();
    }
  } catch (error) {
    return failure('check', error);
  }
}

export async function runDbBackup(destination?: string): Promise<number> {
  const target = destination ?? join(getGlobalRoot(), 'backups', `issue-flow-${Date.now()}.db`);
  try {
    const database = await openIssueFlowDatabase();
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
    const database = await openIssueFlowDatabase();
    try {
      database.vacuum();
      printInfo(`Database vacuum completed: ${getDatabasePath()}`);
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
    const payload = JSON.stringify(
      {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        database: getDatabasePath(),
        tables: await exportStoredState(),
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

export function databaseExists(): boolean {
  return existsSync(getDatabasePath());
}
