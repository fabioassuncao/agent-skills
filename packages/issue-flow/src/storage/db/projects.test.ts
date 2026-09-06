import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';
import { CURRENT_SCHEMA_VERSION, migrateDatabase, migrations } from './migrations.js';
import {
  getStoredProject,
  listStoredProjects,
  setStoredProjectSource,
  touchStoredProject,
  upsertStoredProject,
} from './projects.js';

/**
 * Migration 10 — the registry columns on `projects` — plus the reads and
 * writes built on them. Four situations, because a migration that only ever
 * runs against a fresh database is untested where it matters: a new database,
 * one that stopped at version 9, a reopen of the upgraded file, and rows
 * written before the columns existed still reading correctly.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'issue-flow-projects-'));
  directories.push(home);
  return home;
}

describe('migration 10: project registry columns', () => {
  it('creates them on a new database', async () => {
    const home = await tempHome();
    const db = await openDatabase(join(home, 'issue-flow.db'));
    try {
      migrateDatabase(db);
      const columns = db
        .prepare("SELECT name FROM pragma_table_info('projects')")
        .all<{ name: string }>()
        .map((row) => row.name);
      expect(columns).toEqual(
        expect.arrayContaining(['name', 'added_at', 'last_seen_at', 'source']),
      );
    } finally {
      db.close();
    }
  });

  it('upgrades a database that stopped at version 9, then reopens clean', async () => {
    const home = await tempHome();
    const path = join(home, 'issue-flow.db');
    const previous = 9;

    const first = await openDatabase(path);
    try {
      for (const migration of migrations.filter((entry) => entry.version <= previous)) {
        migration.up(first);
      }
      first.exec(`PRAGMA user_version = ${previous}`);
      first
        .prepare('INSERT INTO projects (id, root, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('legacy', '/repo/legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      expect(
        first
          .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('projects') WHERE name = 'source'")
          .get<{ n: number }>()?.n,
      ).toBe(0);
    } finally {
      first.close();
    }

    const upgraded = await openDatabase(path);
    try {
      expect(migrateDatabase(upgraded)).toBe(CURRENT_SCHEMA_VERSION);
      // The row a plain `run` left behind classifies as `discovered` without
      // being touched — that is what keeps direct mode unchanged.
      expect(
        upgraded
          .prepare('SELECT id, name, added_at, last_seen_at, source FROM projects')
          .all<Record<string, unknown>>(),
      ).toEqual([
        { id: 'legacy', name: null, added_at: null, last_seen_at: null, source: 'discovered' },
      ]);
      // A value outside the three the domain knows is rejected by the schema.
      expect(() =>
        upgraded
          .prepare(
            'INSERT INTO projects (id, root, created_at, updated_at, source) VALUES (?, ?, ?, ?, ?)',
          )
          .run('bogus', '/repo/bogus', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'x'),
      ).toThrow();
    } finally {
      upgraded.close();
    }

    const reopened = await openDatabase(path);
    try {
      expect(migrateDatabase(reopened)).toBe(CURRENT_SCHEMA_VERSION);
      expect(reopened.prepare('SELECT source FROM projects').all<{ source: string }>()).toEqual([
        { source: 'discovered' },
      ]);
    } finally {
      reopened.close();
    }
  });
});

describe('project registry rows', () => {
  it('upserts, reclassifies and stamps recency', async () => {
    const home = await tempHome();
    const databaseOptions = { env: { ISSUE_FLOW_HOME: home } };

    await upsertStoredProject({
      id: 'a',
      root: '/repo/a',
      name: 'A',
      source: 'registered',
      now: '2026-01-01T00:00:00.000Z',
      databaseOptions,
    });
    expect(await getStoredProject('a', databaseOptions)).toMatchObject({
      root: '/repo/a',
      name: 'A',
      source: 'registered',
      addedAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: null,
    });

    expect(
      await setStoredProjectSource({
        id: 'a',
        source: 'discovered',
        now: '2026-01-02T00:00:00.000Z',
        databaseOptions,
      }),
    ).toBe(true);
    expect(await getStoredProject('a', databaseOptions)).toMatchObject({ source: 'discovered' });

    expect(
      await touchStoredProject({ id: 'a', at: '2026-01-03T00:00:00.000Z', databaseOptions }),
    ).toBe(true);
    expect(await getStoredProject('a', databaseOptions)).toMatchObject({
      lastSeenAt: '2026-01-03T00:00:00.000Z',
      // Demotion never rewrites when the project first appeared.
      addedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('filters by source and orders recent projects first', async () => {
    const home = await tempHome();
    const databaseOptions = { env: { ISSUE_FLOW_HOME: home } };

    for (const [id, source] of [
      ['a', 'registered'],
      ['b', 'registered'],
      ['c', 'discovered'],
    ] as const) {
      await upsertStoredProject({
        id,
        root: `/repo/${id}`,
        name: id.toUpperCase(),
        source,
        now: '2026-01-01T00:00:00.000Z',
        databaseOptions,
      });
    }
    await touchStoredProject({ id: 'b', at: '2026-01-05T00:00:00.000Z', databaseOptions });

    expect((await listStoredProjects({ databaseOptions })).map((project) => project.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(
      (await listStoredProjects({ sources: ['registered'], databaseOptions })).map(
        (project) => project.id,
      ),
    ).toEqual(['b', 'a']);
    expect(await listStoredProjects({ sources: [], databaseOptions })).toEqual([]);
  });
});
