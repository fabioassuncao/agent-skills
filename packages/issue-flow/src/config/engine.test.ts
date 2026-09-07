import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfig, resolvePaths } from '../config.js';
import { GLOBAL_ROOT_ENV, getIssuePaths, projectIdFromRemote } from '../storage/paths.js';
import { resetStorageResolutionCache } from '../storage/resolve.js';
import { getProjectRoot, getRemoteUrl, normalizeRemoteUrl } from '../utils/git.js';

// Only the git seams are faked, so project id derivation runs against the
// temporary trees these tests build.
vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return {
    ...actual,
    getRemoteUrl: vi.fn(async () => null),
    getProjectRoot: vi.fn(async () => process.cwd()),
  };
});

describe('resolvePaths', () => {
  const REMOTE = 'https://github.com/acme/widgets.git';

  let temps: string[] = [];
  let globalHome: string;
  let projectRoot: string;
  let previousHome: string | undefined;

  async function makeTemp(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
  }

  beforeEach(async () => {
    globalHome = await makeTemp('issue-flow-resolve-paths-home-');
    projectRoot = await makeTemp('issue-flow-resolve-paths-repo-');

    // resolvePaths() reaches resolveIssuePaths() without an options object, so
    // the { env } seam never gets there: the real process.env is what keeps this
    // test off the user's ~/.issue-flow.
    previousHome = process.env[GLOBAL_ROOT_ENV];
    process.env[GLOBAL_ROOT_ENV] = globalHome;
    resetStorageResolutionCache();

    vi.mocked(getProjectRoot).mockClear().mockResolvedValue(projectRoot);
    vi.mocked(getRemoteUrl).mockClear().mockResolvedValue(REMOTE);
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env[GLOBAL_ROOT_ENV];
    } else {
      process.env[GLOBAL_ROOT_ENV] = previousHome;
    }
    resetStorageResolutionCache();
    await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
    temps = [];
  });

  /** What the storage layer says this issue's paths are, computed independently. */
  function expectedIssuePaths(issueNumber: string) {
    return getIssuePaths(
      projectIdFromRemote(normalizeRemoteUrl(REMOTE), projectRoot),
      issueNumber,
      {
        env: { [GLOBAL_ROOT_ENV]: globalHome },
      },
    );
  }

  it('anchors every issue artifact in the global storage', async () => {
    const expected = expectedIssuePaths('42');

    const paths = await resolvePaths(createConfig({ issueNumber: '42' }));

    expect(paths).toEqual({
      // The asymmetric mapping: the engine's "PRD" is the task plan.
      prdFile: expected.tasksFile,
      progressFile: expected.progressFile,
      archiveDir: expected.archiveDir,
      lastBranchFile: expected.lastBranchFile,
      projectRoot,
    });
    expect(paths.prdFile.endsWith('tasks.json')).toBe(true);
    expect(paths.prdFile.startsWith(globalHome)).toBe(true);
  });

  it('no longer points at <projectRoot>/issues/', async () => {
    const paths = await resolvePaths(createConfig({ issueNumber: '42' }));

    for (const path of [
      paths.prdFile,
      paths.progressFile,
      paths.archiveDir,
      paths.lastBranchFile,
    ]) {
      expect(path.startsWith(join(projectRoot, 'issues'))).toBe(false);
    }
  });

  it('supports a non-numeric issue identifier', async () => {
    const expected = expectedIssuePaths('auth-refactor');

    const paths = await resolvePaths(createConfig({ issueNumber: 'auth-refactor' }));

    expect(paths.prdFile).toBe(expected.tasksFile);
  });

  it('resolves the same paths from a subdirectory of the repository', async () => {
    const fromRoot = await resolvePaths(createConfig({ issueNumber: '42' }));

    // getProjectRoot() already normalizes the cwd to the git toplevel, which is
    // what makes the result independent of where the command was invoked.
    resetStorageResolutionCache();
    const nested = join(projectRoot, 'packages', 'x');
    await mkdir(nested, { recursive: true });
    const fromSubdir = await resolvePaths(createConfig({ issueNumber: '42' }));

    expect(fromSubdir).toEqual(fromRoot);
  });

  it('leaves standalone mode anchored to the project root', async () => {
    const paths = await resolvePaths(createConfig({}));

    expect(paths).toEqual({
      prdFile: join(projectRoot, 'prd.json'),
      progressFile: join(projectRoot, 'progress.txt'),
      archiveDir: join(projectRoot, 'archive'),
      lastBranchFile: join(projectRoot, '.last-branch'),
      projectRoot,
    });
  });

  it('leaves standalone mode anchored to scriptDir when one is given', async () => {
    const scriptDir = await makeTemp('issue-flow-resolve-paths-script-');

    const paths = await resolvePaths(createConfig({}), scriptDir);

    expect(paths).toEqual({
      prdFile: join(scriptDir, 'prd.json'),
      progressFile: join(scriptDir, 'progress.txt'),
      archiveDir: join(scriptDir, 'archive'),
      lastBranchFile: join(scriptDir, '.last-branch'),
      projectRoot,
    });
  });

  it('resolves the project once per process: two calls share a single git lookup', async () => {
    await resolvePaths(createConfig({ issueNumber: '42' }));
    await resolvePaths(createConfig({ issueNumber: '43' }));

    expect(vi.mocked(getRemoteUrl)).toHaveBeenCalledTimes(1);
  });
});
