import { join } from 'node:path';
import { getGlobalRoot } from '../paths.js';
import { type DatabaseDriver, type OpenDatabaseOptions, openDatabase } from './driver.js';
import { migrateDatabase } from './migrations.js';

export const DATABASE_FILENAME = 'issue-flow.db';

export function getDatabasePath(): string {
  return join(getGlobalRoot(), DATABASE_FILENAME);
}

export async function openIssueFlowDatabase(
  options: OpenDatabaseOptions = {},
): Promise<DatabaseDriver> {
  const database = await openDatabase(getDatabasePath(), options);
  try {
    migrateDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
