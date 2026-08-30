import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONVENTIONS_ROOT = fileURLToPath(new URL('.', import.meta.url));

const FORBIDDEN = [
  /from ['"].*\/agents\//,
  /from ['"].*\/core\/headless/,
  /from ['"].*\/core\/executor/,
];

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

describe('conventions dependency direction', () => {
  it('does not import the agent layer or the CLI facades', async () => {
    const files = await walk(CONVENTIONS_ROOT);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(file, 'utf-8');
      for (const pattern of FORBIDDEN) {
        expect(source, `${file} imports a forbidden layer`).not.toMatch(pattern);
      }
    }
  });
});
