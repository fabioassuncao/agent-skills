import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

// Only getRemoteUrl is faked: normalizeRemoteUrl stays real so the project id
// is exercised through the same normalization its callers will get.
vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return { ...actual, getRemoteUrl: vi.fn(async () => null) };
});

const { homedir } = await import('node:os');
const { getRemoteUrl } = await import('../utils/git.js');
const {
  GLOBAL_DIR_NAME,
  GLOBAL_ROOT_ENV,
  getGlobalRoot,
  getIssuePaths,
  getProjectDir,
  getProjectId,
  projectIdFromRemote,
} = await import('./paths.js');

const mockHomedir = vi.mocked(homedir);
const mockGetRemoteUrl = vi.mocked(getRemoteUrl);

beforeEach(() => {
  mockHomedir.mockReset();
  mockHomedir.mockReturnValue('/home/tester');
  mockGetRemoteUrl.mockReset();
  mockGetRemoteUrl.mockResolvedValue(null);
});

describe('getGlobalRoot', () => {
  it('returns ISSUE_FLOW_HOME when the variable is set', () => {
    expect(getGlobalRoot({ env: { [GLOBAL_ROOT_ENV]: '/tmp/issue-flow-home' } })).toBe(
      '/tmp/issue-flow-home',
    );
    expect(mockHomedir).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from the override', () => {
    expect(getGlobalRoot({ env: { [GLOBAL_ROOT_ENV]: '  /tmp/issue-flow-home  ' } })).toBe(
      '/tmp/issue-flow-home',
    );
  });

  it('falls back to the home directory when the override is empty or blank', () => {
    const expected = join('/home/tester', GLOBAL_DIR_NAME);
    expect(getGlobalRoot({ env: { [GLOBAL_ROOT_ENV]: '' } })).toBe(expected);
    expect(getGlobalRoot({ env: { [GLOBAL_ROOT_ENV]: '   ' } })).toBe(expected);
  });

  it('resolves a relative override to an absolute path', () => {
    expect(getGlobalRoot({ env: { [GLOBAL_ROOT_ENV]: '.issue-flow-test' } })).toBe(
      resolve('.issue-flow-test'),
    );
  });

  it('returns <home>/.issue-flow when the variable is absent', () => {
    expect(getGlobalRoot({ env: {} })).toBe(join('/home/tester', GLOBAL_DIR_NAME));
  });

  it('defaults the env source to process.env', () => {
    vi.stubEnv(GLOBAL_ROOT_ENV, '/tmp/from-process-env');
    expect(getGlobalRoot()).toBe('/tmp/from-process-env');
    vi.unstubAllEnvs();
  });

  it('throws an error naming ISSUE_FLOW_HOME when the home directory is unusable', () => {
    mockHomedir.mockReturnValue('');
    expect(() => getGlobalRoot({ env: {} })).toThrow(GLOBAL_ROOT_ENV);

    mockHomedir.mockImplementation(() => {
      throw new Error('no home');
    });
    expect(() => getGlobalRoot({ env: {} })).toThrow(GLOBAL_ROOT_ENV);
  });

  it('does not create the directory it resolves', async () => {
    const { existsSync } = await import('node:fs');
    const root = getGlobalRoot({ env: { [GLOBAL_ROOT_ENV]: resolve('.tmp-never-created') } });
    expect(existsSync(root)).toBe(false);
  });
});

