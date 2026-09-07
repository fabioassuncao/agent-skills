import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return {
    ...actual,
    getRemoteUrl: vi.fn(async () => null),
    getProjectRoot: vi.fn(async () => process.cwd()),
  };
});

const { getProjectRoot, getRemoteUrl } = await import('../utils/git.js');
const { getPlanRepository } = await import('./db/repository.js');
const { GLOBAL_ROOT_ENV, getIssuePaths, projectIdFromRemote } = await import('./paths.js');
const { resetStorageResolutionCache, resolveIssuePaths, resolveProjectPaths } = await import(
  './resolve.js'
);

const mockGetRemoteUrl = vi.mocked(getRemoteUrl);
const mockGetProjectRoot = vi.mocked(getProjectRoot);
const REMOTE = 'https://github.com/acme/widgets.git';

let temps: string[] = [];
let globalHome: string;
let projectRoot: string;
let env: NodeJS.ProcessEnv;

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function expectedPaths(issueNumber: string | number) {
  return getIssuePaths(projectIdFromRemote('github.com/acme/widgets', projectRoot), issueNumber, {
    env,
  });
}

beforeEach(async () => {
  resetStorageResolutionCache();
  mockGetRemoteUrl.mockReset();
  mockGetRemoteUrl.mockResolvedValue(REMOTE);
  globalHome = await makeTemp('issue-flow-home-');
  projectRoot = await makeTemp('issue-flow-project-');
  env = { [GLOBAL_ROOT_ENV]: globalHome };
  mockGetProjectRoot.mockReset();
  mockGetProjectRoot.mockResolvedValue(projectRoot);
});

afterEach(async () => {
  resetStorageResolutionCache();
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
  temps = [];
});

describe('resolveIssuePaths', () => {
  it('resolves the current global store and registers its SQLite repository', async () => {
    const paths = await resolveIssuePaths(42, { env });

    expect(paths).toEqual(expectedPaths(42));
    expect(paths.tasksFile).toBe(join(paths.issueDir, 'tasks.json'));
    expect(getPlanRepository(paths.tasksFile)).toMatchObject({ issueId: '42' });
  });

  it('uses an existing workspace store for every consumer', async () => {
    await mkdir(join(projectRoot, '.issue-flow', 'issues'), { recursive: true });

    const paths = await resolveIssuePaths(42, { env });
    const project = await resolveProjectPaths({ env });

    expect(paths.issueDir).toBe(join(projectRoot, '.issue-flow', 'issues', '42'));
    expect(project).toMatchObject({
      storageMode: 'workspace',
      projectDir: join(projectRoot, '.issue-flow'),
      issuesDir: join(projectRoot, '.issue-flow', 'issues'),
    });
    const ignore = await readFile(join(projectRoot, '.issue-flow', '.gitignore'), 'utf8');
    expect(ignore).toContain('/issues/');
    expect(ignore).toContain('/issue-flow.db-*');
    expect(ignore).toContain('/metadata.json');
    expect(ignore).toContain('/backups/');
    await expect(stat(join(globalHome, 'issue-flow.db'))).rejects.toThrow();
  });

  it('does not copy global artifacts into a workspace store', async () => {
    const global = expectedPaths(42);
    await mkdir(global.issueDir, { recursive: true });
    await writeFile(global.tasksFile, 'global state', 'utf8');
    await mkdir(join(projectRoot, '.issue-flow', 'issues'), { recursive: true });

    const local = await resolveIssuePaths(42, { env });

    await expect(stat(local.tasksFile)).rejects.toThrow();
    await expect(readFile(global.tasksFile, 'utf8')).resolves.toBe('global state');
  });

  it('preserves workspace ignore entries while adding scoped protection', async () => {
    const localRoot = join(projectRoot, '.issue-flow');
    await mkdir(join(localRoot, 'issues'), { recursive: true });
    await writeFile(join(localRoot, '.gitignore'), '/custom-cache/\n', 'utf8');

    await resolveIssuePaths('local-id', { env });

    const ignore = await readFile(join(localRoot, '.gitignore'), 'utf8');
    expect(ignore).toContain('/custom-cache/');
    expect(ignore).toContain('/issues/');
  });

  it('accepts non-numeric identifiers without creating the issue directory', async () => {
    const paths = await resolveIssuePaths('auth-refactor', { env });

    expect(paths.issueDir).toBe(expectedPaths('auth-refactor').issueDir);
    await expect(stat(paths.issueDir)).rejects.toThrow();
  });

  it('caches project resolution across issue identifiers', async () => {
    await resolveIssuePaths(42, { env });
    await resolveIssuePaths(43, { env });

    expect(mockGetRemoteUrl).toHaveBeenCalledTimes(1);
  });

  it('resolves again after the cache is reset', async () => {
    await resolveIssuePaths(42, { env });
    resetStorageResolutionCache();
    await resolveIssuePaths(42, { env });

    expect(mockGetRemoteUrl).toHaveBeenCalledTimes(2);
  });

  it('retries after a failed project lookup instead of caching the rejection', async () => {
    mockGetRemoteUrl.mockRejectedValueOnce(new Error('git exploded'));

    await expect(resolveIssuePaths(42, { env })).rejects.toThrow('git exploded');
    await expect(resolveIssuePaths(42, { env })).resolves.toEqual(expectedPaths(42));
  });
});
