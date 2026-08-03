import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the provider migration: the pipeline talks to Issue providers, never
 * to `gh` directly. A command that shells out again would bypass the resolver
 * and silently break every non-GitHub origin.
 */

const COMMANDS_DIR = fileURLToPath(new URL('../commands', import.meta.url));

/** Forbidden shell-outs, split so a failure names the offending call. */
const FORBIDDEN_GH_CALLS = ['gh issue view', 'gh issue create'];

async function readCommandFiles(): Promise<Array<{ name: string; content: string }>> {
  const entries = await readdir(COMMANDS_DIR);
  const files = entries.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

  return Promise.all(
    files.map(async (name) => ({
      name,
      content: await readFile(join(COMMANDS_DIR, name), 'utf-8'),
    })),
  );
}

describe('src/commands does not call gh for Issues', () => {
  it('finds the command files', async () => {
    const files = await readCommandFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN_GH_CALLS)('never references %s', async (call) => {
    const offenders = (await readCommandFiles())
      .filter((file) => file.content.includes(call))
      .map((file) => file.name);

    expect(offenders).toEqual([]);
  });
});
