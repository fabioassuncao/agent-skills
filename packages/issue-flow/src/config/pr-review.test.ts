import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPrReviewConfig, PROJECT_CONFIG_FILENAME } from '../config.js';

describe('loadPrReviewConfig', () => {
  let projectRoot: string;
  const warn = vi.fn();

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-pr-review-config-'));
    warn.mockClear();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeConfigFile(content: unknown): Promise<void> {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(join(projectRoot, PROJECT_CONFIG_FILENAME), raw, 'utf-8');
  }

  it('returns the local publisher when the key is absent', async () => {
    await writeConfigFile({ web: { enabled: true } });

    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the local publisher when no config file exists at all', async () => {
    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts the documented publisher value', async () => {
    await writeConfigFile({ prReview: { publisher: 'local' } });

    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts the github publisher, which composes with the local one', async () => {
    await writeConfigFile({ prReview: { publisher: 'github' } });

    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'github' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades to the default with a warning on an unknown publisher', async () => {
    await writeConfigFile({ prReview: { publisher: 'gitlab' } });

    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"prReview" key'));
  });

  it('degrades to the default with a warning when the key is not an object', async () => {
    await writeConfigFile({ prReview: 'local' });

    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"prReview" key'));
  });

  it('degrades to the default with a warning when the file is invalid JSON', async () => {
    await writeConfigFile('{ not json');

    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(PROJECT_CONFIG_FILENAME));
  });

  it('lets the environment override the config file', async () => {
    await writeConfigFile({ prReview: { publisher: 'local' } });

    const config = await loadPrReviewConfig({
      cli: {},
      env: { ISSUE_FLOW_PR_REVIEW_PUBLISHER: 'local' },
      projectRoot,
      warn,
    });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades to the default with a warning on an invalid environment value', async () => {
    const config = await loadPrReviewConfig({
      cli: {},
      env: { ISSUE_FLOW_PR_REVIEW_PUBLISHER: 'gitlab' },
      projectRoot,
      warn,
    });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PR review configuration'));
  });

  it('degrades to the default with a warning on an invalid CLI override', async () => {
    const config = await loadPrReviewConfig({
      cli: { publisher: 'gitlab' as never },
      env: {},
      projectRoot,
      warn,
    });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PR review configuration'));
  });

  it('does not read the web or issues keys into the pr review config', async () => {
    await writeConfigFile({ web: { enabled: true }, issues: { preferredProvider: 'local' } });

    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).not.toHaveBeenCalled();
  });
});