describe('getProjectId', () => {
  it('returns <slug>-<hash12> derived from the remote', async () => {
    mockGetRemoteUrl.mockResolvedValue('https://github.com/fabioassuncao/issue-flow.git');
    expect(await getProjectId('/any/where')).toMatch(/^issue-flow-[0-9a-f]{12}$/);
  });

  it('reads the remote of projectRoot, not of process.cwd()', async () => {
    mockGetRemoteUrl.mockResolvedValue('https://github.com/fabioassuncao/issue-flow.git');
    await getProjectId('/some/other/project/root');
    expect(mockGetRemoteUrl).toHaveBeenCalledWith('/some/other/project/root');
  });

  it('produces the same id for the HTTPS and the SSH remote of one repository', async () => {
    mockGetRemoteUrl.mockResolvedValue('https://github.com/org/repo.git');
    const https = await getProjectId('/tmp/a');

    mockGetRemoteUrl.mockResolvedValue('git@github.com:org/repo.git');
    const ssh = await getProjectId('/tmp/a');

    expect(ssh).toBe(https);
  });

  it('produces the same id for one remote cloned into two different directories', async () => {
    mockGetRemoteUrl.mockResolvedValue('https://github.com/org/repo.git');
    expect(await getProjectId('/home/tester/work/repo')).toBe(
      await getProjectId('/mnt/other/checkout-2'),
    );
  });

  it('is stable across repeated calls with the same project root', async () => {
    expect(await getProjectId('/tmp/no-remote')).toBe(await getProjectId('/tmp/no-remote'));
  });

  it('falls back to the absolute project root when there is no remote', async () => {
    const id = await getProjectId('/tmp/no-remote-here');
    expect(id).toMatch(/^no-remote-here-[0-9a-f]{12}$/);
    // A relative root resolves to the same identity as its absolute form.
    expect(await getProjectId(resolve('.'))).toBe(await getProjectId('.'));
  });

  it('distinguishes repositories that share a name but not a remote', async () => {
    mockGetRemoteUrl.mockResolvedValue('https://github.com/org-a/repo.git');
    const a = await getProjectId('/tmp/repo');

    mockGetRemoteUrl.mockResolvedValue('https://github.com/org-b/repo.git');
    const b = await getProjectId('/tmp/repo');

    expect(a).not.toBe(b);
  });

  it('distinguishes remote-seeded from path-seeded ids', async () => {
    mockGetRemoteUrl.mockResolvedValue('github.com/org/repo');
    const fromRemote = await getProjectId('/tmp/repo');

    mockGetRemoteUrl.mockResolvedValue(null);
    const fromPath = await getProjectId('github.com/org/repo');

    expect(fromRemote).not.toBe(fromPath);
  });

  it('distinguishes same-named directories at different paths when there is no remote', async () => {
    expect(await getProjectId('/tmp/one/repo')).not.toBe(await getProjectId('/tmp/two/repo'));
  });

  it('sanitizes the slug into a safe path segment', async () => {
    mockGetRemoteUrl.mockResolvedValue('https://github.com/org/My_Weird..Repo!!.git');
    const id = await getProjectId('/tmp/x');

    expect(id).toMatch(/^my-weird-repo-[0-9a-f]{12}$/);
    expect(id).not.toMatch(/[/\\]|\.\.|\./);
  });

  it('truncates a long repository name to 32 characters of slug', async () => {
    const long = 'a'.repeat(60);
    mockGetRemoteUrl.mockResolvedValue(`https://github.com/org/${long}.git`);

    const id = await getProjectId('/tmp/x');
    expect(id).toBe(`${'a'.repeat(32)}-${id.split('-').pop()}`);
  });

  it('uses "project" when no character of the name survives sanitization', async () => {
    mockGetRemoteUrl.mockResolvedValue('https://github.com/org/___.git');
    expect(await getProjectId('/tmp/x')).toMatch(/^project-[0-9a-f]{12}$/);
  });
});

describe('projectIdFromRemote', () => {
  it('agrees with getProjectId given the same (already-normalized) remote', async () => {
    mockGetRemoteUrl.mockResolvedValue('https://github.com/org/repo.git');
    const viaGetProjectId = await getProjectId('/tmp/x');

    expect(projectIdFromRemote('github.com/org/repo', '/tmp/x')).toBe(viaGetProjectId);
  });

  it('falls back to the path seed when the remote is null, without touching git', () => {
    expect(projectIdFromRemote(null, '/tmp/no-remote-here')).toMatch(
      /^no-remote-here-[0-9a-f]{12}$/,
    );
    expect(mockGetRemoteUrl).not.toHaveBeenCalled();
  });

  it('is pure and synchronous: same inputs, same output, no I/O', () => {
    const a = projectIdFromRemote('github.com/org/repo', '/tmp/x');
    const b = projectIdFromRemote('github.com/org/repo', '/tmp/x');
    expect(a).toBe(b);
  });
});

