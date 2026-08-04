import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printInfo } from '../ui/logger.js';
import { getRemoteUrl } from '../utils/git.js';
import { LEGACY_ISSUES_DIR_NAME, migrateLegacyStorage } from './compat.js';
import { GLOBAL_ROOT_ENV } from './paths.js';
import { resetStorageResolutionCache, resolveIssuePaths, resolveProjectPaths } from './resolve.js';

/**
 * The migration seen from the outside, on a legacy tree that looks like a real
 * one: several issues, every artifact the pipeline writes, and nested
 * `archive/` and `pr-review/` directories.
 *
 * `resolve.test.ts` covers the resolver's decisions case by case with minimal
 * fixtures; this file answers the two questions a user actually has — "did all
 * of my data make it across, untouched?" and "what happens the second time I
 * run a command?".
 */

// Only the remote lookup is faked, so the project id stays deterministic. Mode
// resolution, the copy itself and the notice all run for real against a
// temporary tree.
vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return { ...actual, getRemoteUrl: vi.fn(async () => null) };
});

// The migration notice is user-facing output: capture it instead of printing it.
vi.mock('../ui/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/logger.js')>();
  return { ...actual, printInfo: vi.fn() };
});

const mockGetRemoteUrl = vi.mocked(getRemoteUrl);
const mockPrintInfo = vi.mocked(printInfo);

const REMOTE = 'https://github.com/acme/widgets.git';

/**
 * A legacy `issues/` directory as an established install would have it: the
 * issue the pipeline ran end to end (42), an issue created by the local
 * provider under a non-numeric identifier, and the synthetic `pr-<N>` slug a
 * PR review produces when it has no issue attached.
 */
const LEGACY_TREE: Record<string, string> = {
  '42/session.json': `${JSON.stringify({ sessionId: 's-42', status: 'completed' }, null, 2)}\n`,
  '42/tasks.json': `${JSON.stringify({ issueNumber: 42, userStories: [] }, null, 2)}\n`,
  '42/prd.md': '# PRD 42\n\nLegacy requirements.\n',
  '42/progress.txt': '## US-001\n- done\n',
  '42/.last-branch': 'issue/42-legacy-branch\n',
  '42/analysis.md': '# Analysis 42\n',
  '42/archive/iteration-1/tasks.json': `${JSON.stringify({ iteration: 1 }, null, 2)}\n`,
  '42/archive/iteration-1/progress.txt': 'iteration 1 log\n',
  '42/pr-review/index.json': `${JSON.stringify({ rounds: 1 }, null, 2)}\n`,
  '42/pr-review/pr-7-round-1.md': '# PR 7, round 1\n',
  'auth-refactor/issue.md': '# Auth refactor\n',
  'auth-refactor/metadata.json': `${JSON.stringify({ id: 'auth-refactor' }, null, 2)}\n`,
  'pr-184/pr-review/pr-184-round-1.md': '# PR 184, round 1\n',
};

let temps: string[] = [];
let globalHome: string;
let projectRoot: string;
let env: NodeJS.ProcessEnv;

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Absolute path of a legacy artifact, from its `<issue>/<...>` key. */
function legacyPath(key: string): string {
  return join(projectRoot, LEGACY_ISSUES_DIR_NAME, ...key.split('/'));
}

async function writeTree(tree: Record<string, string>): Promise<void> {
  for (const [key, content] of Object.entries(tree)) {
    const file = legacyPath(key);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, content, 'utf-8');
  }
}

/**
 * Every file under `dir` as `<relative path> -> sha256`.
 *
 * Comparing two of these answers "did everything arrive, byte for byte?" and
 * "did anything change?" in one assertion, and a mismatch names the file.
 */
async function fingerprint(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const out: Record<string, string> = {};

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    const digest = createHash('sha256')
      .update(await readFile(absolute))
      .digest('hex');
    out[relative(dir, absolute)] = digest;
  }

  return out;
}

/** The legacy tree as written, keyed the same way `fingerprint()` keys files. */
function expectedFingerprint(tree: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tree).map(([key, content]) => [
      join(...key.split('/')),
      createHash('sha256').update(content).digest('hex'),
    ]),
  );
}

/** The global `issues/` directory of the project under test. */
async function globalIssuesDir(): Promise<string> {
  return (await resolveProjectPaths({ env, projectRoot })).issuesDir;
}

beforeEach(async () => {
  resetStorageResolutionCache();

  mockPrintInfo.mockReset();
  mockGetRemoteUrl.mockReset();
  mockGetRemoteUrl.mockResolvedValue(REMOTE);

  globalHome = await makeTemp('issue-flow-home-');
  projectRoot = await makeTemp('issue-flow-project-');
  env = { [GLOBAL_ROOT_ENV]: globalHome };

  await writeTree(LEGACY_TREE);
});

afterEach(async () => {
  resetStorageResolutionCache();
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
  temps = [];
});

