import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards invariant 13 of the WebMux absorption: **one implementation per
 * responsibility**. Pull Request reading, CI reading and review-comment reading
 * live in `src/issues/github/` and nowhere else, so a second `gh pr list`
 * grown somewhere in the tree fails this suite instead of quietly becoming the
 * duplicate the port was supposed to remove.
 *
 * Pull Request *creation* is deliberately not covered: §20 makes the Issue Flow
 * canonical there and it belongs to `commands/pr.ts`.
 */

const SRC_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Where the responsibility is allowed to be implemented, relative to `src/`. */
const CANONICAL_DIR = join('issues', 'github');

interface SourceFile {
  path: string;
  content: string;
}

async function readSourceFiles(dir: string, prefix = ''): Promise<SourceFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: SourceFile[] = [];
  for (const entry of entries) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await readSourceFiles(join(dir, entry.name), relative)));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    files.push({ path: relative, content: await readFile(join(dir, entry.name), 'utf-8') });
  }
  return files;
}

/**
 * Documented exemptions, path prefix → why it is not the same responsibility.
 *
 * `providers/local.ts` probes `gh pr list --json number` to reserve the next
 * local issue number. It asks "what is the highest number GitHub has handed
 * out", never anything about a Pull Request's state, so routing it through the
 * Pull Request reader would couple two unrelated questions.
 */
const EXEMPT: ReadonlyArray<{ path: string; what: string }> = [
  { path: join('issues', 'providers', 'local.ts'), what: 'gh pr list' },
];

function isExempt(path: string, what: string): boolean {
  return EXEMPT.some((entry) => entry.path === path && entry.what === what);
}

/** `gh` argv arrays that read Pull Request, CI or review-comment state. */
const CANONICAL_CALLS: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: 'gh pr list', pattern: /(['"])pr\1\s*,\s*\n?\s*(['"])list\2/ },
  { what: 'gh pr view', pattern: /(['"])pr\1\s*,\s*\n?\s*(['"])view\2/ },
  { what: 'gh run view', pattern: /(['"])run\1\s*,\s*\n?\s*(['"])view\2/ },
  { what: 'statusCheckRollup parsing', pattern: /statusCheckRollup/ },
  { what: 'review-comment API path', pattern: /pulls\/\$\{[^}]+\}\/comments/ },
];

describe('one implementation per responsibility', () => {
  it('finds the source tree', async () => {
    const files = await readSourceFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(CANONICAL_CALLS)('implements $what only under src/issues/github', async ({
    what,
    pattern,
  }) => {
    const offenders = (await readSourceFiles(SRC_DIR))
      .filter((file) => !file.path.startsWith(CANONICAL_DIR))
      .filter((file) => !isExempt(file.path, what))
      .filter((file) => pattern.test(file.content))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});
