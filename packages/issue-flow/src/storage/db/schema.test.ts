import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';
import { CURRENT_SCHEMA_VERSION, ensureDatabaseSchema } from './schema.js';

const databases: Array<Awaited<ReturnType<typeof openDatabase>>> = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

async function database() {
  const value = await openDatabase(':memory:');
  databases.push(value);
  return value;
}

describe('current SQLite schema', () => {
  it('creates the complete schema at the current version', async () => {
    const db = await database();
    expect(ensureDatabaseSchema(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({
      user_version: CURRENT_SCHEMA_VERSION,
    });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>()
      .map(({ name }) => name);
    expect(tables).toContain('pipelines');
    expect(tables).toContain('agent_sessions');
    expect(tables).toContain('handoffs');
  });

  it('is idempotent for a current database', async () => {
    const db = await database();
    ensureDatabaseSchema(db);
    expect(ensureDatabaseSchema(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('rejects every non-current populated schema', async () => {
    const db = await database();
    db.exec('PRAGMA user_version = 22');
    expect(() => ensureDatabaseSchema(db)).toThrow('Unsupported database schema version');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  });
});
