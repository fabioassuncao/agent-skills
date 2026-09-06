import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRunConfig, PROJECT_CONFIG_FILENAME } from '../config.js';

/**
 * The project-level half of §17's auto-close: a repository can opt in once
 * instead of typing `--auto-close` on every run. It defaults to off, because
 * `run` has always left its sessions in place.
 */
describe('loadRunConfig', () => {
  let projectRoot: string;
  const warn = vi.fn();

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-run-config-'));
    warn.mockClear();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeConfigFile(content: unknown): Promise<void> {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(join(projectRoot, PROJECT_CONFIG_FILENAME), raw, 'utf-8');
  }

  it('leaves auto-close off when nothing configures it', async () => {
    expect(await loadRunConfig({ cli: {}, env: {}, projectRoot, warn })).toEqual({
      autoClose: false,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads the opt-in from the project file', async () => {
    await writeConfigFile({ run: { autoClose: true } });
    expect(await loadRunConfig({ cli: {}, env: {}, projectRoot, warn })).toEqual({
      autoClose: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets the environment override the file', async () => {
    await writeConfigFile({ run: { autoClose: true } });
    expect(
      await loadRunConfig({
        cli: {},
        env: { ISSUE_FLOW_RUN_AUTO_CLOSE: '0' },
        projectRoot,
        warn,
      }),
    ).toEqual({ autoClose: false });
  });

  it('lets the flag override both', async () => {
    await writeConfigFile({ run: { autoClose: false } });
    expect(
      await loadRunConfig({
        cli: { autoClose: true },
        env: { ISSUE_FLOW_RUN_AUTO_CLOSE: '0' },
        projectRoot,
        warn,
      }),
    ).toEqual({ autoClose: true });
  });

  it('warns and falls back to the default on a malformed value', async () => {
    await writeConfigFile({ run: { autoClose: 'sometimes' } });
    expect(await loadRunConfig({ cli: {}, env: {}, projectRoot, warn })).toEqual({
      autoClose: false,
    });
    expect(warn).toHaveBeenCalled();
  });

  it('warns rather than throwing on an unusable environment value', async () => {
    expect(
      await loadRunConfig({
        cli: {},
        env: { ISSUE_FLOW_RUN_AUTO_CLOSE: 'maybe' },
        projectRoot,
        warn,
      }),
    ).toEqual({ autoClose: false });
    expect(warn).toHaveBeenCalled();
  });
});
