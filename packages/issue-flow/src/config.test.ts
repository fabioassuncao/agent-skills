import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWebConfig, setWebCliOverrides, WEB_CONFIG_FILENAME } from './config.js';

describe('loadWebConfig', () => {
  let projectRoot: string;
  const warn = vi.fn();

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-web-config-'));
    warn.mockClear();
    setWebCliOverrides({});
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeConfigFile(content: unknown): Promise<void> {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(join(projectRoot, WEB_CONFIG_FILENAME), raw, 'utf-8');
  }

  it('returns the documented defaults when no source is present', async () => {
    const config = await loadWebConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({
      enabled: false,
      port: 3737,
      host: '0.0.0.0',
      refreshSeconds: 5,
      logLimit: 200,
      includeLogs: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('applies the web key of .issue-flow.json over the defaults', async () => {
    await writeConfigFile({
      web: { enabled: true, port: 4000, host: '0.0.0.0', refreshSeconds: 10, includeLogs: false },
    });

    const config = await loadWebConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config.enabled).toBe(true);
    expect(config.port).toBe(4000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.refreshSeconds).toBe(10);
    expect(config.includeLogs).toBe(false);
    expect(config.logLimit).toBe(200); // untouched key keeps its default
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets environment variables override the config file', async () => {
    await writeConfigFile({ web: { enabled: false, port: 4000, host: 'file-host' } });

    const config = await loadWebConfig({
      cli: {},
      env: {
        ISSUE_FLOW_WEB: '1',
        ISSUE_FLOW_WEB_PORT: '5001',
        ISSUE_FLOW_WEB_HOST: 'env-host',
        ISSUE_FLOW_WEB_REFRESH: '30',
        ISSUE_FLOW_WEB_LOG_LIMIT: '50',
      },
      projectRoot,
      warn,
    });

    expect(config.enabled).toBe(true);
    expect(config.port).toBe(5001);
    expect(config.host).toBe('env-host');
    expect(config.refreshSeconds).toBe(30);
    expect(config.logLimit).toBe(50);
  });

  it('lets CLI flags override environment variables and the file', async () => {
    await writeConfigFile({ web: { port: 4000 } });

    const config = await loadWebConfig({
      cli: { enabled: true, port: 6001, host: 'cli-host', includeLogs: false },
      env: { ISSUE_FLOW_WEB: '0', ISSUE_FLOW_WEB_PORT: '5001', ISSUE_FLOW_WEB_HOST: 'env-host' },
      projectRoot,
      warn,
    });

    expect(config.enabled).toBe(true);
    expect(config.port).toBe(6001);
    expect(config.host).toBe('cli-host');
    expect(config.includeLogs).toBe(false);
  });

  it('consumes overrides registered via setWebCliOverrides by default', async () => {
    setWebCliOverrides({ enabled: true, refreshSeconds: 3 });

    const config = await loadWebConfig({ env: {}, projectRoot, warn });

    expect(config.enabled).toBe(true);
    expect(config.refreshSeconds).toBe(3);
  });

  it('parses truthy and falsy values of ISSUE_FLOW_WEB', async () => {
    for (const value of ['1', 'true', 'yes', 'on', 'anything']) {
      const config = await loadWebConfig({
        cli: {},
        env: { ISSUE_FLOW_WEB: value },
        projectRoot,
        warn,
      });
      expect(config.enabled).toBe(true);
    }
    for (const value of ['', '0', 'false', 'no', 'off', 'FALSE']) {
      const config = await loadWebConfig({
        cli: {},
        env: { ISSUE_FLOW_WEB: value },
        projectRoot,
        warn,
      });
      expect(config.enabled).toBe(false);
    }
  });

  it('ignores a non-numeric env var with a warning, keeping the other sources', async () => {
    await writeConfigFile({ web: { port: 4000 } });

    const config = await loadWebConfig({
      cli: {},
      env: { ISSUE_FLOW_WEB_PORT: 'abc' },
      projectRoot,
      warn,
    });

    expect(config.port).toBe(4000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ISSUE_FLOW_WEB_PORT'));
  });

  it('falls back to defaults with a warning when the file is invalid JSON', async () => {
    await writeConfigFile('{ not json');

    const config = await loadWebConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config.enabled).toBe(false);
    expect(config.port).toBe(3737);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(WEB_CONFIG_FILENAME));
  });

  it('ignores an invalid web key with a warning, without failing', async () => {
    await writeConfigFile({ web: { port: 'not-a-number' } });

    const config = await loadWebConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config.port).toBe(3737);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(WEB_CONFIG_FILENAME));
  });

  it('accepts a file without the web key silently', async () => {
    await writeConfigFile({ otherTool: { setting: true } });

    const config = await loadWebConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config.enabled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to defaults with a warning when the merged result is invalid', async () => {
    const config = await loadWebConfig({ cli: { port: 0 }, env: {}, projectRoot, warn });

    expect(config.port).toBe(3737);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('web monitoring configuration'));
  });
});
