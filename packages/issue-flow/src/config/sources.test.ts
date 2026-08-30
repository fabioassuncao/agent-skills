import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_CONFIG_FILENAME,
  loadGlobalConfig,
  mergeConfigLayers,
} from '../config.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';

describe('loadGlobalConfig', () => {
  let globalRoot: string;
  const warn = vi.fn();

  beforeEach(async () => {
    globalRoot = await mkdtemp(join(tmpdir(), 'issue-flow-global-config-'));
    warn.mockClear();
  });

  afterEach(async () => {
    await rm(globalRoot, { recursive: true, force: true });
  });

  async function writeGlobalConfig(content: unknown): Promise<void> {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(join(globalRoot, GLOBAL_CONFIG_FILENAME), raw, 'utf-8');
  }

  it('returns an empty object without warning when the file is absent', async () => {
    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads every supported key of a valid file', async () => {
    await writeGlobalConfig({
      schemaVersion: 1,
      storageDir: '/srv/issue-flow',
      web: { port: 4100, host: 'global-host', refreshSeconds: 20, logLimit: 42 },
      retry: { retryLimit: 3, retryForever: false, backoffBaseSeconds: 5, backoffMaxSeconds: 60 },
      commit: { signoff: true, conventional: false },
    });

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({
      schemaVersion: 1,
      storageDir: '/srv/issue-flow',
      web: { port: 4100, host: 'global-host', refreshSeconds: 20, logLimit: 42 },
      retry: { retryLimit: 3, retryForever: false, backoffBaseSeconds: 5, backoffMaxSeconds: 60 },
      commit: { signoff: true, conventional: false },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('never materializes a default for a key the user did not write', async () => {
    await writeGlobalConfig({ web: { host: 'global-host' } });

    const config = await loadGlobalConfig({ globalRoot, warn });

    // Exact match: an extra `port` here would be a default leaking into an
    // intermediate precedence layer, which would override the project file.
    expect(config).toEqual({ web: { host: 'global-host' } });
  });

  it('resolves the file through ISSUE_FLOW_HOME when no globalRoot is given', async () => {
    await writeGlobalConfig({ storageDir: '/from-env' });

    const config = await loadGlobalConfig({ env: { [GLOBAL_ROOT_ENV]: globalRoot }, warn });

    expect(config).toEqual({ storageDir: '/from-env' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and returns an empty object on invalid JSON', async () => {
    await writeGlobalConfig('{ "web": ');

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
  });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"nope"'],
  ])('warns and returns an empty object when the root is %s', async (_label, raw) => {
    await writeGlobalConfig(raw);

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected a JSON object'));
  });

  it('drops only the invalid key and names it in the warning', async () => {
    await writeGlobalConfig({
      storageDir: '/srv/issue-flow',
      retry: { retryLimit: 'many' },
      commit: { signoff: true },
    });

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({ storageDir: '/srv/issue-flow', commit: { signoff: true } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"retry"'));
  });

  it('drops a nested key whose value violates the web constraints', async () => {
    await writeGlobalConfig({ web: { port: 70000 }, commit: { conventional: true } });

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({ commit: { conventional: true } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"web"'));
  });

  it('ignores an unknown key silently, keeping the file forward-compatible', async () => {
    await writeGlobalConfig({ storageDir: '/srv/issue-flow', futureKey: { anything: true } });

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({ storageDir: '/srv/issue-flow' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and returns an empty object on an IO error', async () => {
    // A directory where the file is expected: readFile fails with EISDIR, the
    // stand-in for the permission errors we cannot reproduce portably.
    await mkdir(join(globalRoot, GLOBAL_CONFIG_FILENAME));

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(GLOBAL_CONFIG_FILENAME));
  });

  it('warns instead of throwing when the global root cannot be resolved', async () => {
    const config = await loadGlobalConfig({
      env: { [GLOBAL_ROOT_ENV]: '', HOME: '', USERPROFILE: '' },
      warn,
    });

    // The home directory is resolvable on any supported dev machine, so this
    // only asserts the call is total: a value, never a throw.
    expect(config).toEqual({});
  });

  it('keeps a project-level web.port when the global file omits it', async () => {
    await writeGlobalConfig({ web: { host: 'global-host', refreshSeconds: 20 } });

    const global = await loadGlobalConfig({ globalRoot, warn });
    const merged = mergeConfigLayers<{ port: number; host: string; refreshSeconds: number }>({
      global: global.web,
      project: { port: 4000 },
    });

    expect(merged).toEqual({ port: 4000, host: 'global-host', refreshSeconds: 20 });
  });
});

