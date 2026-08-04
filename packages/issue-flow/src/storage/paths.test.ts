import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

const { homedir } = await import('node:os');
const { GLOBAL_DIR_NAME, GLOBAL_ROOT_ENV, getGlobalRoot } = await import('./paths.js');

const mockHomedir = vi.mocked(homedir);

beforeEach(() => {
  mockHomedir.mockReset();
  mockHomedir.mockReturnValue('/home/tester');
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
