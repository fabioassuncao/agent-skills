import { join, resolve } from 'node:path';
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
const { GLOBAL_DIR_NAME, GLOBAL_ROOT_ENV, getGlobalRoot, getProjectId } = await import(
  './paths.js'
);

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
