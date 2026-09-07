import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDatabasePath } from '../db/index.js';
import { createProjectRegistry, type ProjectRegistry } from './registry.js';

/**
 * Ported from `backend/src/__tests__/projects-registry.test.ts` @ d8c9d5f
 * (7 cases). Adapted where the store changed: an upsert keyed by `projectId`
 * instead of by path, `unregister` demoting instead of deleting, and a
 * malformed *file* becoming an unreadable *database* — the tolerant-read
 * behaviour the original protects is the part that had to survive.
 */

const directories: string[] = [];

async function freshRegistry(): Promise<{ home: string; registry: ProjectRegistry }> {
  const home = await mkdtemp(join(tmpdir(), 'issue-flow-registry-'));
  directories.push(home);
  return {
    home,
    registry: createProjectRegistry({ databaseOptions: { env: { ISSUE_FLOW_HOME: home } } }),
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ProjectRegistry', () => {
  it('registers, lists and demotes an entry', async () => {
    const { registry } = await freshRegistry();

    const registered = await registry.register({ id: 'demo-1', root: '/repo/demo', name: 'Demo' });
    expect(registered).toMatchObject({
      id: 'demo-1',
      root: '/repo/demo',
      name: 'Demo',
      source: 'registered',
    });
    expect((await registry.listRegistered()).map((entry) => entry.id)).toEqual(['demo-1']);

    expect(await registry.unregister('demo-1')).toBe(true);
    expect(await registry.listRegistered()).toEqual([]);
    // P9 — demotion keeps the project known, it does not delete it.
    expect((await registry.list()).map((entry) => entry.source)).toEqual(['discovered']);
  });

  it('returns an empty list when the database does not exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'issue-flow-registry-'));
    directories.push(home);
    const registry = createProjectRegistry({
      databaseOptions: { env: { ISSUE_FLOW_HOME: join(home, 'never-created') } },
    });
    expect(await registry.list()).toEqual([]);
  });

  it('never throws on an unreadable database', async () => {
    const { home, registry } = await freshRegistry();
    // Force the file into existence as something SQLite cannot open.
    await writeFile(getDatabasePath({ env: { ISSUE_FLOW_HOME: home } }), 'not a database');

    expect(await registry.list()).toEqual([]);
    expect(await registry.listRegistered()).toEqual([]);
    expect(await registry.get('demo-1')).toBeNull();
    expect(await registry.getByRoot('/repo/demo')).toBeNull();
  });

  it('orders by recency, keeping never-seen projects visible at the end', async () => {
    const home = await mkdtemp(join(tmpdir(), 'issue-flow-registry-'));
    directories.push(home);
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const registry = createProjectRegistry({
      databaseOptions: { env: { ISSUE_FLOW_HOME: home } },
      now: () => new Date(clock++).toISOString(),
    });
    await registry.register({ id: 'a', root: '/a', name: 'A' });
    await registry.register({ id: 'b', root: '/b', name: 'B' });
    await registry.register({ id: 'c', root: '/c', name: 'C' });

    await registry.touch('b');
    await registry.touch('a');

    expect((await registry.list()).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  // P2 — adding the same project twice is idempotent.
  it('P2: upserts by project id, replacing the locator in place', async () => {
    const { registry } = await freshRegistry();
    await registry.register({ id: 'a', root: '/old/a', name: 'Old' });
    await registry.register({ id: 'a', root: '/new/a', name: 'New' });

    const entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'a', root: '/new/a', name: 'New' });
  });

  // P8 — promoting a project discovered by a plain `run`.
  it('P8: promotes a discovered project without resetting when it first appeared', async () => {
    const { registry } = await freshRegistry();
    await registry.register({ id: 'a', root: '/repo/a', source: 'discovered' });
    const discovered = await registry.get('a');

    await registry.register({ id: 'a', root: '/repo/a', name: 'A' });
    const promoted = await registry.get('a');

    expect(promoted).toMatchObject({ source: 'registered', name: 'A' });
    expect(promoted?.addedAt).toBe(discovered?.addedAt);
    expect(promoted?.createdAt).toBe(discovered?.createdAt);
  });

  it('keeps the existing name when a later upsert supplies none', async () => {
    const { registry } = await freshRegistry();
    await registry.register({ id: 'a', root: '/repo/a', name: 'A' });
    await registry.register({ id: 'a', root: '/repo/a', source: 'discovered' });

    expect(await registry.get('a')).toMatchObject({ name: 'A', source: 'discovered' });
  });

  it('refuses to persist an ephemeral project', async () => {
    const { registry } = await freshRegistry();
    await expect(
      registry.register({ id: 'a', root: '/repo/a', source: 'ephemeral' }),
    ).rejects.toThrow(/ephemeral/i);
  });

  it('unregister and touch are no-ops for an unknown project', async () => {
    const { registry } = await freshRegistry();
    await registry.register({ id: 'a', root: '/repo/a' });

    expect(await registry.unregister('does-not-exist')).toBe(false);
    expect(await registry.touch('does-not-exist')).toBe(false);
    expect((await registry.listRegistered()).map((entry) => entry.id)).toEqual(['a']);
  });

  it('looks a project up by its current root', async () => {
    const { registry } = await freshRegistry();
    await registry.register({ id: 'a', root: '/repo/a', name: 'A' });

    expect(await registry.getByRoot('/repo/a')).toMatchObject({ id: 'a' });
    expect(await registry.getByRoot('/repo/none')).toBeNull();
  });
});
