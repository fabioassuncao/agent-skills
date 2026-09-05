import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * The Agent Skills are a published interface, and the two ways they break are
 * invisible from inside this repository.
 *
 * A `../` reference resolves here and dangles wherever the skill is actually
 * installed, because every real client — `npx skills`, Cursor, Codex, OpenCode,
 * Gemini CLI, Antigravity, the Microsoft Agent Framework — copies or scans only
 * the directory holding the `SKILL.md`. And a contract edited in one consumer
 * instead of at its source drifts silently from the other.
 *
 * `npm run skills:check` catches both. Running it from the suite as well means a
 * `vitest` run fails on it too, rather than only CI.
 *
 * The third test closes the loop the other two cannot: the working tree holds
 * sources, so passing there says nothing about the tree users actually install.
 * Assembling that tree and validating it strictly is the only check that proves
 * the published branch would work.
 */

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

async function script(name: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await run('node', [`scripts/${name}`, ...args], { cwd: REPO_ROOT });
    return stdout;
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string };
    // The scripts report on both streams; surface everything or the assertion
    // message says nothing about what actually drifted.
    throw new Error(`${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim());
  }
}

describe('the published skills', () => {
  it('conform to the Agent Skills specification', async () => {
    await expect(script('validate-skills.mjs')).resolves.toContain('conform to the Agent Skills');
  }, 30_000);

  it('supply every prompt contract from a single source', async () => {
    await expect(script('sync-prompt-contracts.mjs', '--check')).resolves.toContain(
      'prompt contracts built',
    );
  }, 30_000);

  it('assemble into a publishable tree with nothing missing', async () => {
    const out = await mkdtemp(join(tmpdir(), 'issue-flow-skills-tree-'));
    try {
      await script('build-skills-tree.mjs', '--out', out);
      await expect(script('validate-skills.mjs', '--tree', out)).resolves.toContain(
        'conform to the Agent Skills',
      );
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);
});
