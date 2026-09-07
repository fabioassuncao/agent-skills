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
      for (const table of ['agent_events', 'worktrees', 'agent_sessions']) {
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
      expect(
        upgraded
          .prepare('SELECT archived FROM worktrees WHERE id = ?')
          .get<{ archived: number }>('wt-1'),
      ).toEqual({ archived: 0 });
      upgraded.prepare('UPDATE worktrees SET archived = 1 WHERE id = ?').run('wt-1');
      expect(() =>
        upgraded.prepare('UPDATE worktrees SET archived = 2 WHERE id = ?').run('wt-1'),
      ).toThrow();
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

      const insertSession = upgraded.prepare(
        `INSERT INTO agent_sessions
           (id, project_id, run_id, phase, story_id, branch, worktree_id, provider,
            conversation_id, status, pane_target, created_at, updated_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // A free session: run, phase and story all null (ADR-16). The schema has
      // to accept it, because that is what makes one model serve both modes.
      insertSession.run(
        'sess-free',
        'project',
        null,
        null,
        null,
        'feature',
        null,
        'claude',
        'conv-1',
        'idle',
        null,
        '2026-01-01T00:00:06.000Z',
        '2026-01-01T00:00:06.000Z',
        null,
      );
      expect(() =>
        insertSession.run(
          'sess-bad',
          'project',
          null,
          null,
          null,
          'feature',
          null,
          'claude',
          null,
          'exploded',
          null,
          '2026-01-01T00:00:07.000Z',
          '2026-01-01T00:00:07.000Z',
          null,
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
      expect(
        reopened.prepare('SELECT id, run_id FROM agent_sessions').all<{
          id: string;
          run_id: string | null;
        }>(),
      ).toEqual([{ id: 'sess-free', run_id: null }]);
    } finally {
      reopened.close();
    }
  });

  it('gives a session a name when no issue is there to name it (migration 17)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'issue-flow-db-'));
    directories.push(directory);
    const path = join(directory, 'issue-flow.db');

    // A database that stops just before 17: the table exists, the column does not.
    const before = await openDatabase(path);
    try {
      for (const migration of migrations.filter((entry) => entry.version < 17)) {
        migration.up(before);
      }
      before.exec('PRAGMA user_version = 16');
      before
        .prepare('INSERT INTO projects (id, root, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('project', '/repo', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      before
        .prepare(
          `INSERT INTO agent_sessions
             (id, project_id, run_id, phase, story_id, branch, worktree_id, provider,
              conversation_id, status, pane_target, created_at, updated_at, ended_at)
           VALUES (?, ?, NULL, NULL, NULL, ?, NULL, ?, NULL, ?, NULL, ?, ?, NULL)`,
        )
        .run(
          'sess-old',
          'project',
          'session/legacy',
          'claude',
          'idle',
          '2026-01-01T00:00:01.000Z',
          '2026-01-01T00:00:01.000Z',
        );
      expect(
        before
          .prepare('PRAGMA table_info(agent_sessions)')
          .all<{ name: string }>()
          .map((column) => column.name),
      ).not.toContain('label');
    } finally {
      before.close();
    }

    const upgraded = await openDatabase(path);
    try {
      expect(migrateDatabase(upgraded)).toBe(CURRENT_SCHEMA_VERSION);
      // The row that predates the column keeps its identity and gets a null
      // label — a caption is optional, and an old session is not broken.
      expect(
        upgraded
          .prepare('SELECT id, label FROM agent_sessions')
          .all<{ id: string; label: string | null }>(),
      ).toEqual([{ id: 'sess-old', label: null }]);

      upgraded
        .prepare('UPDATE agent_sessions SET label = ? WHERE id = ?')
        .run('poking at the parser', 'sess-old');
    } finally {
      upgraded.close();
    }

    const reopened = await openDatabase(path);
    try {
      expect(migrateDatabase(reopened)).toBe(CURRENT_SCHEMA_VERSION);
      expect(
        reopened.prepare('SELECT label FROM agent_sessions').all<{ label: string | null }>(),
      ).toEqual([{ label: 'poking at the parser' }]);
    } finally {
      reopened.close();
    }
  });

  it('creates a brand-new database with the session label already there', async () => {
    const db = await database();
    try {
      migrateDatabase(db);
      expect(
        db
          .prepare('PRAGMA table_info(agent_sessions)')
          .all<{ name: string }>()
          .map((column) => column.name),
      ).toContain('label');
    } finally {
      db.close();
    }
  });

  it('upgrades legacy sessions to workspace permission and constrains new values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'issue-flow-db-'));
    directories.push(directory);
    const path = join(directory, 'issue-flow.db');
    const before = await openDatabase(path);
    try {
      for (const migration of migrations.filter((entry) => entry.version < 21)) {
        migration.up(before);
      }
      before.exec('PRAGMA user_version = 20');
      before
        .prepare('INSERT INTO projects (id, root, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('project', '/repo', '2026-01-01', '2026-01-01');
      before
        .prepare(
          `INSERT INTO agent_sessions
             (id, project_id, branch, provider, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('legacy', 'project', 'feature', 'claude', 'idle', '2026-01-01', '2026-01-01');
    } finally {
      before.close();
    }

    const upgraded = await openDatabase(path);
    try {
      expect(migrateDatabase(upgraded)).toBe(CURRENT_SCHEMA_VERSION);
      expect(
        upgraded
          .prepare('SELECT permission FROM agent_sessions WHERE id = ?')
          .get<{ permission: string }>('legacy'),
      ).toEqual({ permission: 'workspace' });
      expect(() =>
        upgraded.prepare('UPDATE agent_sessions SET permission = ?').run('yolo'),
      ).toThrow();
    } finally {
      upgraded.close();
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

  /**
   * Migration 18 — the `inline` origin of §17: a demand typed straight into
   * `issue-flow run --prompt` needs somewhere to live, because every phase
   * after the first re-resolves its Issue by id, and so does `resume`.
   */
  it('stores an inline demand per project, on a new database and on an upgraded one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'issue-flow-db-'));
    directories.push(directory);
    const path = join(directory, 'issue-flow.db');

    // An existing database, stopped one version before the table existed.
    const before = await openDatabase(path);
    try {
      for (const migration of migrations.filter((entry) => entry.version < 18)) {
        migration.up(before);
      }
      before.exec('PRAGMA user_version = 17');
      before
        .prepare('INSERT INTO projects (id, root, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('project', '/repo', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      expect(
        before
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get('inline_issues'),
      ).toBeUndefined();
    } finally {
      before.close();
    }

    const upgraded = await openDatabase(path);
    try {
      expect(migrateDatabase(upgraded)).toBe(CURRENT_SCHEMA_VERSION);
      expect(upgraded.prepare('SELECT id FROM projects').all<{ id: string }>()).toEqual([
        { id: 'project' },
      ]);

      const insert = upgraded.prepare(
        `INSERT INTO inline_issues
           (project_id, id, title, body, state, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        'project',
        'inline-abcdef012345',
        'Fix the flaky cache test',
        'Fix the flaky cache test',
        'open',
        'sha256:deadbeef',
        '2026-01-01T00:00:01.000Z',
        '2026-01-01T00:00:01.000Z',
      );
      // Two demands cannot share an identifier inside one project...
      expect(() =>
        insert.run(
          'project',
          'inline-abcdef012345',
          'Something else',
          'Something else',
          'open',
          'sha256:cafe',
          '2026-01-01T00:00:02.000Z',
          '2026-01-01T00:00:02.000Z',
        ),
      ).toThrow();
      // ...and a state outside the two an Issue has is refused.
      expect(() =>
        insert.run(
          'project',
          'inline-000000000000',
          'Bad state',
          'Bad state',
          'archived',
          'sha256:cafe',
          '2026-01-01T00:00:03.000Z',
          '2026-01-01T00:00:03.000Z',
        ),
      ).toThrow();
    } finally {
      upgraded.close();
    }

    // Reopening applies nothing further and still reads the row back.
    const reopened = await openDatabase(path);
    try {
      expect(migrateDatabase(reopened)).toBe(CURRENT_SCHEMA_VERSION);
      expect(
        reopened
          .prepare('SELECT id, state FROM inline_issues')
          .all<{ id: string; state: string }>(),
      ).toEqual([{ id: 'inline-abcdef012345', state: 'open' }]);
    } finally {
      reopened.close();
    }
  });

  it('migrates tabs without adopting ambiguous sessions from an older branch incarnation', async () => {
    const db = await database();
    try {
      for (const migration of migrations.filter((entry) => entry.version <= 21)) {
        migration.up(db);
      }
      db.exec('PRAGMA user_version = 21');
      const at = '2026-09-06T12:00:00.000Z';
      db.prepare('INSERT INTO projects (id, root, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
        'project-tabs',
        '/repo',
        at,
        at,
      );
      const insertWorktree = db.prepare(
        `INSERT INTO worktrees
           (id, project_id, branch, path, profile, agent, runtime,
            startup_env_json, allocated_ports_json, created_at, updated_at)
         VALUES (?, 'project-tabs', ?, ?, 'default', 'claude', 'host', '{}', '{}', ?, ?)`,
      );
      insertWorktree.run('wt-solo', 'solo', '/repo/solo', at, at);
      insertWorktree.run('wt-reused', 'reused', '/repo/reused', at, at);
      insertWorktree.run('wt-exact', 'exact', '/repo/exact', at, at);

      const insertSession = db.prepare(
        `INSERT INTO agent_sessions
           (id, project_id, branch, worktree_id, provider, conversation_id, status,
            pane_target, created_at, updated_at, permission)
         VALUES (?, 'project-tabs', ?, ?, 'claude', ?, ?, ?, ?, ?, 'workspace')`,
      );
      insertSession.run('solo-root', 'solo', null, 'conv-solo', 'running', '%1', at, at);
      insertSession.run('reused-old', 'reused', null, 'conv-old', 'stopped', null, at, at);
      insertSession.run(
        'reused-newer',
        'reused',
        null,
        'conv-newer',
        'running',
        '%2',
        at,
        '2026-09-06T12:01:00.000Z',
      );
      insertSession.run('exact-older', 'exact', 'wt-exact', 'conv-a', 'idle', '%3', at, at);
      insertSession.run(
        'exact-live',
        'exact',
        'wt-exact',
        'conv-b',
        'running',
        '%4',
        at,
        '2026-09-06T12:02:00.000Z',
      );

      expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(
        db
          .prepare(
            `SELECT id, worktree_id, parent_session_id, tab_sequence, pane_token
               FROM agent_sessions
              ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: 'exact-live',
          worktree_id: 'wt-exact',
          parent_session_id: null,
          tab_sequence: 0,
          pane_token: null,
        },
        {
          id: 'exact-older',
          worktree_id: 'wt-exact',
          parent_session_id: null,
          tab_sequence: null,
          pane_token: null,
        },
        {
          id: 'reused-newer',
          worktree_id: null,
          parent_session_id: null,
          tab_sequence: null,
          pane_token: null,
        },
        {
          id: 'reused-old',
          worktree_id: null,
          parent_session_id: null,
          tab_sequence: null,
          pane_token: null,
        },
        {
          id: 'solo-root',
          worktree_id: 'wt-solo',
          parent_session_id: null,
          tab_sequence: 0,
          pane_token: null,
        },
      ]);
      expect(
        db.prepare('SELECT id, active_agent_session_id FROM worktrees ORDER BY id').all(),
      ).toEqual([
        { id: 'wt-exact', active_agent_session_id: 'exact-live' },
        { id: 'wt-reused', active_agent_session_id: null },
        { id: 'wt-solo', active_agent_session_id: 'solo-root' },
      ]);
    } finally {
      db.close();
    }
  });
});
