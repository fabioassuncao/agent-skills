import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSession } from '../agents/session/types.js';
import { ProjectManager } from '../runtime/project-manager.js';
import { createProjectRegistry } from '../storage/projects/registry.js';
import {
  autoAddCwd,
  loadProjects,
  matchesTerminalRequest,
  PROJECT_DIR_ENV,
  projectDirsFromEnv,
} from './serve.js';

/**
 * The boot half of `issue-flow serve`: which projects a fresh server ends up
 * serving, and which ones it writes down. Nothing here binds a socket — the
 * server itself is covered by `web/server.test.ts` and `web/lock.test.ts`.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface FakeRuntime {
  projectId: string;
  config: { name: string };
}

async function harness(options: { missing?: string[] } = {}) {
  // Every path in these cases is a "repository" unless the case says otherwise:
  // resolving a real git root is `utils/git.ts`'s job and is tested there.
  const home = await mkdtemp(join(tmpdir(), 'issue-flow-serve-'));
  directories.push(home);
  const registry = createProjectRegistry({
    databaseOptions: { env: { ISSUE_FLOW_HOME: home } },
  });
  const warnings: string[] = [];
  const missing = new Set(options.missing ?? []);
  const manager = new ProjectManager<FakeRuntime>({
    registry,
    port: 3737,
    warn: (message) => warnings.push(message),
    resolveRoot: (path) => {
      if (missing.has(path)) throw new Error(`Not a git repository: ${path}`);
      return path;
    },
    createRuntime: ({ projectDir }) => ({
      projectId: `id:${projectDir}`,
      config: { name: projectDir.split('/').pop() ?? projectDir },
    }),
  });
  return { home, registry, manager, warnings };
}

describe('projectDirsFromEnv', () => {
  it('reads several roots from one variable', () => {
    expect(projectDirsFromEnv({ [PROJECT_DIR_ENV]: '/a:/b' })).toEqual(['/a', '/b']);
    expect(projectDirsFromEnv({ [PROJECT_DIR_ENV]: '/a; /b ;' })).toEqual(['/a', '/b']);
  });

  it('is absent by default and tolerates an empty value', () => {
    expect(projectDirsFromEnv({})).toEqual([]);
    expect(projectDirsFromEnv({ [PROJECT_DIR_ENV]: '  ' })).toEqual([]);
  });
});

describe('serve boot', () => {
  // P11 — a restart brings back exactly the curated projects.
  it('P11: reloads curated projects and nothing else', async () => {
    const { registry, manager } = await harness();
    await registry.register({ id: 'id:/repo/a', root: '/repo/a', name: 'A' });
    await registry.register({ id: 'id:/repo/b', root: '/repo/b', source: 'discovered' });

    await loadProjects(manager, {
      cwd: '/elsewhere',
      env: {},
      projectDirs: [],
      isRepository: async () => false,
    });

    expect(manager.list().map((project) => project.entry.root)).toEqual(['/repo/a']);
  });

  // P5 — a curated entry whose checkout is gone must not stop the boot.
  it('P5: logs and skips an entry whose root has disappeared, and still serves the rest', async () => {
    const { registry, manager, warnings } = await harness({ missing: ['/repo/gone'] });
    await registry.register({ id: 'id:/repo/gone', root: '/repo/gone', name: 'Gone' });
    await registry.register({ id: 'id:/repo/a', root: '/repo/a', name: 'A' });

    await loadProjects(manager, {
      cwd: '/elsewhere',
      env: {},
      projectDirs: [],
      isRepository: async () => false,
    });

    expect(manager.list().map((project) => project.entry.root)).toEqual(['/repo/a']);
    expect(warnings.join('\n')).toContain('/repo/gone');
    // Skipping is not forgetting: the entry is still curated next time.
    expect((await registry.listRegistered()).map((entry) => entry.root)).toEqual([
      '/repo/gone',
      '/repo/a',
    ]);
  });

  // P6 — the repository `serve` is standing in is served but never written.
  it('P6: auto-adds the current repository ephemerally', async () => {
    const { registry, manager } = await harness();

    await autoAddCwd(manager, '/repo/cwd', async () => true);

    const served = manager.getByPrefix('cwd');
    expect(served?.entry.source).toBe('ephemeral');
    // Nothing persisted, so no other server on this machine inherits it.
    expect(await registry.list()).toEqual([]);
  });

  it('P6: leaves a cwd that is not a repository alone', async () => {
    const { manager } = await harness({ missing: ['/not/a/repo'] });
    await autoAddCwd(manager, '/not/a/repo', async () => false);
    expect(manager.list()).toEqual([]);
  });

  it('serves --project and ISSUE_FLOW_PROJECT_DIR roots ephemerally too', async () => {
    const { registry, manager } = await harness();

    await loadProjects(manager, {
      cwd: '/elsewhere',
      env: { [PROJECT_DIR_ENV]: '/repo/env' },
      projectDirs: ['/repo/flag'],
      isRepository: async () => false,
    });

    expect(
      manager
        .list()
        .map((project) => project.entry.root)
        .sort(),
    ).toEqual(['/repo/env', '/repo/flag']);
    expect(manager.list().every((project) => project.entry.source === 'ephemeral')).toBe(true);
    expect(await registry.list()).toEqual([]);
  });

  it('skips an unusable --project root without failing the boot', async () => {
    const { manager } = await harness({ missing: ['/repo/gone'] });

    await loadProjects(manager, {
      cwd: '/elsewhere',
      env: {},
      projectDirs: ['/repo/gone', '/repo/ok'],
      isRepository: async () => false,
    });

    expect(manager.list().map((project) => project.entry.root)).toEqual(['/repo/ok']);
  });

  // §47.4's own acceptance line: `serve` with three projects.
  it('serves three projects at once, each under its own prefix', async () => {
    const { registry, manager } = await harness();
    await registry.register({ id: 'id:/x/web', root: '/x/web', name: 'Web' });
    await registry.register({ id: 'id:/y/web', root: '/y/web', name: 'Web too' });
    await registry.register({ id: 'id:/z/api', root: '/z/api', name: 'Api' });

    await loadProjects(manager, {
      cwd: '/repo/cwd',
      env: {},
      projectDirs: [],
      isRepository: async () => true,
    });

    expect(manager.list().map((project) => project.prefix)).toEqual([
      'web',
      'web-2',
      // A repository named after a hub route never shadows it.
      'api-2',
      // Plus the ephemeral cwd.
      'cwd',
    ]);
  });
});

/**
 * Which session a terminal connection is asking for.
 *
 * Phase 8D turned the transport on for the first time (nothing wired
 * `terminal` before it), so this is the decision that decides what a viewer is
 * allowed to attach to.
 */
