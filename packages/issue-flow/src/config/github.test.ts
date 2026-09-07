import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadGitHubConfig, parseLinkedReposEnv } from './github.js';

let projectRoot: string;
const warnings: string[] = [];
const warn = (message: string): void => {
  warnings.push(message);
};

async function writeProjectConfig(value: unknown): Promise<void> {
  await writeFile(join(projectRoot, '.issue-flow.json'), JSON.stringify(value), 'utf8');
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-github-config-'));
  warnings.length = 0;
});

describe('loadGitHubConfig', () => {
  it('defaults to no linked repository and the ten-second sync', async () => {
    await expect(loadGitHubConfig({ projectRoot, env: {}, warn })).resolves.toEqual({
      linkedRepos: [],
      syncIntervalMs: 10_000,
      autoRemoveOnMerge: false,
    });
  });

  it('reads the github key of .issue-flow.json', async () => {
    await writeProjectConfig({
      github: { linkedRepos: [{ repo: 'acme/api', alias: 'api' }], syncIntervalMs: 30_000 },
    });

    await expect(loadGitHubConfig({ projectRoot, env: {}, warn })).resolves.toEqual({
      linkedRepos: [{ repo: 'acme/api', alias: 'api' }],
      syncIntervalMs: 30_000,
      autoRemoveOnMerge: false,
    });
  });

  it('lets the environment override the file', async () => {
    await writeProjectConfig({ github: { linkedRepos: [{ repo: 'acme/api', alias: 'api' }] } });

    const config = await loadGitHubConfig({
      projectRoot,
      env: {
        ISSUE_FLOW_GITHUB_LINKED_REPOS: 'acme/web=web',
        ISSUE_FLOW_GITHUB_SYNC_INTERVAL_MS: '20000',
      },
      warn,
    });

    expect(config).toEqual({
      linkedRepos: [{ repo: 'acme/web', alias: 'web' }],
      syncIntervalMs: 20_000,
      autoRemoveOnMerge: false,
    });
  });

  it('lets the CLI layer win over the environment', async () => {
    const config = await loadGitHubConfig({
      projectRoot,
      env: { ISSUE_FLOW_GITHUB_SYNC_INTERVAL_MS: '20000' },
      cli: { syncIntervalMs: 5_000 },
      warn,
    });

    expect(config.syncIntervalMs).toBe(5_000);
  });

  it('degrades to the defaults with a warning when the key is malformed', async () => {
    await writeProjectConfig({ github: { linkedRepos: 'acme/api' } });

    await expect(loadGitHubConfig({ projectRoot, env: {}, warn })).resolves.toEqual({
      linkedRepos: [],
      syncIntervalMs: 10_000,
      autoRemoveOnMerge: false,
    });
    expect(warnings.join('\n')).toContain('Ignoring "github" key');
  });

  it('degrades to the defaults when a merged value is out of range', async () => {
    const config = await loadGitHubConfig({
      projectRoot,
      env: { ISSUE_FLOW_GITHUB_SYNC_INTERVAL_MS: '10' },
      warn,
    });

    expect(config.syncIntervalMs).toBe(10_000);
    expect(warnings.join('\n')).toContain('Invalid GitHub configuration');
  });
});

describe('parseLinkedReposEnv', () => {
  it('accepts owner/repo=alias pairs and trims them', () => {
    expect(parseLinkedReposEnv(' acme/api=api , acme/web=web ', warn)).toEqual([
      { repo: 'acme/api', alias: 'api' },
      { repo: 'acme/web', alias: 'web' },
    ]);
  });

  it('falls back to the repository name when no alias is given', () => {
    expect(parseLinkedReposEnv('acme/api', warn)).toEqual([{ repo: 'acme/api', alias: 'api' }]);
  });

  it('drops an entry with no owner/repo shape, with a warning', () => {
    expect(parseLinkedReposEnv('api,acme/web', warn)).toEqual([{ repo: 'acme/web', alias: 'web' }]);
    expect(warnings.join('\n')).toContain('Ignoring linked repository "api"');
  });
});
