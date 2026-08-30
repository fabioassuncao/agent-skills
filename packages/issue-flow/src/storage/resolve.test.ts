import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the git seams are faked: everything below them (project id derivation,
// mode resolution, migration) runs for real against a temporary tree, which is
// the whole point of these tests.
vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return {
    ...actual,
    getRemoteUrl: vi.fn(async () => null),
    getProjectRoot: vi.fn(async () => process.cwd()),
  };
});

// The migration notice is user-facing output: capture it instead of printing it.
vi.mock('../ui/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/logger.js')>();
  return { ...actual, printInfo: vi.fn() };
});

const { printInfo } = await import('../ui/logger.js');
const { getProjectRoot, getRemoteUrl } = await import('../utils/git.js');
const { GLOBAL_ROOT_ENV, getIssuePaths, projectIdFromRemote } = await import('./paths.js');
const { LEGACY_ISSUES_DIR_NAME } = await import('./compat.js');
const { resetStorageResolutionCache, resolveIssuePaths } = await import('./resolve.js');
const { getPlanRepository } = await import('./db/repository.js');

const mockGetRemoteUrl = vi.mocked(getRemoteUrl);
const mockGetProjectRoot = vi.mocked(getProjectRoot);
const mockPrintInfo = vi.mocked(printInfo);

/** Everything the migration notice printed, as a single string. */
function printedOutput(): string {
  return mockPrintInfo.mock.calls.map(([line]) => line).join('\n');
}

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

/** Create `<projectRoot>/issues/<relativePath>` with the given content. */
async function writeLegacy(relativePath: string, content: string): Promise<void> {
  const file = join(projectRoot, LEGACY_ISSUES_DIR_NAME, relativePath);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content, 'utf-8');
}

/** Paths the resolver is expected to produce, computed independently. */
function expectedPaths(issueNumber: string | number) {
  return getIssuePaths(projectIdFromRemote('github.com/acme/widgets', projectRoot), issueNumber, {
    env,
  });
}

beforeEach(async () => {
  resetStorageResolutionCache();

  mockPrintInfo.mockReset();
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
  it('resolves under the global storage for a project with no legacy tree', async () => {
    const paths = await resolveIssuePaths(42, { env });

    expect(paths).toEqual(expectedPaths(42));
    expect(paths.issueDir.startsWith(globalHome)).toBe(true);
    expect(paths.tasksFile).toBe(join(paths.issueDir, 'tasks.json'));
  });

  it('accepts a non-numeric identifier', async () => {
    const paths = await resolveIssuePaths('auth-refactor', { env });

    expect(paths.issueDir).toBe(expectedPaths('auth-refactor').issueDir);
  });

  it('takes the project root from getProjectRoot when none is given', async () => {
    const paths = await resolveIssuePaths(42, { env });

    expect(mockGetProjectRoot).toHaveBeenCalled();
    expect(paths.issueDir).toBe(expectedPaths(42).issueDir);
  });

  it('migrates the legacy tree when only it exists', async () => {
    await writeLegacy(join('42', 'prd.md'), '# legacy prd');
    await writeLegacy(join('42', 'archive', 'iter-1.json'), '{}');

    const paths = await resolveIssuePaths(42, { env });

    await expect(readFile(paths.prdFile, 'utf-8')).resolves.toBe('# legacy prd');
    await expect(readFile(join(paths.archiveDir, 'iter-1.json'), 'utf-8')).resolves.toBe('{}');

    // The legacy directory is read-only: the source must survive untouched.
    await expect(
      readFile(join(projectRoot, LEGACY_ISSUES_DIR_NAME, '42', 'prd.md'), 'utf-8'),
    ).resolves.toBe('# legacy prd');
  });

  it('migrates a single issue that is still only in the legacy tree', async () => {
    // The project directory already exists, so the mode is 'global' and the
    // project-level migration would never fire on its own.
    await resolveIssuePaths(1, { env });
    resetStorageResolutionCache();

    await writeLegacy(join('99', 'tasks.json'), '{"issueNumber":99}');

    const paths = await resolveIssuePaths(99, { env });

    await expect(readFile(paths.tasksFile, 'utf-8')).resolves.toBe('{"issueNumber":99}');
  });

  it('does not migrate an issue whose global directory already exists', async () => {
    const paths = await resolveIssuePaths(42, { env });
    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(paths.tasksFile, 'global wins', 'utf-8');

    await writeLegacy(join('42', 'tasks.json'), 'legacy loses');
    resetStorageResolutionCache();

    await resolveIssuePaths(42, { env });

    await expect(readFile(paths.tasksFile, 'utf-8')).resolves.toBe('global wins');
  });

  it('caches the resolution: two calls shell out to git only once', async () => {
    await resolveIssuePaths(42, { env });
    await resolveIssuePaths(43, { env });

    expect(mockGetRemoteUrl).toHaveBeenCalledTimes(1);
  });

  it('shares a single resolution between concurrent calls', async () => {
    await Promise.all([resolveIssuePaths(42, { env }), resolveIssuePaths(43, { env })]);

    expect(mockGetRemoteUrl).toHaveBeenCalledTimes(1);
  });

  it('resolves again after resetStorageResolutionCache', async () => {
    await resolveIssuePaths(42, { env });
    resetStorageResolutionCache();
    await resolveIssuePaths(42, { env });

    expect(mockGetRemoteUrl).toHaveBeenCalledTimes(2);
  });

  it('propagates the original migration failure instead of swallowing it', async () => {
    await writeLegacy(join('42', 'prd.md'), '# legacy prd');

    // A file where the migration expects to create the issues directory: the
    // copy cannot proceed and must say which issue and file broke.
    const globalIssues = join(expectedPaths(42).issueDir, '..');
    await mkdir(join(globalIssues, '..'), { recursive: true });
    await writeFile(globalIssues, 'not a directory', 'utf-8');

    await expect(resolveIssuePaths(42, { env })).rejects.toThrow(/Failed to migrate/);
  });

  it('retries the resolution after a failure instead of caching the rejection', async () => {
    mockGetRemoteUrl.mockRejectedValueOnce(new Error('git exploded'));

    await expect(resolveIssuePaths(42, { env })).rejects.toThrow('git exploded');

    const paths = await resolveIssuePaths(42, { env });
    expect(paths.issueDir).toBe(expectedPaths(42).issueDir);
  });

  it('does not create the issue directory — writers still own their mkdir', async () => {
    const paths = await resolveIssuePaths(42, { env });

    await expect(stat(paths.issueDir)).rejects.toThrow();
  });

  it('keeps JSON active when the SQLite import fails', async () => {
    const paths = expectedPaths(42);
    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(paths.tasksFile, '{ invalid json', 'utf-8');

    const resolved = await resolveIssuePaths(42, { env });

    expect(resolved).toEqual(paths);
    expect(getPlanRepository(paths.tasksFile)).toBeUndefined();
    await expect(readFile(paths.tasksFile, 'utf-8')).resolves.toBe('{ invalid json');
  });

  it('honours storage.driver=json without creating a SQLite projection', async () => {
    await writeFile(
      join(projectRoot, '.issue-flow.json'),
      JSON.stringify({ storage: { driver: 'json' } }),
      'utf-8',
    );

    const paths = await resolveIssuePaths(42, { env });

    expect(getPlanRepository(paths.tasksFile)).toBeUndefined();
  });
});

