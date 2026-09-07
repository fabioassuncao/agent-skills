import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { persistGitHubAutoRemoveOnMerge } from './github.js';
import { linearApiKey, loadLinearConfig, persistLinearAutoCreate } from './linear.js';

describe('Linear project configuration', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'issue-flow-linear-config-'));
    roots.push(value);
    return value;
  }

  it('loads non-secret behavior with environment precedence', async () => {
    const projectRoot = await root();
    await writeFile(
      join(projectRoot, '.issue-flow.json'),
      JSON.stringify({
        linear: { enabled: false, autoCreateWorktrees: false, watchTeams: ['WEB'] },
      }),
    );

    await expect(
      loadLinearConfig({
        projectRoot,
        env: {
          ISSUE_FLOW_LINEAR_ENABLED: 'yes',
          ISSUE_FLOW_LINEAR_AUTO_CREATE: '1',
          ISSUE_FLOW_LINEAR_WATCH_TEAMS: 'eng, web, ENG',
        },
      }),
    ).resolves.toEqual({ enabled: true, autoCreateWorktrees: true, watchTeams: ['ENG', 'WEB'] });
  });

  it('persists toggles without writing the credential or erasing other settings', async () => {
    const projectRoot = await root();
    await writeFile(
      join(projectRoot, '.issue-flow.json'),
      `${JSON.stringify({ web: { port: 7777 }, linear: { enabled: true } })}\n`,
    );

    await Promise.all([
      persistLinearAutoCreate(projectRoot, true),
      persistGitHubAutoRemoveOnMerge(projectRoot, true),
    ]);
    const raw = await readFile(join(projectRoot, '.issue-flow.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({
      web: { port: 7777 },
      linear: { enabled: true, autoCreateWorktrees: true },
      github: { autoRemoveOnMerge: true },
    });
    expect(raw).not.toContain('LINEAR_API_KEY');
  });

  it('reads the credential exclusively from the supplied environment', () => {
    expect(linearApiKey({ LINEAR_API_KEY: ' token ' })).toBe('token');
    expect(linearApiKey({})).toBeNull();
  });
});
