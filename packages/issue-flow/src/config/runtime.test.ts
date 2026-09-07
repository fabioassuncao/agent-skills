import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeConfig, parseStartupEnv, setRuntimeCliOverrides } from './runtime.js';

/**
 * Adapted from the `loadConfig` cases of WebMux
 * `backend/src/__tests__/setup.test.ts` @ d8c9d5f. The upstream reads two YAML
 * files; here the same shapes arrive through `.issue-flow.json` and the
 * project's own precedence ladder, so what carries over is the *behaviour* being
 * asserted — profile overlay by name, a tolerant parse, a usable default — not
 * the file format.
 */

const dirs: string[] = [];

afterEach(async () => {
  setRuntimeCliOverrides({});
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function projectWith(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'issue-flow-runtime-config-'));
  dirs.push(dir);
  await writeFile(join(dir, '.issue-flow.json'), JSON.stringify(config), 'utf-8');
  return dir;
}

const silent = () => {};

describe('loadRuntimeConfig', () => {
  it('gives an unconfigured project the default profile and no services', async () => {
    const dir = await projectWith({});
    const config = await loadRuntimeConfig({ projectRoot: dir, env: {}, warn: silent });

    expect(config.profile).toBe('default');
    expect(Object.keys(config.profiles)).toEqual(['default']);
    expect(config.profiles.default?.runtime).toBe('host');
    expect(config.profiles.default?.panes).toEqual([
      { id: 'agent', kind: 'agent', focus: true },
      { id: 'shell', kind: 'shell', split: 'right', sizePct: 25 },
    ]);
    expect(config.services).toEqual([]);
    expect(config.startupEnv).toEqual({});
  });

  it('loads the full runtime section', async () => {
    const dir = await projectWith({
      runtime: {
        profile: 'sandbox',
        profiles: {
          default: {
            runtime: 'host',
            yolo: true,
            envPassthrough: ['GITHUB_TOKEN'],
            panes: [{ id: 'agent', kind: 'agent', focus: true }],
          },
          sandbox: {
            image: 'issue-flow-sandbox',
            envPassthrough: ['AWS_ACCESS_KEY_ID'],
          },
        },
        services: [{ name: 'API', portEnv: 'API_PORT', portStart: 4100 }],
        startupEnv: { FEATURE_FLAG: true, REGION: 'eu' },
      },
    });

    const config = await loadRuntimeConfig({ projectRoot: dir, env: {}, warn: silent });

    expect(config.profile).toBe('sandbox');
    expect(config.profiles.default?.permission).toBe('autonomous');
    expect(config.profiles.default?.envPassthrough).toEqual(['GITHUB_TOKEN']);
    // Not declared, inferred from the name — the upstream's one special case.
    expect(config.profiles.sandbox?.runtime).toBe('docker');
    expect(config.profiles.sandbox?.image).toBe('issue-flow-sandbox');
    expect(config.services).toEqual([{ name: 'API', portEnv: 'API_PORT', portStart: 4100 }]);
    expect(config.startupEnv).toEqual({ FEATURE_FLAG: 'true', REGION: 'eu' });
  });

  it('keeps the built-in default alongside the declared profiles', async () => {
    const dir = await projectWith({ runtime: { profiles: { local: { runtime: 'host' } } } });
    const config = await loadRuntimeConfig({ projectRoot: dir, env: {}, warn: silent });

    expect(Object.keys(config.profiles).sort()).toEqual(['default', 'local']);
    expect(config.profile).toBe('default');
  });

  it('lets a project redefine the default profile whole', async () => {
    const dir = await projectWith({
      runtime: { profiles: { default: { runtime: 'docker', image: 'img' } } },
    });
    const config = await loadRuntimeConfig({ projectRoot: dir, env: {}, warn: silent });

    expect(config.profiles.default?.runtime).toBe('docker');
    expect(config.profiles.default?.image).toBe('img');
  });

  it('reads the active profile from the environment, over the file', async () => {
    const dir = await projectWith({
      runtime: { profile: 'default', profiles: { sandbox: { image: 'img' } } },
    });
    const config = await loadRuntimeConfig({
      projectRoot: dir,
      env: { ISSUE_FLOW_RUNTIME_PROFILE: 'sandbox' },
      warn: silent,
    });

    expect(config.profile).toBe('sandbox');
  });

  it('lets a CLI override win over the environment', async () => {
    const dir = await projectWith({ runtime: { profiles: { sandbox: { image: 'img' } } } });
    const config = await loadRuntimeConfig({
      projectRoot: dir,
      cli: { profile: 'default' },
      env: { ISSUE_FLOW_RUNTIME_PROFILE: 'sandbox' },
      warn: silent,
    });

    expect(config.profile).toBe('default');
  });

  it('reads CLI overrides captured by the preAction hook', async () => {
    const dir = await projectWith({ runtime: { profiles: { sandbox: { image: 'img' } } } });
    setRuntimeCliOverrides({ profile: 'sandbox' });

    expect((await loadRuntimeConfig({ projectRoot: dir, env: {}, warn: silent })).profile).toBe(
      'sandbox',
    );
  });

  // A run that silently used `default` because the name was misspelled is a run
  // whose isolation nobody got.
  it('warns and falls back for a profile nobody declared', async () => {
    const warnings: string[] = [];
    const dir = await projectWith({ runtime: { profile: 'sandox' } });
    const config = await loadRuntimeConfig({
      projectRoot: dir,
      env: {},
      warn: (message) => warnings.push(message),
    });

    expect(config.profile).toBe('default');
    expect(warnings.join(' ')).toContain('sandox');
  });

  it('degrades a non-object runtime section to the defaults, with a warning', async () => {
    const warnings: string[] = [];
    const dir = await projectWith({ runtime: 'sandbox' });
    const config = await loadRuntimeConfig({
      projectRoot: dir,
      env: {},
      warn: (message) => warnings.push(message),
    });

    expect(Object.keys(config.profiles)).toEqual(['default']);
    expect(warnings.join(' ')).toContain('runtime');
  });

  it('drops one unusable pane without costing the others', async () => {
    const dir = await projectWith({
      runtime: {
        profiles: {
          default: {
            panes: [
              { id: 'agent', kind: 'agent', focus: true },
              { id: 'app', kind: 'command' },
              { id: 'shell', kind: 'shell', split: 'bottom' },
            ],
          },
        },
      },
    });

    const config = await loadRuntimeConfig({ projectRoot: dir, env: {}, warn: silent });
    expect(config.profiles.default?.panes.map((pane) => pane.id)).toEqual(['agent', 'shell']);
  });

  it('never throws on an unreadable project file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'issue-flow-runtime-config-'));
    dirs.push(dir);
    await writeFile(join(dir, '.issue-flow.json'), '{ not json', 'utf-8');

    const config = await loadRuntimeConfig({ projectRoot: dir, env: {}, warn: silent });
    expect(config.profile).toBe('default');
  });
});

describe('parseStartupEnv', () => {
  it('stringifies booleans and numbers, as the upstream does at the point of use', () => {
    expect(parseStartupEnv({ A: true, B: 3, C: 'x' }, silent)).toEqual({
      A: 'true',
      B: '3',
      C: 'x',
    });
  });

  it('drops a value that cannot become an environment string', () => {
    const warnings: string[] = [];
    expect(parseStartupEnv({ A: { nested: 1 } }, (m) => warnings.push(m))).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  it('reads a missing or non-object section as empty', () => {
    expect(parseStartupEnv(undefined, silent)).toEqual({});
    expect(parseStartupEnv(['A'], silent)).toEqual({});
  });
});
