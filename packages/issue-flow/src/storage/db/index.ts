import { join } from 'node:path';
import { type GetGlobalRootOptions, getGlobalRoot } from '../paths.js';
import { type DatabaseDriver, type OpenDatabaseOptions, openDatabase } from './driver.js';
import { migrateDatabase } from './migrations.js';

export const DATABASE_FILENAME = 'issue-flow.db';

export function getDatabasePath(options: GetGlobalRootOptions = {}): string {
  return join(getGlobalRoot(options), DATABASE_FILENAME);
}

export interface OpenIssueFlowDatabaseOptions extends OpenDatabaseOptions, GetGlobalRootOptions {}

export async function openIssueFlowDatabase(
  options: OpenIssueFlowDatabaseOptions = {},
): Promise<DatabaseDriver> {
  const database = await openDatabase(getDatabasePath(options), options);
  try {
    migrateDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