describe('migration notice', () => {
  it('reports source, destination and file count once files were copied', async () => {
    await writeLegacy(join('42', 'prd.md'), '# legacy prd');
    await writeLegacy(join('42', 'tasks.json'), '{}');

    const paths = await resolveIssuePaths(42, { env });
    const output = printedOutput();

    expect(mockPrintInfo).toHaveBeenCalled();
    expect(output).toContain(join(projectRoot, LEGACY_ISSUES_DIR_NAME));
    // Destination is the global issues directory, i.e. the parent of issueDir.
    expect(output).toContain(join(paths.issueDir, '..'));
    expect(output).toContain('2 files');
  });

  it('states that the legacy directory was neither modified nor removed', async () => {
    await writeLegacy(join('42', 'prd.md'), '# legacy prd');

    await resolveIssuePaths(42, { env });

    expect(printedOutput()).toMatch(/not modified or removed/);
    // A single file must not be announced as "1 files".
    expect(printedOutput()).toContain('1 file ');
  });

  it('stays silent on the second invocation, when nothing is left to copy', async () => {
    await writeLegacy(join('42', 'prd.md'), '# legacy prd');

    await resolveIssuePaths(42, { env });
    expect(mockPrintInfo).toHaveBeenCalled();

    // A fresh process: same tree, empty cache.
    mockPrintInfo.mockClear();
    resetStorageResolutionCache();

    await resolveIssuePaths(42, { env });

    expect(mockPrintInfo).not.toHaveBeenCalled();
  });

  it('stays silent for a project that never had a legacy tree', async () => {
    await resolveIssuePaths(42, { env });

    expect(mockPrintInfo).not.toHaveBeenCalled();
  });

  it('announces a migration triggered by the per-issue fallback', async () => {
    await resolveIssuePaths(1, { env });
    resetStorageResolutionCache();
    expect(mockPrintInfo).not.toHaveBeenCalled();

    await writeLegacy(join('99', 'tasks.json'), '{"issueNumber":99}');
    await resolveIssuePaths(99, { env });

    expect(printedOutput()).toContain('1 file ');
  });
});
