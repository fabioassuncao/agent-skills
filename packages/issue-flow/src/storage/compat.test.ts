import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only getRemoteUrl is faked: normalizeRemoteUrl stays real, so the project id
// and the metadata remote go through the same normalization callers will get.
vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return { ...actual, getRemoteUrl: vi.fn(async () => null) };
});

const { getRemoteUrl } = await import('../utils/git.js');
const { GLOBAL_ROOT_ENV } = await import('./paths.js');
const { LEGACY_ISSUES_DIR_NAME, METADATA_FILENAME, migrateLegacyStorage, resolveStorageMode } =
  await import('./compat.js');
const { projectMetadataSchema, STORAGE_SCHEMA_VERSION } = await import('./schemas.js');

const mockGetRemoteUrl = vi.mocked(getRemoteUrl);

/** Directories created by the current test, removed in afterEach. */
let temps: string[] = [];
let globalHome: string;
let projectRoot: string;
/** Env passed to every helper so the real $HOME is never touched. */
let env: NodeJS.ProcessEnv;

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Create `<projectRoot>/issues/<relativePath>` with the given content. */
async function writeLegacy(relativePath: string, content: string): Promise<string> {
  const file = join(projectRoot, LEGACY_ISSUES_DIR_NAME, relativePath);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content, 'utf-8');
  return file;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  mockGetRemoteUrl.mockReset();
  mockGetRemoteUrl.mockResolvedValue('https://github.com/acme/widgets.git');

  globalHome = await makeTemp('issue-flow-home-');
  projectRoot = await makeTemp('issue-flow-project-');
  env = { [GLOBAL_ROOT_ENV]: globalHome };
});

afterEach(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
  temps = [];
});

describe('resolveStorageMode', () => {
  it('reports global when neither layout exists', async () => {
    const status = await resolveStorageMode(projectRoot, { env });

    expect(status.mode).toBe('global');
    expect(status.globalExists).toBe(false);
    expect(status.legacyExists).toBe(false);
    expect(status.globalDir).toBe(join(globalHome, 'projects', status.projectId));
    expect(status.legacyDir).toBe(join(projectRoot, LEGACY_ISSUES_DIR_NAME));
  });

  it('reports needs-migration when only the legacy directory exists', async () => {
    await writeLegacy(join('42', 'tasks.json'), '{}');

    const status = await resolveStorageMode(projectRoot, { env });

    expect(status.mode).toBe('needs-migration');
    expect(status.legacyExists).toBe(true);
    expect(status.globalExists).toBe(false);
  });

  it('reports global when only the global directory exists', async () => {
    const { projectId } = await resolveStorageMode(projectRoot, { env });
    await mkdir(join(globalHome, 'projects', projectId), { recursive: true });

    const status = await resolveStorageMode(projectRoot, { env });

    expect(status.mode).toBe('global');
    expect(status.globalExists).toBe(true);
    expect(status.legacyExists).toBe(false);
  });

  it('reports global when both exist, leaving the legacy directory alone', async () => {
    const legacyFile = await writeLegacy(join('42', 'tasks.json'), '{"legacy":true}');
    const { projectId } = await resolveStorageMode(projectRoot, { env });
    await mkdir(join(globalHome, 'projects', projectId), { recursive: true });

    const status = await resolveStorageMode(projectRoot, { env });

    expect(status.mode).toBe('global');
    expect(status.globalExists).toBe(true);
    expect(status.legacyExists).toBe(true);
    expect(await readFile(legacyFile, 'utf-8')).toBe('{"legacy":true}');
  });

  it('has no side effects: it never creates a directory', async () => {
    await resolveStorageMode(projectRoot, { env });

    expect(await readdir(globalHome)).toEqual([]);
    expect(await readdir(projectRoot)).toEqual([]);
  });
});