describe('matchesTerminalRequest', () => {
  function session(overrides: Partial<AgentSession> = {}): AgentSession {
    return {
      id: 'sess-1',
      runId: null,
      phase: null,
      storyId: null,
      branch: 'session/a',
      worktreeId: 'wt-1',
      provider: 'claude',
      conversationId: null,
      status: 'running',
      paneTarget: 'if-proj:if-session-a.0',
      label: null,
      createdAt: '2026-09-06T10:00:00.000Z',
      updatedAt: '2026-09-06T10:00:00.000Z',
      endedAt: null,
      ...overrides,
    };
  }

  it('answers the session the id names, and ignores the branch beside it', () => {
    expect(matchesTerminalRequest(session(), { sessionId: 'sess-1', branch: 'other' })).toBe(true);
    expect(matchesTerminalRequest(session(), { sessionId: 'sess-2', branch: 'session/a' })).toBe(
      false,
    );
  });

  it('falls back to the branch when no id was given', () => {
    expect(matchesTerminalRequest(session(), { sessionId: null, branch: 'session/a' })).toBe(true);
    expect(matchesTerminalRequest(session(), { sessionId: null, branch: 'session/b' })).toBe(false);
  });

  // A stopped session has no window: answering with it would hand the viewer an
  // attach that fails instead of a refusal it can explain.
  it('never matches a session that is not live', () => {
    for (const status of ['stopped', 'orphaned'] as const) {
      expect(
        matchesTerminalRequest(session({ status }), { sessionId: 'sess-1', branch: null }),
      ).toBe(false);
    }
  });

  it('matches nothing when the request names neither', () => {
    expect(matchesTerminalRequest(session(), { sessionId: null, branch: null })).toBe(false);
  });
});
