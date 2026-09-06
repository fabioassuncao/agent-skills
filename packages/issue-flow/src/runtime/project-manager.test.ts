import { describe, expect, it } from 'vitest';
import type {
  ProjectRecord,
  ProjectRegistry,
  RegisterProjectInput,
} from '../storage/projects/registry.js';
import {
  type ManagedProject,
  type ProjectLoopController,
  ProjectManager,
} from './project-manager.js';

/**
 * Ported from `backend/src/__tests__/project-manager.test.ts` @ d8c9d5f
 * (11 cases). Adapted where the port had to adapt: the methods are async, the
 * registry is keyed by `projectId`, and `remove` demotes instead of deleting.
 */

interface FakeRuntime {
  projectId: string;
  config: { name: string };
}

function fakeRegistry(initial: ProjectRecord[] = []): ProjectRegistry & {
  entries: ProjectRecord[];
  touched: string[];
} {
  const entries = [...initial];
  const touched: string[] = [];
  const registry: ProjectRegistry & { entries: ProjectRecord[]; touched: string[] } = {
    entries,
    touched,
    list: async () => [...entries],
    listRegistered: async () => entries.filter((entry) => entry.source === 'registered'),
    get: async (id) => entries.find((entry) => entry.id === id) ?? null,
    getByRoot: async (root) => entries.find((entry) => entry.root === root) ?? null,
    register: async (input: RegisterProjectInput) => {
      const record: ProjectRecord = {
        id: input.id,
        root: input.root,
        remoteUrl: input.remoteUrl ?? null,
        name: input.name ?? null,
        addedAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: null,
        source: input.source ?? 'registered',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const index = entries.findIndex((entry) => entry.id === input.id);
      if (index >= 0) entries[index] = record;
      else entries.push(record);
      return record;
    },
    unregister: async (id) => {
      const entry = entries.find((candidate) => candidate.id === id);
      if (entry === undefined) return false;
      entry.source = 'discovered';
      return true;
    },
    touch: async (id) => {
      touched.push(id);
      return true;
    },
  };
  return registry;
}

function makeManager(initial: ProjectRecord[] = []) {
  const registry = fakeRegistry(initial);
  const loopCalls = new Map<string, string[]>();
  const createdWith: Array<{ projectDir: string; port: number; prefix: string }> = [];
  const manager = new ProjectManager<FakeRuntime>({
    registry,
    port: 3737,
    resolveRoot: (path) => path,
    createRuntime: ({ projectDir, port, prefix }) => {
      createdWith.push({ projectDir, port, prefix });
      return { projectId: `id:${projectDir}`, config: { name: `name:${projectDir}` } };
    },
    createLoops: (project: ManagedProject<FakeRuntime>): ProjectLoopController => {
      const calls: string[] = [];
      loopCalls.set(project.prefix, calls);
      return {
        startLight: (): number => calls.push('startLight'),
        stopLight: (): number => calls.push('stopLight'),
        startHeavy: (): number => calls.push('startHeavy'),
        stopHeavy: (): number => calls.push('stopHeavy'),
      };
    },
  });
  return { manager, registry, loopCalls, createdWith };
}

function registeredRecord(root: string, name: string): ProjectRecord {
  return {
    id: `id:${root}`,
    root,
    remoteUrl: null,
    name,
    addedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: null,
    source: 'registered',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('ProjectManager', () => {
  it('adds a project: derives the prefix, labels from config, starts light loops, curates it', async () => {
    const { manager, registry, loopCalls } = makeManager();

    const project = await manager.add('/repo/alpha');

    expect(project.prefix).toBe('alpha');
    expect(project.entry).toMatchObject({
      id: 'id:/repo/alpha',
      root: '/repo/alpha',
      name: 'name:/repo/alpha',
      source: 'registered',
    });
    expect(project.active).toBe(false);
    expect(manager.list()).toHaveLength(1);
    expect(registry.entries.map((entry) => entry.root)).toEqual(['/repo/alpha']);
    expect(loopCalls.get('alpha')).toEqual(['startLight']);
  });

  it('passes the derived prefix to createRuntime so the runtime can build a prefixed URL', async () => {
    const { manager, createdWith } = makeManager();

    await manager.add('/repo/alpha');
    await manager.add('/repo/alpha-clone/alpha');

    expect(createdWith).toEqual([
      { projectDir: '/repo/alpha', port: 3737, prefix: 'alpha' },
      { projectDir: '/repo/alpha-clone/alpha', port: 3737, prefix: 'alpha-2' },
    ]);
  });

  // P6 — `serve` inside a repository nobody registered.
  it('P6: addEphemeral serves the project in-memory but never writes it to the registry', async () => {
    const { manager, registry, loopCalls } = makeManager();

    const project = await manager.addEphemeral('/repo/alpha');

    expect(project.prefix).toBe('alpha');
    expect(project.entry.source).toBe('ephemeral');
    expect(manager.list()).toHaveLength(1);
    expect(manager.getByPrefix('alpha')).toBe(project);
    expect(loopCalls.get('alpha')).toEqual(['startLight']);
    // The whole point: nothing is written, so other servers on this machine
    // will not start serving this repository after their next restart.
    expect(registry.entries).toEqual([]);
    expect(registry.touched).toEqual([]);
  });

  it('addEphemeral returns an already-curated project without dropping its curation', async () => {
    const { manager, registry } = makeManager();

    const curated = await manager.add('/repo/alpha');
    const ephemeral = await manager.addEphemeral('/repo/alpha');

    expect(ephemeral).toBe(curated);
    expect(manager.list()).toHaveLength(1);
    expect(registry.entries.map((entry) => entry.source)).toEqual(['registered']);
  });

  it('promotes an ephemeral project when it is later added explicitly', async () => {
    const { manager, registry } = makeManager();

    const ephemeral = await manager.addEphemeral('/repo/alpha');
    const added = await manager.add('/repo/alpha');

    expect(added).toBe(ephemeral);
    expect(added.entry.source).toBe('registered');
    expect(registry.entries.map((entry) => entry.source)).toEqual(['registered']);
  });

  // P2 — adding the same path twice.
  it('P2: returns the existing project (no duplicate runtime or row) when adding the same path twice', async () => {
    const { manager, registry, createdWith } = makeManager();

    const first = await manager.add('/repo/alpha');
    const second = await manager.add('/repo/alpha');

    expect(second).toBe(first);
    expect(manager.list()).toHaveLength(1);
    expect(registry.entries).toHaveLength(1);
    expect(createdWith.map((call) => call.projectDir)).toEqual(['/repo/alpha']);
  });

  // P3 — two repositories with the same basename.
  it('P3: disambiguates prefixes when two projects share a basename', async () => {
    const { manager } = makeManager();

    const a = await manager.add('/x/web');
    const b = await manager.add('/y/web');

    expect(a.prefix).toBe('web');
    expect(b.prefix).toBe('web-2');
  });

  it('looks projects up by prefix, by id and by path', async () => {
    const { manager } = makeManager();
    const project = await manager.add('/repo/alpha');

    expect(manager.getByPrefix('alpha')).toBe(project);
    expect(manager.getById('id:/repo/alpha')).toBe(project);
    expect(await manager.getByPath('/repo/alpha')).toBe(project);
    expect(manager.getByPrefix('nope')).toBeNull();
    expect(manager.getById('nope')).toBeNull();
    expect(await manager.getByPath('/repo/none')).toBeNull();
  });

  // P9 — `project rm` stops serving and demotes, without destroying history.
  it('P9: removes a project: stops loops, drops it from the map, demotes the row', async () => {
    const { manager, registry, loopCalls } = makeManager();
    await manager.add('/repo/alpha');

    await manager.remove('alpha');

    expect(manager.list()).toEqual([]);
    expect(registry.entries.map((entry) => entry.source)).toEqual(['discovered']);
    expect(loopCalls.get('alpha')).toEqual(['startLight', 'stopHeavy', 'stopLight']);
  });

  it('remove is a no-op for an unknown prefix', async () => {
    const { manager } = makeManager();
    await expect(manager.remove('ghost')).resolves.toBeUndefined();
  });

  it('setActive toggles heavy loops idempotently without touching light loops', async () => {
    const { manager, loopCalls } = makeManager();
    const project = await manager.add('/repo/alpha');

    manager.setActive('alpha', true);
    expect(project.active).toBe(true);
    manager.setActive('alpha', true); // idempotent — no second startHeavy
    manager.setActive('alpha', false);
    expect(project.active).toBe(false);
    manager.setActive('alpha', false); // idempotent — no second stopHeavy

    expect(loopCalls.get('alpha')).toEqual(['startLight', 'startHeavy', 'stopHeavy']);
  });

  // P11 — restart: curated projects come back, ephemeral ones do not.
  it('P11: loadPersisted materializes curated projects without re-persisting them', async () => {
    const { manager, registry } = makeManager([
      registeredRecord('/repo/alpha', 'stale'),
      { ...registeredRecord('/repo/gamma', 'gamma'), source: 'discovered' },
    ]);

    const loaded = await manager.loadPersisted();

    expect(loaded.map((project) => project.entry.root)).toEqual(['/repo/alpha']);
    // The label is re-derived from fresh config, never the stale stored one.
    expect(manager.getByPrefix('alpha')?.entry.name).toBe('name:/repo/alpha');
    // A `discovered` project is known but not served: it never ran here.
    expect(manager.getByPrefix('gamma')).toBeNull();
    expect(registry.entries.map((entry) => entry.name)).toEqual(['stale', 'gamma']);
  });

  // P5 — a curated entry whose checkout has disappeared.
  it('P5: loadPersisted logs and skips an entry that cannot be materialized', async () => {
    const registry = fakeRegistry([
      registeredRecord('/repo/alpha', 'Alpha'),
      registeredRecord('/repo/beta', 'Beta'),
    ]);
    const warnings: string[] = [];
    const manager = new ProjectManager<FakeRuntime>({
      registry,
      port: 3737,
      resolveRoot: (path) => path,
      warn: (message) => warnings.push(message),
      createRuntime: ({ projectDir }) => {
        if (projectDir === '/repo/beta') throw new Error('no such directory');
        return { projectId: `id:${projectDir}`, config: { name: `name:${projectDir}` } };
      },
    });

    const loaded = await manager.loadPersisted();

    expect(loaded.map((project) => project.entry.root)).toEqual(['/repo/alpha']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/repo/beta');
    // Skipping is not forgetting: the entry stays curated for the next start.
    expect(registry.entries.map((entry) => entry.source)).toEqual(['registered', 'registered']);
  });
});
