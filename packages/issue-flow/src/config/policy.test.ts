import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPolicyConfig, PROJECT_CONFIG_FILENAME, setPolicyCliOverrides } from '../config.js';

describe('loadPolicyConfig', () => {
  let projectRoot: string;
  const warn = vi.fn();

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-policy-config-'));
    warn.mockClear();
    setPolicyCliOverrides({});
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeConfigFile(content: unknown): Promise<void> {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(join(projectRoot, PROJECT_CONFIG_FILENAME), raw, 'utf-8');
  }

  it('defaults to discovery on and nothing declared', async () => {
    const config = await loadPolicyConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({
      enabled: true,
      contextBudget: 1500,
      discovery: {
        issueTemplates: true,
        pullRequestTemplate: true,
        docs: true,
        codeowners: true,
        labels: true,
        issueTypes: true,
      },
      issues: {},
      pullRequests: {},
      git: {},
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves an undeclared value absent rather than materializing it as null', async () => {
    const config = await loadPolicyConfig({ cli: {}, env: {}, projectRoot, warn });

    // The distinction the whole precedence rests on: an absent declaration must
    // not shadow what the discovery layer below found.
    expect('baseBranch' in config.pullRequests).toBe(false);
  });

  it('reads the declarations of the "policy" key', async () => {
    await writeConfigFile({
      policy: {
        enabled: true,
        pullRequests: { baseBranch: 'develop' },
        git: { branchConvention: 'feat/{slug}' },
        discovery: { labels: false },
      },
    });

    const config = await loadPolicyConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config.pullRequests.baseBranch).toBe('develop');
    expect(config.git.branchConvention).toBe('feat/{slug}');
    expect(config.discovery.labels).toBe(false);
    // A single toggle turned off must not turn the others off with it.
    expect(config.discovery.docs).toBe(true);
  });

  it('drops a null declaration instead of rejecting the whole key', async () => {
    await writeConfigFile({ policy: { pullRequests: { baseBranch: null } } });

    const config = await loadPolicyConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config.pullRequests).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('applies the documented precedence: CLI > env > file', async () => {
    await writeConfigFile({ policy: { pullRequests: { baseBranch: 'from-file' } } });

    expect(
      (
        await loadPolicyConfig({
          cli: {},
          env: { ISSUE_FLOW_POLICY_BASE_BRANCH: 'from-env' },
          projectRoot,
          warn,
        })
      ).pullRequests.baseBranch,
    ).toBe('from-env');

    expect(
      (
        await loadPolicyConfig({
          cli: { pullRequests: { baseBranch: 'from-cli' } },
          env: { ISSUE_FLOW_POLICY_BASE_BRANCH: 'from-env' },
          projectRoot,
          warn,
        })
      ).pullRequests.baseBranch,
    ).toBe('from-cli');
  });

  it('reads every ISSUE_FLOW_POLICY_* variable', async () => {
    const config = await loadPolicyConfig({
      cli: {},
      env: {
        ISSUE_FLOW_POLICY: 'false',
        ISSUE_FLOW_POLICY_BASE_BRANCH: 'develop',
        ISSUE_FLOW_POLICY_BRANCH_CONVENTION: 'feat/{slug}',
        ISSUE_FLOW_POLICY_COMMIT_CONVENTION: 'conventional',
        ISSUE_FLOW_POLICY_PR_TITLE_CONVENTION: 'type(scope): subject',
        ISSUE_FLOW_POLICY_ISSUE_TITLE_CONVENTION: '[Area] Title',
      },
      projectRoot,
      warn,
    });

    expect(config).toMatchObject({
      enabled: false,
      pullRequests: { baseBranch: 'develop', titleConvention: 'type(scope): subject' },
      git: { branchConvention: 'feat/{slug}', commitConvention: 'conventional' },
      issues: { titleConvention: '[Area] Title' },
    });
  });

  it('honours policy.enabled: false', async () => {
    await writeConfigFile({ policy: { enabled: false } });

    expect((await loadPolicyConfig({ cli: {}, env: {}, projectRoot, warn })).enabled).toBe(false);
  });

  it('warns and degrades to the defaults on an invalid "policy" key', async () => {
    await writeConfigFile({ policy: { discovery: { labels: 'no' } } });

    const config = await loadPolicyConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config.discovery.labels).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"policy" key'));
  });

  it('warns once on invalid JSON, like every other key of the file', async () => {
    await writeConfigFile('{ nope');

    const config = await loadPolicyConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config.enabled).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
  });

  it('reads the CLI overrides set by the preAction hook', async () => {
    setPolicyCliOverrides({ enabled: false });

    expect((await loadPolicyConfig({ env: {}, projectRoot, warn })).enabled).toBe(false);
  });
});