const env = { [GLOBAL_ROOT_ENV]: '/tmp/global-root' };

describe('getProjectDir', () => {
  it('anchors the project under <globalRoot>/projects', () => {
    expect(getProjectDir('repo-abc123def456', { env })).toBe(
      join('/tmp/global-root', 'projects', 'repo-abc123def456'),
    );
  });

  it('follows the global root override', () => {
    mockHomedir.mockReturnValue('/home/tester');
    expect(getProjectDir('repo-abc123def456', { env: {} })).toBe(
      join('/home/tester', GLOBAL_DIR_NAME, 'projects', 'repo-abc123def456'),
    );
  });
});

describe('getIssuePaths', () => {
  it('anchors every artifact under <projectDir>/issues/<issueNumber>', () => {
    const paths = getIssuePaths('repo-abc123def456', 42, { env });
    const issueDir = join('/tmp/global-root', 'projects', 'repo-abc123def456', 'issues', '42');

    expect(paths).toEqual({
      issueDir,
      issueFile: join(issueDir, 'issue.md'),
      metadataFile: join(issueDir, 'metadata.json'),
      prdFile: join(issueDir, 'prd.md'),
      tasksFile: join(issueDir, 'tasks.json'),
      progressFile: join(issueDir, 'progress.txt'),
      analysisFile: join(issueDir, 'analysis.md'),
      sessionFile: join(issueDir, 'session.json'),
      eventsFile: join(issueDir, 'events.jsonl'),
      rotatedEventsFile: join(issueDir, 'events.1.jsonl'),
      lastBranchFile: join(issueDir, '.last-branch'),
      archiveDir: join(issueDir, 'archive'),
      prReviewDir: join(issueDir, 'pr-review'),
    });
  });

  it('accepts a number and its string form interchangeably', () => {
    expect(getIssuePaths('p-1', 42, { env })).toEqual(getIssuePaths('p-1', '42', { env }));
  });

  it.each([
    'auth-refactor',
    'pr-184',
    'RFC_7',
    '1.2',
  ])('supports the non-numeric identifier %s', (id) => {
    expect(getIssuePaths('p-1', id, { env }).issueDir).toBe(
      join('/tmp/global-root', 'projects', 'p-1', 'issues', id),
    );
  });

  it('trims whitespace and a leading # from the identifier', () => {
    expect(getIssuePaths('p-1', '  #42 ', { env })).toEqual(getIssuePaths('p-1', '42', { env }));
  });

  it.each([
    '',
    '   ',
    '#',
    '.',
    '..',
    '../escape',
    'a/b',
    'a\\b',
    '/42',
  ])('rejects the unsafe identifier %j', (id) => {
    expect(() => getIssuePaths('p-1', id, { env })).toThrow(/identifier/i);
  });

  it('does not touch the filesystem', async () => {
    const { existsSync } = await import('node:fs');
    const paths = getIssuePaths('p-1', 42, { env: { [GLOBAL_ROOT_ENV]: resolve('.tmp-no-io') } });

    expect(existsSync(paths.issueDir)).toBe(false);
  });

  it('covers every artifact documented in the README file structure', async () => {
    const readmePath = resolve(fileURLToPath(import.meta.url), '../../../../../README.md');
    const readme = await readFile(readmePath, 'utf-8');

    const section = readme.split('## Pipeline State & File Structure')[1];
    expect(section).toBeDefined();

    const block = section.split('```')[1];
    // Artifacts are the indented entries of the tree; `issues/42/` heads it.
    const documented = [...block.matchAll(/^ {2}(\S+)/gm)].map((match) =>
      match[1].replace(/\/$/, ''),
    );
    expect(documented.length).toBeGreaterThan(0);

    const resolved = new Set(
      Object.values(getIssuePaths('p-1', 42, { env })).map((p) => basename(p)),
    );
    for (const artifact of documented) {
      expect(resolved).toContain(artifact);
    }
  });
});
