import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const sqlPattern =
  /(?:prepare|exec)\s*\(\s*[`'"]\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|PRAGMA|VACUUM)\b/i;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}

describe('SQLite boundary', () => {
  it('keeps SQL statements inside storage/db', async () => {
    const offenders = await Promise.all(
      (await sourceFiles(sourceRoot)).map(async (path) => ({
        path,
        hasSql: sqlPattern.test(await readFile(path, 'utf-8')),
      })),
    );
    expect(
      offenders.filter((entry) => entry.hasSql && !entry.path.includes('/storage/db/')),
    ).toEqual([]);
  });
});
