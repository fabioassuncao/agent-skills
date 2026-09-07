import { join } from 'node:path';
import { type GetGlobalRootOptions, getGlobalRoot } from '../paths.js';
import { type DatabaseDriver, type OpenDatabaseOptions, openDatabase } from './driver.js';
import { ensureDatabaseSchema } from './schema.js';

export const DATABASE_FILENAME = 'issue-flow.db';

export function getDatabasePath(options: GetGlobalRootOptions = {}): string {
  return join(getGlobalRoot(options), DATABASE_FILENAME);
}

export interface OpenIssueFlowDatabaseOptions extends OpenDatabaseOptions, GetGlobalRootOptions {}

const projectDatabaseOptions = new Map<string, OpenIssueFlowDatabaseOptions>();

export function registerProjectDatabaseOptions(
  projectId: string,
  options: OpenIssueFlowDatabaseOptions,
): void {
  projectDatabaseOptions.set(projectId, options);
}

export function databaseOptionsForProject(projectId: string): OpenIssueFlowDatabaseOptions {
  return projectDatabaseOptions.get(projectId) ?? {};
}

export function resetProjectDatabaseOptions(): void {
  projectDatabaseOptions.clear();
}

export async function openIssueFlowDatabase(
  options: OpenIssueFlowDatabaseOptions = {},
): Promise<DatabaseDriver> {
  const database = await openDatabase(getDatabasePath(options), options);
  try {
    ensureDatabaseSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
