import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './driver.js';
import {
  getStoredProject,
  listStoredProjects,
  setStoredProjectSource,
  touchStoredProject,
  upsertStoredProject,
} from './projects.js';
import { ensureDatabaseSchema } from './schema.js';

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

describe('project registry schema', () => {
  it('creates them on a new database', async () => {
    const home = await tempHome();
    const db = await openDatabase(join(home, 'issue-flow.db'));
    try {
      ensureDatabaseSchema(db);
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
