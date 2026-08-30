import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations.js';

const directories: string[] = [];

async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'issue-flow-db-'));
  directories.push(directory);
  return openDatabase(join(directory, 'issue-flow.db'));
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('SQLite migrations', () => {
  it('migrates an empty database forward and records every version', async () => {
    const db = await database();
    try {
      expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(db.prepare('PRAGMA user_version').get<{ user_version: number }>()?.user_version).toBe(
        CURRENT_SCHEMA_VERSION,
      );
      expect(
        db.prepare('SELECT version FROM schema_migrations').all<{ version: number }>(),
      ).toEqual([{ version: 1 }, { version: CURRENT_SCHEMA_VERSION }]);
    } finally {
      db.close();
    }
  });

  it('rejects a database from a future release before writing migration metadata', async () => {
    const db = await database();
    try {
      db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
      expect(() => migrateDatabase(db)).toThrow('newer than this Issue Flow supports');
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('enforces story relationships and distinguishes unknown cost from reported zero', async () => {
    const db = await database();
    try {
      migrateDatabase(db);
      db.prepare('INSERT INTO projects (id, root, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
        'project',
        '/repo',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
      db.prepare(
        'INSERT INTO issues (project_id, id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('project', '91', 'in_progress', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      db.prepare(
        'INSERT INTO stories (project_id, issue_id, id, title, priority, passes) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('project', '91', 'US-001', 'Foundation', 1, 0);
      expect(() =>
        db
          .prepare(
            'INSERT INTO story_dependencies (project_id, issue_id, story_id, depends_on_story_id) VALUES (?, ?, ?, ?)',
          )
          .run('project', '91', 'US-001', 'US-002'),
      ).toThrow();

      const insert = db.prepare(
        'INSERT INTO executions (id, project_id, issue_id, status, started_at, cost_status, cost_amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      insert.run(
        'unknown',
        'project',
        '91',
        'finished',
        '2026-01-01T00:00:00.000Z',
        'unknown',
        null,
      );
      insert.run('zero', 'project', '91', 'finished', '2026-01-01T00:00:00.000Z', 'reported', 0);
      expect(() =>
        insert.run(
          'invalid',
          'project',
          '91',
          'finished',
          '2026-01-01T00:00:00.000Z',
          'unknown',
          0,
        ),
      ).toThrow();
      expect(
        db.prepare('SELECT id, cost_status, cost_amount FROM executions ORDER BY id').all<{
          id: string;
          cost_status: string;
          cost_amount: number | null;
        }>(),
      ).toEqual([
        { id: 'unknown', cost_status: 'unknown', cost_amount: null },
        { id: 'zero', cost_status: 'reported', cost_amount: 0 },
      ]);
    } finally {
      db.close();
    }
  });
});
