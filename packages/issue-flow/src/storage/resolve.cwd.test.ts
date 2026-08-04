import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../utils/shell.js';
import { GLOBAL_ROOT_ENV } from './paths.js';
import { resetStorageResolutionCache, resolveIssuePaths } from './resolve.js';

/**
 * Regression guard, inherited from the (now removed) `getIssueDir()`: an issue
 * directory must be anchored to the git repository root, never to
 * `process.cwd()`. A CWD-relative resolution is what once let `plan` write to
 * `<subdir>/issues/<N>/` while `execute` looked for the same issue under
 * `<repoRoot>/issues/<N>/` and failed.
 *
 * `resolveIssuePaths()` is now the only way to resolve one, so the guarantee is
 * asserted on it — and with a real repository and a real `chdir`, since the
 * whole point is what `git rev-parse --show-toplevel` answers from a
 * subdirectory. This file mocks nothing on purpose.
 */

let temps: string[] = [];
let originalCwd: string;
let globalHome: string;
let projectRoot: string;
let subdir: string;
let env: NodeJS.ProcessEnv;

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

beforeEach(async () => {
  originalCwd = process.cwd();
  resetStorageResolutionCache();

  globalHome = await makeTemp('issue-flow-home-');
  env = { [GLOBAL_ROOT_ENV]: globalHome };

  projectRoot = await makeTemp('issue-flow-project-');
  await run('git', ['init'], { cwd: projectRoot });

  subdir = join(projectRoot, 'packages', 'x');
  await mkdir(subdir, { recursive: true });
});

afterEach(async () => {
  process.chdir(originalCwd);
  resetStorageResolutionCache();
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
  temps = [];
});

describe('resolveIssuePaths CWD independence', () => {
  it('resolves the same paths from the repository root and from a subdirectory', async () => {
    process.chdir(projectRoot);
    const fromRoot = await resolveIssuePaths(42, { env });

    // A fresh cache is what a second `issue-flow` invocation would start from,
    // so the subdirectory run has to rediscover the repository on its own.
    resetStorageResolutionCache();

    process.chdir(subdir);
    const fromSubdir = await resolveIssuePaths(42, { env });

    expect(fromSubdir).toEqual(fromRoot);
  });

  it('anchors the issue directory to the repository, not to the working directory', async () => {
    process.chdir(subdir);
    const paths = await resolveIssuePaths(42, { env });

    expect(paths.issueDir.startsWith(globalHome)).toBe(true);
    expect(paths.issueDir).not.toContain(join('packages', 'x'));
  });
});
