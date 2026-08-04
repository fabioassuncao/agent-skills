import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getProjectId } from './paths.js';

// Deliberately no `vi.mock('../utils/git.js', ...)` here: getProjectId must
// derive its identity from the given `projectRoot`, and a mocked
// `getRemoteUrl` never sees whether the real `cwd` argument was actually
// passed through — it would pass trivially even if getProjectId silently
// read process.cwd()'s remote instead. Real, disposable git repositories are
// the only way to catch that regression.

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function makeRepo(remote: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'issue-flow-repo-'));
  git(dir, 'init', '--quiet');
  git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

let temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
  temps = [];
});

describe('getProjectId (real git remotes, no mocks)', () => {
  it('derives the id from the given projectRoot, never from process.cwd()', async () => {
    const repoA = await makeRepo('https://github.com/acme/repo-a.git');
    const repoB = await makeRepo('https://github.com/acme/repo-b.git');
    temps.push(repoA, repoB);

    const idA = await getProjectId(repoA);
    const idB = await getProjectId(repoB);
    expect(idA).not.toBe(idB);

    // Regression guard: this test process's own cwd sits inside the
    // issue-flow repository, whose remote is unrelated to repoA/repoB. If
    // getRemoteUrl ever stops forwarding `cwd` again, every call below
    // collapses back onto that one remote and both assertions fail.
    const ownRepoId = await getProjectId(process.cwd());
    expect(idA).not.toBe(ownRepoId);
    expect(idB).not.toBe(ownRepoId);
  });

  it('produces the same id for one remote regardless of which directory holds it', async () => {
    const repoA = await makeRepo('https://github.com/acme/shared.git');
    const repoB = await makeRepo('https://github.com/acme/shared.git');
    temps.push(repoA, repoB);

    expect(await getProjectId(repoA)).toBe(await getProjectId(repoB));
  });
});