describe('legacy migration, end to end', () => {
  it('copies the whole legacy tree on the first resolution', async () => {
    await resolveIssuePaths(42, { env, projectRoot });

    // The migration copies the tree, not just the issue that triggered it — so
    // the two directories must be indistinguishable by content.
    expect(await fingerprint(await globalIssuesDir())).toEqual(expectedFingerprint(LEGACY_TREE));
  });

  it('resolves every artifact of a migrated issue to its migrated copy', async () => {
    const paths = await resolveIssuePaths(42, { env, projectRoot });

    await expect(readFile(paths.sessionFile, 'utf-8')).resolves.toBe(
      LEGACY_TREE['42/session.json'],
    );
    await expect(readFile(paths.tasksFile, 'utf-8')).resolves.toBe(LEGACY_TREE['42/tasks.json']);
    await expect(readFile(paths.prdFile, 'utf-8')).resolves.toBe(LEGACY_TREE['42/prd.md']);
    await expect(readFile(paths.progressFile, 'utf-8')).resolves.toBe(
      LEGACY_TREE['42/progress.txt'],
    );
    await expect(readFile(paths.analysisFile, 'utf-8')).resolves.toBe(
      LEGACY_TREE['42/analysis.md'],
    );
    await expect(readFile(paths.lastBranchFile, 'utf-8')).resolves.toBe(
      LEGACY_TREE['42/.last-branch'],
    );
    await expect(
      readFile(join(paths.archiveDir, 'iteration-1', 'tasks.json'), 'utf-8'),
    ).resolves.toBe(LEGACY_TREE['42/archive/iteration-1/tasks.json']);
    await expect(readFile(join(paths.prReviewDir, 'pr-7-round-1.md'), 'utf-8')).resolves.toBe(
      LEGACY_TREE['42/pr-review/pr-7-round-1.md'],
    );

    // The non-numeric identifiers of the same tree resolve just as well.
    const local = await resolveIssuePaths('auth-refactor', { env, projectRoot });
    await expect(readFile(local.issueFile, 'utf-8')).resolves.toBe(
      LEGACY_TREE['auth-refactor/issue.md'],
    );

    const prSlug = await resolveIssuePaths('pr-184', { env, projectRoot });
    await expect(readFile(join(prSlug.prReviewDir, 'pr-184-round-1.md'), 'utf-8')).resolves.toBe(
      LEGACY_TREE['pr-184/pr-review/pr-184-round-1.md'],
    );
  });

  it('leaves the legacy tree byte-for-byte identical', async () => {
    const legacyDir = join(projectRoot, LEGACY_ISSUES_DIR_NAME);
    const before = await fingerprint(legacyDir);

    await resolveIssuePaths(42, { env, projectRoot });

    expect(await fingerprint(legacyDir)).toEqual(before);
  });

  it('announces the migration once, naming both directories and the file count', async () => {
    await resolveIssuePaths(42, { env, projectRoot });

    const printed = mockPrintInfo.mock.calls.map(([line]) => line).join('\n');

    expect(printed).toContain(`${Object.keys(LEGACY_TREE).length} files`);
    expect(printed).toContain(join(projectRoot, LEGACY_ISSUES_DIR_NAME));
    expect(printed).toContain(await globalIssuesDir());
    expect(printed).toMatch(/not modified or removed/);
  });
});

describe('legacy migration idempotency', () => {
  it('reports every file as skipped on a second run and changes nothing', async () => {
    await resolveIssuePaths(42, { env, projectRoot });
    const after = await fingerprint(await globalIssuesDir());

    const second = await migrateLegacyStorage(projectRoot, { env });

    expect(second.copied).toEqual([]);
    expect(second.skipped.sort()).toEqual(
      Object.keys(LEGACY_TREE)
        .map((key) => join(...key.split('/')))
        .sort(),
    );
    expect(second.previousMode).toBe('global');
    expect(await fingerprint(await globalIssuesDir())).toEqual(after);
  });

  it('does not duplicate or corrupt data when the same command runs twice', async () => {
    await resolveIssuePaths(42, { env, projectRoot });
    const after = await fingerprint(await globalIssuesDir());

    // A fresh cache is what the next `issue-flow` invocation starts from: the
    // whole resolution — mode, migration, notice — happens again from scratch.
    resetStorageResolutionCache();
    mockPrintInfo.mockClear();

    const paths = await resolveIssuePaths(42, { env, projectRoot });

    expect(await fingerprint(await globalIssuesDir())).toEqual(after);
    expect(JSON.parse(await readFile(paths.tasksFile, 'utf-8'))).toEqual({
      issueNumber: 42,
      userStories: [],
    });
    // Nothing was copied, so the second invocation stays silent.
    expect(mockPrintInfo).not.toHaveBeenCalled();
  });

  it('never overwrites an artifact the pipeline wrote into the global tree', async () => {
    const paths = await resolveIssuePaths(42, { env, projectRoot });
    await writeFile(paths.prdFile, '# PRD 42\n\nRewritten by the pipeline.\n', 'utf-8');

    resetStorageResolutionCache();
    await resolveIssuePaths(42, { env, projectRoot });
    await migrateLegacyStorage(projectRoot, { env });

    await expect(readFile(paths.prdFile, 'utf-8')).resolves.toBe(
      '# PRD 42\n\nRewritten by the pipeline.\n',
    );
    // ...and the legacy copy still holds the original, untouched.
    await expect(readFile(legacyPath('42/prd.md'), 'utf-8')).resolves.toBe(
      LEGACY_TREE['42/prd.md'],
    );
  });

  it('picks up an issue a collaborator left behind in the legacy tree', async () => {
    // First contact migrates the project, so the mode is 'global' from here on.
    await resolveIssuePaths(42, { env, projectRoot });
    mockPrintInfo.mockClear();

    // Someone on an older Issue Flow then writes a brand new issue into the
    // legacy directory. The per-issue fallback is what still finds it.
    await writeTree({ '77/prd.md': '# PRD 77\n' });

    const paths = await resolveIssuePaths(77, { env, projectRoot });

    await expect(readFile(paths.prdFile, 'utf-8')).resolves.toBe('# PRD 77\n');
    expect(mockPrintInfo).toHaveBeenCalled();
  });
});
