import { mkdirSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';

/** Values accepted by the small SQLite abstraction. */
export type SqlValue = string | number | bigint | Uint8Array | null;

export interface SqlStatement {
  run(...values: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get<T>(): T | undefined;
  get<T>(...values: SqlValue[]): T | undefined;
  all<T>(): T[];
  all<T>(...values: SqlValue[]): T[];
}

/**
 * The only database interface consumers may depend on. Keeping it deliberately
 * small makes replacing node:sqlite possible without leaking its API.
 */
export interface DatabaseDriver {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  transaction<T>(work: () => T): T;
  integrityCheck(): string;
  backup(destination: string): void;
  vacuum(): void;
  close(): void;
}

export interface OpenDatabaseOptions {
  onWarning?: (message: string) => void;
  isNetworkFilesystem?: (path: string) => boolean;
}

const NETWORK_FILESYSTEM_TYPES = new Set([0x6969, 0x517b, 0xff534d42]);

/** Best-effort detection; a failed probe must never prevent local use. */
export function isNetworkFilesystem(path: string): boolean {
  try {
    return NETWORK_FILESYSTEM_TYPES.has(Number(statfsSync(dirname(path)).type));
  } catch {
    return false;
  }
}

function isSqliteExperimentalWarning(warning: unknown): boolean {
  if (!(warning instanceof Error) || warning.name !== 'ExperimentalWarning') return false;
  return warning.message.includes('SQLite is an experimental feature');
}

/**
 * node:sqlite emitted an ExperimentalWarning on Node 22. Filter only that
 * exact warning while loading the built-in; every other warning keeps Node's
 * normal behaviour. The import stays here so this is the sole node:sqlite seam.
 */
async function loadDatabaseSync(): Promise<new (path: string) => NodeDatabase> {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const normalized =
      typeof warning === 'string'
        ? Object.assign(new Error(warning), {
            name: typeof args[0] === 'string' ? args[0] : 'Warning',
          })
        : warning;
    if (isSqliteExperimentalWarning(normalized)) return;
    return (originalEmitWarning as (...input: unknown[]) => unknown)(warning, ...args);
  }) as typeof process.emitWarning;

  try {
    const sqlite = await import('node:sqlite');
    return sqlite.DatabaseSync as unknown as new (
      path: string,
    ) => NodeDatabase;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SQLite storage requires Node.js >= 22.13.0 with the built-in node:sqlite module. ${detail}`,
      { cause: error },
    );
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

interface NodeDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

class NodeSqliteDriver implements DatabaseDriver {
  constructor(private readonly database: NodeDatabase) {}

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    return this.database.prepare(sql);
  }

  transaction<T>(work: () => T): T {
    this.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.exec('ROLLBACK');
      } catch {
        // Preserve the original error, which explains why the transaction failed.
      }
      throw error;
    }
  }

  integrityCheck(): string {
    return (
      this.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check ??
      'unknown'
    );
  }

  backup(destination: string): void {
    mkdirSync(dirname(destination), { recursive: true });
    // VACUUM INTO creates a consistent SQLite snapshot without copying a live
    // WAL file by hand. Binding keeps a user supplied destination out of SQL.
    this.prepare('VACUUM INTO ?').run(destination);
  }

  vacuum(): void {
    this.exec('VACUUM');
  }

  close(): void {
    this.database.close();
  }
}

/** Open and configure the single Issue Flow SQLite database. */
export async function openDatabase(
  path: string,
  options: OpenDatabaseOptions = {},
): Promise<DatabaseDriver> {
  mkdirSync(dirname(path), { recursive: true });
  const DatabaseSync = await loadDatabaseSync();
  const driver = new NodeSqliteDriver(new DatabaseSync(path));

  try {
    driver.exec('PRAGMA foreign_keys = ON');
    driver.exec('PRAGMA busy_timeout = 5000');
    driver.exec('PRAGMA synchronous = NORMAL');
    const networkFilesystem = (options.isNetworkFilesystem ?? isNetworkFilesystem)(path);
    driver.exec(`PRAGMA journal_mode = ${networkFilesystem ? 'DELETE' : 'WAL'}`);
    if (networkFilesystem) {
      options.onWarning?.(
        `SQLite database is on a network filesystem; using journal_mode=DELETE instead of WAL: ${path}`,
      );
    }
    return driver;
  } catch (error) {
    driver.close();
    throw error;
  }
}
