import { describe, expect, it } from 'vitest';
import { ProjectInitTracker } from '../runtime/project-init.js';
import { ProjectManager } from '../runtime/project-manager.js';
import type { ProjectRecord, ProjectRegistry } from '../storage/projects/registry.js';
import {
  addProject,
  listProjectInits,
  listProjects,
  type ProjectsApiDeps,
  removeProject,
} from './projects-api.js';

interface FakeRuntime {
  projectId: string;
  config: { name: string };
}

function fakeRegistry(initial: ProjectRecord[] = []): ProjectRegistry & {
  entries: ProjectRecord[];
} {
  const entries = [...initial];
  return {
    entries,
    list: async () => [...entries],
    listRegistered: async () => entries.filter((entry) => entry.source === 'registered'),
    get: async (id) => entries.find((entry) => entry.id === id) ?? null,
    getByRoot: async (root) => entries.find((entry) => entry.root === root) ?? null,
    register: async (input) => {
      const record: ProjectRecord = {
        id: input.id,
        root: input.root,
        remoteUrl: null,
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
    touch: async () => true,
  };
}

function makeDeps(
  overrides: Partial<ProjectsApiDeps> & { initial?: ProjectRecord[] } = {},
): ProjectsApiDeps & { registry: ReturnType<typeof fakeRegistry>; started: string[] } {
  const registry = fakeRegistry(overrides.initial ?? []);
  const started: string[] = [];
  const manager = new ProjectManager<FakeRuntime>({
    registry,
    port: 3737,
    resolveRoot: (path) => path,
    createRuntime: ({ projectDir }) => ({
      projectId: `id:${projectDir}`,
      config: { name: `name:${projectDir}` },
    }),
  });
  return {
    manager,
    registry,
    started,
    tracker: overrides.tracker ?? new ProjectInitTracker(),
    writable: overrides.writable ?? true,
    resolveRoot: overrides.resolveRoot ?? (async (path) => path),
    needsSetup: overrides.needsSetup ?? (async () => false),
    startSetup: overrides.startSetup ?? ((root) => started.push(root)),
  };
}

function record(id: string, root: string, source: ProjectRecord['source']): ProjectRecord {
  return {
    id,
    root,
    remoteUrl: null,
    name: id.toUpperCase(),
    addedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: null,
    source,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('GET /api/projects', () => {
  // The whole point of the phase: a project with no active run is visible.
  it('lists projects that are served and projects that are merely known', async () => {
    const deps = makeDeps({ initial: [record('id:/repo/c', '/repo/c', 'registered')] });
    await deps.manager.add('/repo/a');

    const response = await listProjects(deps);
    const body = response.body as { projects: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.projects.map((project) => [project.id, project.served, project.prefix])).toEqual([
      ['id:/repo/a', true, 'a'],
      ['id:/repo/c', false, null],
    ]);
  });

  it('answers an empty list for a monitor with no project surface', async () => {
    expect(await listProjects(null)).toEqual({ status: 200, body: { projects: [] } });
  });
});

describe('POST /api/projects', () => {
  it('serves an already-configured repository directly', async () => {
    const deps = makeDeps();
    const response = await addProject(deps, { path: '/repo/a' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ initializing: false, path: '/repo/a' });
    expect(deps.manager.getByPrefix('a')?.entry.source).toBe('registered');
  });

  // P2 — the same path twice.
  it('P2: answers the existing project when it is already served', async () => {
    const deps = makeDeps();
    await addProject(deps, { path: '/repo/a' });
    const again = await addProject(deps, { path: '/repo/a' });

    expect(again.status).toBe(200);
    expect(deps.manager.list()).toHaveLength(1);
    expect(deps.registry.entries).toHaveLength(1);
  });

  // P1 — a repository with nothing configured is set up asynchronously.
  it('P1: starts an observable setup for a repository that needs one', async () => {
    const deps = makeDeps({ needsSetup: async () => true });

    const response = await addProject(deps, { path: '/repo/fresh' });

    expect(response).toEqual({ status: 202, body: { initializing: true, path: '/repo/fresh' } });
    expect(deps.started).toEqual(['/repo/fresh']);
  });

  it('does not start a second setup for a repository already being set up', async () => {
    const tracker = new ProjectInitTracker();
    tracker.set('/repo/fresh', { phase: 'analyzing' });
    const deps = makeDeps({ tracker, needsSetup: async () => true });

    const response = await addProject(deps, { path: '/repo/fresh' });

    expect(response.status).toBe(202);
    expect(deps.started).toEqual([]);
  });

  it('rejects a path that is not a repository', async () => {
    const deps = makeDeps({
      resolveRoot: async () => {
        throw new Error('not a git repository');
      },
    });
    expect((await addProject(deps, { path: '/tmp/nope' })).status).toBe(400);
  });

  it('rejects a malformed body', async () => {
    const deps = makeDeps();
    expect((await addProject(deps, null)).status).toBe(400);
    expect((await addProject(deps, [])).status).toBe(400);
    expect((await addProject(deps, {})).status).toBe(400);
    expect((await addProject(deps, { path: '  ' })).status).toBe(400);
  });

  // ADR-10: a write surface reachable from the network is refused, exactly as
  // the configuration writes already are.
  it('refuses to write when the monitor is not bound to loopback', async () => {
    const deps = makeDeps({ writable: false });
    expect((await addProject(deps, { path: '/repo/a' })).status).toBe(403);
    expect((await removeProject(deps, 'a')).status).toBe(403);
  });
});

describe('DELETE /api/projects/:prefix', () => {
  // P9 — removal stops the serving and demotes; it never deletes.
  it('P9: stops serving the project and demotes its row', async () => {
    const deps = makeDeps();
    await addProject(deps, { path: '/repo/a' });

    const response = await removeProject(deps, 'a');

    expect(response.status).toBe(200);
    expect(deps.manager.list()).toEqual([]);
    expect(deps.registry.entries.map((entry) => entry.source)).toEqual(['discovered']);
  });

  it('404s for a prefix nothing is served under', async () => {
    expect((await removeProject(makeDeps(), 'ghost')).status).toBe(404);
  });
});

describe('GET /api/project-inits', () => {
  it('reports the phases of in-flight setups', () => {
    const tracker = new ProjectInitTracker();
    tracker.set('/repo/fresh', { phase: 'creating_config' });
    const deps = makeDeps({ tracker });

    expect(listProjectInits(deps)).toEqual({
      status: 200,
      body: { inits: [expect.objectContaining({ path: '/repo/fresh', phase: 'creating_config' })] },
    });
  });

  it('reports nothing for a monitor with no project surface', () => {
    expect(listProjectInits(null)).toEqual({ status: 200, body: { inits: [] } });
  });
});
