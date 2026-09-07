import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectRegistry, type ProjectRegistry } from '../storage/projects/registry.js';
import {
  assignPrefixes,
  type ProjectCommandDeps,
  runProjectAdd,
  runProjectLs,
  runProjectRm,
  runProjectUse,
} from './project.js';

/**
 * These exercise the adaptation §47.5 marks as mandatory: the commands read
 * and write SQLite directly, so every case here runs with **no server at all**
 * (P12). `notifyServer` is stubbed for the same reason — reaching a monitor is
 * a courtesy, never a precondition.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function harness(): Promise<{
  registry: ProjectRegistry;
  deps: ProjectCommandDeps;
  output: string[];
  errors: string[];
  notified: unknown[];
}> {
  const home = await mkdtemp(join(tmpdir(), 'issue-flow-project-cmd-'));
  directories.push(home);
  const registry = createProjectRegistry({
    databaseOptions: { env: { ISSUE_FLOW_HOME: home } },
  });
  const output: string[] = [];
  const errors: string[] = [];
  const notified: unknown[] = [];
  return {
    registry,
    output,
    errors,
    notified,
    deps: {
      registry,
      resolveRoot: async (path) => path,
      projectIdFor: async (root) => `id:${root}`,
      nameFor: async (root) => root.split('/').pop() ?? root,
      needsSetup: async () => false,
      notifyServer: async (change) => {
        notified.push(change);
      },
      log: (message) => output.push(message),
      warn: (message) => output.push(message),
      error: (message) => errors.push(message),
    },
  };
}

describe('assignPrefixes', () => {
  it('gives a prefix only to curated projects, disambiguating collisions', () => {
    const base = {
      remoteUrl: null,
      name: null,
      addedAt: null,
      lastSeenAt: null,
      createdAt: '',
      updatedAt: '',
    };
    const prefixes = assignPrefixes([
      { ...base, id: 'a', root: '/x/web', source: 'registered' },
      { ...base, id: 'b', root: '/y/web', source: 'registered' },
      { ...base, id: 'c', root: '/z/api', source: 'discovered' },
    ]);

    expect(prefixes.get('a')).toBe('web');
    expect(prefixes.get('b')).toBe('web-2');
    expect(prefixes.has('c')).toBe(false);
  });
});

describe('issue-flow project', () => {
  // P12 — the command that must never require a server.
  it('P12: lists projects straight from SQLite with nothing running', async () => {
    const { deps, output } = await harness();
    await runProjectAdd('/repo/web', {}, deps);
    output.length = 0;

    expect(await runProjectLs({}, deps)).toBe(0);

    expect(output[0]).toContain('PREFIX');
    expect(output[1]).toContain('web');
    expect(output[1]).toContain('registered');
    expect(output[1]).toContain('/repo/web');
  });

  it('explains an empty registry instead of printing an empty table', async () => {
    const { deps, output } = await harness();
    await runProjectLs({}, deps);
    expect(output[0]).toMatch(/No known project/);
  });

  it('emits the same list as JSON, prefixes included', async () => {
    const { deps, output } = await harness();
    await runProjectAdd('/repo/web', {}, deps);
    output.length = 0;

    await runProjectLs({ json: true }, deps);
    const payload = JSON.parse(output[0]) as {
      schemaVersion: number;
      projects: Array<{ id: string; prefix: string | null; source: string }>;
    };

    expect(payload.schemaVersion).toBe(1);
    expect(payload.projects).toEqual([
      expect.objectContaining({ id: 'id:/repo/web', prefix: 'web', source: 'registered' }),
    ]);
  });

  // P7 — a project a plain `run` discovered is listed, without a prefix.
  it('P7: shows a discovered project among the known ones', async () => {
    const { deps, registry, output } = await harness();
    await registry.register({ id: 'id:/repo/ran', root: '/repo/ran', source: 'discovered' });

    await runProjectLs({}, deps);

    expect(output[1]).toContain('discovered');
    expect(output[1]).toContain('/repo/ran');
  });

  // P8 — adding a project that only ever ran promotes it.
  it('P8: promotes a discovered project without losing its history', async () => {
    const { deps, registry } = await harness();
    await registry.register({ id: 'id:/repo/web', root: '/repo/web', source: 'discovered' });
    const before = await registry.get('id:/repo/web');

    expect(await runProjectAdd('/repo/web', {}, deps)).toBe(0);

    const after = await registry.get('id:/repo/web');
    expect(after).toMatchObject({ source: 'registered' });
    expect(after?.addedAt).toBe(before?.addedAt);
    expect(after?.createdAt).toBe(before?.createdAt);
  });

  // P2 — twice is once.
  it('P2: adding the same path twice leaves one row and one prefix', async () => {
    const { deps, registry } = await harness();
    await runProjectAdd('/repo/web', {}, deps);
    await runProjectAdd('/repo/web', {}, deps);

    const projects = await registry.list();
    expect(projects).toHaveLength(1);
    expect(assignPrefixes(projects).get(projects[0].id)).toBe('web');
  });

  it('refuses a path that is not a repository', async () => {
    const { deps, errors } = await harness();
    deps.resolveRoot = async () => {
      throw new Error('not a git repository');
    };

    expect(await runProjectAdd('/tmp/nope', {}, deps)).toBe(1);
    expect(errors[0]).toContain('Not a git repository');
  });

  // P1 — a repository with nothing configured walks the phases and ends ready.
  it('P1: reports creating_config → analyzing → ready and curates the project', async () => {
    const { deps, registry, output } = await harness();
    const steps: string[] = [];
    deps.needsSetup = async () => true;
    deps.initDeps = (register) => ({
      analyzerAvailable: () => true,
      scaffold: async () => {
        steps.push('scaffold');
      },
      analyze: async () => {
        steps.push('analyze');
      },
      register: async (root) => {
        steps.push('register');
        return register(root);
      },
    });

    expect(await runProjectAdd('/repo/fresh', {}, deps)).toBe(0);

    expect(steps).toEqual(['scaffold', 'analyze', 'register']);
    expect(output).toEqual([
      '  Creating the missing convention files…',
      '  Analyzing the repository…',
      'Added fresh (fresh) — /repo/fresh',
    ]);
    expect(await registry.get('id:/repo/fresh')).toMatchObject({ source: 'registered' });
  });

  it('reports a terminal setup failure and does not curate the project', async () => {
    const { deps, registry, errors } = await harness();
    deps.needsSetup = async () => true;
    deps.initDeps = (register) => ({
      analyzerAvailable: () => true,
      scaffold: async () => {
        throw new Error('cannot write AGENTS.md');
      },
      analyze: async () => {},
      register,
    });

    expect(await runProjectAdd('/repo/fresh', {}, deps)).toBe(1);
    expect(errors[0]).toBe('cannot write AGENTS.md');
    expect(await registry.get('id:/repo/fresh')).toBeNull();
  });

  // P9 — removal is demotion.
  it('P9: rm stops curating and says the history is preserved', async () => {
    const { deps, registry, output, notified } = await harness();
    await runProjectAdd('/repo/web', {}, deps);
    output.length = 0;

    expect(await runProjectRm('web', {}, deps)).toBe(0);

    expect((await registry.get('id:/repo/web'))?.source).toBe('discovered');
    expect(output[0]).toMatch(/untouched/);
    expect(notified).toContainEqual({ kind: 'removed', prefix: 'web', id: 'id:/repo/web' });
  });

  it('rm accepts the project id and a path as well as the prefix', async () => {
    const { deps, registry } = await harness();
    await runProjectAdd('/repo/web', {}, deps);
    expect(await runProjectRm('id:/repo/web', {}, deps)).toBe(0);
    expect((await registry.get('id:/repo/web'))?.source).toBe('discovered');

    await runProjectAdd('/repo/web', {}, deps);
    expect(await runProjectRm('/repo/web', {}, deps)).toBe(0);
    expect((await registry.get('id:/repo/web'))?.source).toBe('discovered');
  });

  it('rm reports an unknown project and leaves a discovered one alone', async () => {
    const { deps, registry, errors, output } = await harness();
    expect(await runProjectRm('ghost', {}, deps)).toBe(1);
    expect(errors[0]).toContain('ghost');

    await registry.register({ id: 'id:/repo/ran', root: '/repo/ran', source: 'discovered' });
    expect(await runProjectRm('/repo/ran', {}, deps)).toBe(0);
    expect(output.some((line) => line.includes('not curated'))).toBe(true);
  });

  it('use stamps recency and reorders the list', async () => {
    const { deps, registry, output } = await harness();
    await runProjectAdd('/repo/a', {}, deps);
    await runProjectAdd('/repo/b', {}, deps);
    output.length = 0;

    expect(await runProjectUse('a', {}, deps)).toBe(0);

    expect(output[0]).toContain('/repo/a');
    expect((await registry.list())[0].id).toBe('id:/repo/a');
  });

  it('use reports an unknown project', async () => {
    const { deps, errors } = await harness();
    expect(await runProjectUse('ghost', {}, deps)).toBe(1);
    expect(errors[0]).toContain('ghost');
  });
});
