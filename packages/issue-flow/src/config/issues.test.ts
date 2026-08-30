import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadIssuesConfig, PROJECT_CONFIG_FILENAME, setIssuesCliOverrides } from '../config.js';

describe('loadIssuesConfig', () => {
  let projectRoot: string;
  const warn = vi.fn();

  const DEFAULT_ISSUES_CONFIG = {
    defaultGenerateTarget: 'github',
    preferredProvider: 'github',
    conflictPolicy: 'ask',
    requireConfirmation: true,
  } as const;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-issues-config-'));
    warn.mockClear();
    setIssuesCliOverrides({});
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeConfigFile(content: unknown): Promise<void> {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(join(projectRoot, PROJECT_CONFIG_FILENAME), raw, 'utf-8');
  }

  it('returns the GitHub-only defaults when no source is present', async () => {
    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
    expect(warn).not.toHaveBeenCalled();
  });

  it('applies the issues key of .issue-flow.json over the defaults', async () => {
    await writeConfigFile({
      issues: { preferredProvider: 'local', conflictPolicy: 'prefer-local' },
    });

    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config.preferredProvider).toBe('local');
    expect(config.conflictPolicy).toBe('prefer-local');
    expect(config.defaultGenerateTarget).toBe('github'); // untouched key keeps its default
    expect(config.requireConfirmation).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets CLI flags override the config file', async () => {
    await writeConfigFile({
      issues: {
        preferredProvider: 'local',
        conflictPolicy: 'prefer-local',
        defaultGenerateTarget: 'local',
      },
    });

    const config = await loadIssuesConfig({
      cli: { preferredProvider: 'github', conflictPolicy: 'ask' },
      projectRoot,
      warn,
    });

    expect(config.preferredProvider).toBe('github');
    expect(config.conflictPolicy).toBe('ask');
    expect(config.defaultGenerateTarget).toBe('local'); // file still wins over the default
  });

  it('consumes overrides registered via setIssuesCliOverrides by default', async () => {
    setIssuesCliOverrides({ preferredProvider: 'local', conflictPolicy: 'prefer-local' });

    const config = await loadIssuesConfig({ projectRoot, warn });

    expect(config.preferredProvider).toBe('local');
    expect(config.conflictPolicy).toBe('prefer-local');
  });

  it('accepts every documented generate target', async () => {
    for (const target of ['github', 'local', 'both'] as const) {
      await writeConfigFile({ issues: { defaultGenerateTarget: target } });

      const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

      expect(config.defaultGenerateTarget).toBe(target);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to defaults with a warning when the file is invalid JSON', async () => {
    await writeConfigFile('{ not json');

    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(PROJECT_CONFIG_FILENAME));
  });

  it('falls back to defaults with a warning when the file root is not an object', async () => {
    await writeConfigFile('[1, 2, 3]');

    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected a JSON object'));
  });

  it('ignores an invalid issues key with a warning, without throwing', async () => {
    await writeConfigFile({ issues: { conflictPolicy: 'whatever' } });

    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"issues" key'));
  });

  it('accepts a file without the issues key silently', async () => {
    await writeConfigFile({ web: { enabled: true } });

    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to defaults with a warning when the merged result is invalid', async () => {
    const config = await loadIssuesConfig({
      cli: { preferredProvider: 'gitlab' as never },
      projectRoot,
      warn,
    });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Issue provider configuration'));
  });

  it('does not read the web key into the issues config', async () => {
    await writeConfigFile({ web: { enabled: true, port: 4000 }, issues: {} });

    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
  });
});
