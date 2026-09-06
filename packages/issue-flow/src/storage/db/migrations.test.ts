import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';
import { CURRENT_SCHEMA_VERSION, migrateDatabase, migrations } from './migrations.js';

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
      ).toEqual(migrations.map((migration) => ({ version: migration.version })));
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

  // Every migration added by the WebMux absorption has to reach a database that
  // already exists, without disturbing what is in it, and the result has to
  // survive a close and reopen. Anchored on version 8 — the last release before
  // the absorption — rather than on `CURRENT_SCHEMA_VERSION - 1`, so adding a
  // migration does not silently narrow what this covers.
  const LAST_PRE_ABSORPTION_VERSION = 8;

  it('brings a pre-absorption database forward without disturbing its rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'issue-flow-db-'));
    directories.push(directory);
    const path = join(directory, 'issue-flow.db');

    const first = await openDatabase(path);
    try {
      for (const migration of migrations.filter(
        (entry) => entry.version <= LAST_PRE_ABSORPTION_VERSION,
      )) {
        migration.up(first);
      }
      first.exec(`PRAGMA user_version = ${LAST_PRE_ABSORPTION_VERSION}`);
      first
        .prepare('INSERT INTO projects (id, root, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('project', '/repo', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      for (const table of ['agent_events', 'worktrees']) {
        expect(
          first
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table),
        ).toBeUndefined();
      }
    } finally {
      first.close();
    }

    const upgraded = await openDatabase(path);
    try {
      expect(migrateDatabase(upgraded)).toBe(CURRENT_SCHEMA_VERSION);
      // The pre-existing row survived the upgrade.
      expect(upgraded.prepare('SELECT id FROM projects').all<{ id: string }>()).toEqual([
        { id: 'project' },
      ]);

      upgraded
        .prepare(
          `INSERT INTO agent_events
             (id, project_id, run_id, phase, type, lifecycle, payload_json, occurred_at, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'event-1',
          'project',
          'run-1',
          'execute',
          'agent_status_changed',
          'idle',
          '{}',
          '2026-01-01T00:00:01.000Z',
          '2026-01-01T00:00:01.000Z',
        );
      // A lifecycle outside the four the contract knows is rejected by the schema.
      expect(() =>
        upgraded
          .prepare(
            `INSERT INTO agent_events
               (id, project_id, run_id, phase, type, lifecycle, payload_json, occurred_at, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'event-2',
            'project',
            'run-1',
            'execute',
            'agent_status_changed',
            'closed',
            '{}',
            '2026-01-01T00:00:02.000Z',
            '2026-01-01T00:00:02.000Z',
          ),
      ).toThrow();

      const insertWorktree = upgraded.prepare(
        `INSERT INTO worktrees
           (id, project_id, branch, path, profile, agent, runtime,
            startup_env_json, allocated_ports_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertWorktree.run(
        'wt-1',
        'project',
        'feature',
        '/wt/feature',
        'default',
        'claude',
        'host',
        '{}',
        '{}',
        '2026-01-01T00:00:03.000Z',
        '2026-01-01T00:00:03.000Z',
      );
      // One binding per branch: a second row for the same branch would let two
      // worktrees claim it.
      expect(() =>
        insertWorktree.run(
          'wt-2',
          'project',
          'feature',
          '/wt/other',
          'default',
          'claude',
          'host',
          '{}',
          '{}',
          '2026-01-01T00:00:04.000Z',
          '2026-01-01T00:00:04.000Z',
        ),
      ).toThrow();
      // And a runtime the three modes do not include is refused.
      expect(() =>
        insertWorktree.run(
          'wt-3',
          'project',
          'other',
          '/wt/other',
          'default',
          'claude',
          'kubernetes',
          '{}',
          '{}',
          '2026-01-01T00:00:05.000Z',
          '2026-01-01T00:00:05.000Z',
        ),
      ).toThrow();
    } finally {
      upgraded.close();
    }

    // Reopening applies no further migration and still reads both rows.
    const reopened = await openDatabase(path);
    try {
      expect(migrateDatabase(reopened)).toBe(CURRENT_SCHEMA_VERSION);
      expect(reopened.prepare('SELECT run_id FROM agent_events').all<{ run_id: string }>()).toEqual(
        [{ run_id: 'run-1' }],
      );
      expect(reopened.prepare('SELECT branch FROM worktrees').all<{ branch: string }>()).toEqual([
        { branch: 'feature' },
      ]);
    } finally {
      reopened.close();
    }
  });

  it('creates the execution-history indexes required by query readers', async () => {
    const db = await database();
    try {
      migrateDatabase(db);
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'executions'")
        .all<{ name: string }>()
        .map((row) => row.name);

      expect(indexes).toEqual(
        expect.arrayContaining(['executions_harness_started_idx', 'executions_run_id_idx']),
      );
      const harnessPlan = db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT id FROM executions WHERE harness = ? ORDER BY started_at',
        )
        .all<{ detail: string }>('claude-code')
        .map((row) => row.detail)
        .join('\n');
      const runPlan = db
        .prepare('EXPLAIN QUERY PLAN SELECT id FROM executions WHERE run_id = ?')
        .all<{ detail: string }>('run-1')
        .map((row) => row.detail)
        .join('\n');

      expect(harnessPlan).toContain('executions_harness_started_idx');
      expect(runPlan).toContain('executions_run_id_idx');
    } finally {
      db.close();
    }
  });
});