describe('migrateLegacyStorage', () => {
  it('copies the whole tree, including subdirectories and dotfiles', async () => {
    await writeLegacy(join('42', 'tasks.json'), '{"issue":42}');
    await writeLegacy(join('42', 'progress.txt'), 'progress');
    await writeLegacy(join('42', '.last-branch'), 'issue/42-thing');
    await writeLegacy(join('42', 'archive', 'progress-1.txt'), 'archived');
    await writeLegacy(join('42', 'pr-review', 'review.md'), '# review');
    await writeLegacy(join('auth-refactor', 'prd.md'), '# prd');

    const result = await migrateLegacyStorage(projectRoot, { env });
    const issuesDir = join(result.globalDir, 'issues');

    expect(result.previousMode).toBe('needs-migration');
    expect(await readFile(join(issuesDir, '42', 'tasks.json'), 'utf-8')).toBe('{"issue":42}');
    expect(await readFile(join(issuesDir, '42', 'progress.txt'), 'utf-8')).toBe('progress');
    expect(await readFile(join(issuesDir, '42', 'archive', 'progress-1.txt'), 'utf-8')).toBe(
      'archived',
    );
    expect(await readFile(join(issuesDir, '42', 'pr-review', 'review.md'), 'utf-8')).toBe(
      '# review',
    );
    expect(await readFile(join(issuesDir, 'auth-refactor', 'prd.md'), 'utf-8')).toBe('# prd');
    expect(result.copied).toHaveLength(6);
    expect(result.skipped).toEqual([]);
  });

  it('copies the .last-branch dotfile', async () => {
    await writeLegacy(join('42', '.last-branch'), 'issue/42-thing');

    const result = await migrateLegacyStorage(projectRoot, { env });

    const copied = join(result.globalDir, 'issues', '42', '.last-branch');
    expect(await readFile(copied, 'utf-8')).toBe('issue/42-thing');
    expect(result.copied).toContain(join('42', '.last-branch'));
  });

  it('never removes or modifies the legacy directory', async () => {
    await writeLegacy(join('42', 'tasks.json'), '{"issue":42}');
    await writeLegacy(join('42', '.last-branch'), 'issue/42-thing');

    await migrateLegacyStorage(projectRoot, { env });

    const legacyDir = join(projectRoot, LEGACY_ISSUES_DIR_NAME);
    expect(await readdir(join(legacyDir, '42'))).toEqual(
      expect.arrayContaining(['.last-branch', 'tasks.json']),
    );
    expect(await readFile(join(legacyDir, '42', 'tasks.json'), 'utf-8')).toBe('{"issue":42}');
    expect(await readFile(join(legacyDir, '42', '.last-branch'), 'utf-8')).toBe('issue/42-thing');
  });

  it('is idempotent: a second run copies nothing and duplicates no directory', async () => {
    await writeLegacy(join('42', 'tasks.json'), '{"issue":42}');
    await writeLegacy(join('42', 'archive', 'progress-1.txt'), 'archived');

    const first = await migrateLegacyStorage(projectRoot, { env });
    const second = await migrateLegacyStorage(projectRoot, { env });

    expect(second.copied).toEqual([]);
    expect(second.skipped.sort()).toEqual(first.copied.sort());
    expect(second.previousMode).toBe('global');
    expect(await readdir(join(first.globalDir, 'issues'))).toEqual(['42']);
    expect(await readdir(join(first.globalDir, 'issues', '42')).then((e) => e.sort())).toEqual([
      'archive',
      'tasks.json',
    ]);
  });

  it('never overwrites a file that already exists at the destination', async () => {
    await writeLegacy(join('42', 'tasks.json'), '{"from":"legacy"}');
    const { globalDir } = await migrateLegacyStorage(projectRoot, { env });

    const target = join(globalDir, 'issues', '42', 'tasks.json');
    await writeFile(target, '{"from":"global"}', 'utf-8');
    const result = await migrateLegacyStorage(projectRoot, { env });

    expect(await readFile(target, 'utf-8')).toBe('{"from":"global"}');
    expect(result.skipped).toEqual([join('42', 'tasks.json')]);
  });

  it('works on a project with no legacy directory', async () => {
    const result = await migrateLegacyStorage(projectRoot, { env });

    expect(result.previousMode).toBe('global');
    expect(result.copied).toEqual([]);
    expect(await exists(result.metadataFile)).toBe(true);
  });

  it('writes metadata.json matching projectMetadataSchema', async () => {
    await writeLegacy(join('42', 'tasks.json'), '{}');

    const result = await migrateLegacyStorage(projectRoot, {
      env,
      now: () => '2026-01-01T00:00:00Z',
    });

    expect(result.metadataFile).toBe(join(result.globalDir, METADATA_FILENAME));
    const onDisk = JSON.parse(await readFile(result.metadataFile, 'utf-8'));
    expect(projectMetadataSchema.safeParse(onDisk).success).toBe(true);
    expect(onDisk).toEqual({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      projectId: result.projectId,
      root: projectRoot,
      remoteUrl: 'github.com/acme/widgets',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      lastAttemptAt: null,
    });
  });

  it('reads the remote of projectRoot, not of process.cwd()', async () => {
    await migrateLegacyStorage(projectRoot, { env });
    expect(mockGetRemoteUrl).toHaveBeenCalledWith(projectRoot);
  });

  it('stores a null remoteUrl when the project has no origin remote', async () => {
    mockGetRemoteUrl.mockResolvedValue(null);

    const result = await migrateLegacyStorage(projectRoot, { env });

    expect(result.metadata.remoteUrl).toBeNull();
  });

  it('refreshes updatedAt on re-run while preserving createdAt and lastAttemptAt', async () => {
    const first = await migrateLegacyStorage(projectRoot, {
      env,
      now: () => '2026-01-01T00:00:00Z',
    });
    await writeFile(
      first.metadataFile,
      JSON.stringify({ ...first.metadata, lastAttemptAt: '2026-01-02T00:00:00Z' }),
      'utf-8',
    );

    const second = await migrateLegacyStorage(projectRoot, {
      env,
      now: () => '2026-03-04T05:06:07Z',
    });

    expect(second.metadata.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(second.metadata.updatedAt).toBe('2026-03-04T05:06:07Z');
    expect(second.metadata.lastAttemptAt).toBe('2026-01-02T00:00:00Z');
  });

  it('rewrites metadata.json from scratch when the existing one is unreadable', async () => {
    const { globalDir } = await resolveStorageMode(projectRoot, { env });
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, METADATA_FILENAME), 'not json at all', 'utf-8');

    const result = await migrateLegacyStorage(projectRoot, {
      env,
      now: () => '2026-05-05T00:00:00Z',
    });

    expect(result.metadata.createdAt).toBe('2026-05-05T00:00:00Z');
    expect(projectMetadataSchema.safeParse(result.metadata).success).toBe(true);
  });

  it('propagates an IO failure naming the issue and the file, leaving the source intact', async () => {
    await writeLegacy(join('42', 'tasks.json'), '{"issue":42}');
    const { globalDir } = await resolveStorageMode(projectRoot, { env });
    // A regular file where the issue directory should go: mkdir fails.
    await mkdir(join(globalDir, 'issues'), { recursive: true });
    await writeFile(join(globalDir, 'issues', '42'), 'in the way', 'utf-8');

    await expect(migrateLegacyStorage(projectRoot, { env })).rejects.toThrow(/issue '42'/);
    expect(
      await readFile(join(projectRoot, LEGACY_ISSUES_DIR_NAME, '42', 'tasks.json'), 'utf-8'),
    ).toBe('{"issue":42}');
  });

  it('resumes after a failure, skipping what already made it across', async () => {
    await writeLegacy(join('42', 'tasks.json'), '{"issue":42}');
    await writeLegacy(join('43', 'tasks.json'), '{"issue":43}');
    const { globalDir } = await resolveStorageMode(projectRoot, { env });
    await mkdir(join(globalDir, 'issues', '42'), { recursive: true });
    await writeFile(join(globalDir, 'issues', '42', 'tasks.json'), '{"issue":42}', 'utf-8');

    const result = await migrateLegacyStorage(projectRoot, { env });

    expect(result.skipped).toEqual([join('42', 'tasks.json')]);
    expect(result.copied).toEqual([join('43', 'tasks.json')]);
  });
});
