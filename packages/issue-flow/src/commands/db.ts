import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabasePath, openIssueFlowDatabase } from '../storage/db/index.js';
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
      database.exec('VACUUM');
      printInfo(`Database vacuum completed: ${getDatabasePath()}`);
      return 0;
    } finally {
      database.close();
    }
  } catch (error) {
    return failure('vacuum', error);
  }
}

export function databaseExists(): boolean {
  return existsSync(getDatabasePath());
}
