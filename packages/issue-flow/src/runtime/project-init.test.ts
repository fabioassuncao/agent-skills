import { describe, expect, it } from 'vitest';
import { type ProjectInitDeps, ProjectInitTracker, runProjectInit } from './project-init.js';

/**
 * Ported from `backend/src/__tests__/project-init-service.test.ts` @ d8c9d5f
 * (6 cases). The tracker port is literal; `register` became async here, and
 * the log sink is injected instead of imported.
 */

describe('ProjectInitTracker', () => {
  it('upserts phase transitions and carries prefix/name into ready', () => {
    const tracker = new ProjectInitTracker();
    tracker.set('/repo/a', { phase: 'creating_config' });
    expect(tracker.isActive('/repo/a')).toBe(true);

    tracker.set('/repo/a', { phase: 'analyzing' });
    tracker.set('/repo/a', { phase: 'ready', prefix: 'a', name: 'A' });

    expect(tracker.get('/repo/a')).toMatchObject({
      phase: 'ready',
      prefix: 'a',
      name: 'A',
      error: null,
    });
    expect(tracker.isActive('/repo/a')).toBe(false);
  });

  it('evicts terminal entries past the TTL but keeps in-flight ones', () => {
    let clock = 1000;
    const tracker = new ProjectInitTracker({ ttlMs: 100, now: () => clock });

    tracker.set('/repo/done', { phase: 'ready', prefix: 'done', name: 'Done' });
    tracker.set('/repo/busy', { phase: 'analyzing' });

    clock = 1050; // within the TTL — both visible
    expect(
      tracker
        .list()
        .map((state) => state.path)
        .sort(),
    ).toEqual(['/repo/busy', '/repo/done']);

    clock = 1200; // the terminal entry is past its TTL; the in-flight one stays
    expect(tracker.list().map((state) => state.path)).toEqual(['/repo/busy']);
  });
});

function makeDeps(
  overrides: Partial<ProjectInitDeps> & { calls?: string[] } = {},
): ProjectInitDeps {
  const calls = overrides.calls ?? [];
  return {
    analyzerAvailable: overrides.analyzerAvailable ?? ((): boolean => true),
    scaffold:
      overrides.scaffold ??
      (async (): Promise<void> => {
        calls.push('scaffold');
      }),
    analyze:
      overrides.analyze ??
      (async (): Promise<void> => {
        calls.push('analyze');
      }),
    register:
      overrides.register ??
      (async (): Promise<{ prefix: string; name: string }> => {
        calls.push('register');
        return { prefix: 'a', name: 'A' };
      }),
  };
}

describe('runProjectInit', () => {
  // P1 — the phases a repository without configuration goes through.
  it('P1: scaffolds, analyzes, registers, then marks ready (in order)', async () => {
    const calls: string[] = [];
    const phases: string[] = [];
    const tracker = new ProjectInitTracker();
    const deps = makeDeps({
      calls,
      scaffold: async () => {
        calls.push('scaffold');
        phases.push(tracker.get('/repo/a')?.phase ?? '');
      },
      analyze: async () => {
        calls.push('analyze');
        phases.push(tracker.get('/repo/a')?.phase ?? '');
      },
    });

    await runProjectInit(tracker, '/repo/a', deps);

    expect(calls).toEqual(['scaffold', 'analyze', 'register']);
    expect(phases).toEqual(['creating_config', 'analyzing']);
    expect(tracker.get('/repo/a')).toMatchObject({ phase: 'ready', prefix: 'a', name: 'A' });
  });

  it('skips analysis when no analyzer is available but still registers', async () => {
    const calls: string[] = [];
    const tracker = new ProjectInitTracker();
    await runProjectInit(tracker, '/repo/a', makeDeps({ calls, analyzerAvailable: () => false }));

    expect(calls).toEqual(['scaffold', 'register']);
    expect(tracker.get('/repo/a')?.phase).toBe('ready');
  });

  it('registers anyway when analysis throws (best-effort enrichment)', async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const tracker = new ProjectInitTracker();
    await runProjectInit(
      tracker,
      '/repo/a',
      makeDeps({
        calls,
        analyze: async () => {
          throw new Error('policy discovery blew up');
        },
      }),
      (message) => warnings.push(message),
    );

    expect(calls).toEqual(['scaffold', 'register']);
    expect(tracker.get('/repo/a')?.phase).toBe('ready');
    expect(warnings[0]).toContain('policy discovery blew up');
  });

  it('marks failed and does not register when the scaffold throws', async () => {
    const calls: string[] = [];
    const tracker = new ProjectInitTracker();
    await runProjectInit(
      tracker,
      '/repo/a',
      makeDeps({
        calls,
        scaffold: async () => {
          throw new Error('cannot write AGENTS.md');
        },
      }),
    );

    expect(calls).toEqual([]);
    expect(tracker.get('/repo/a')).toMatchObject({
      phase: 'failed',
      error: 'cannot write AGENTS.md',
    });
  });

  it('marks failed when registration throws', async () => {
    const tracker = new ProjectInitTracker();
    await runProjectInit(
      tracker,
      '/repo/a',
      makeDeps({
        register: async () => {
          throw new Error('not a git repository');
        },
      }),
    );

    expect(tracker.get('/repo/a')).toMatchObject({
      phase: 'failed',
      error: 'not a git repository',
    });
  });
});
