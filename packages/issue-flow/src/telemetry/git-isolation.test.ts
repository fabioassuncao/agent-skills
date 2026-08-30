import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN = [
  'executions',
  'ExecutionRecord',
  'harnessVersion',
  'routingDecision',
  'triggerReason',
];

const TARGETS = [
  join(root, 'core', 'session-git.ts'),
  join(root, 'commands', 'pr.ts'),
  join(root, 'core', 'pr-review', 'publisher.ts'),
];

async function promptFiles(): Promise<string[]> {
  const dir = join(root, '..', 'prompts');
  const names = await readdir(dir);
  return names.filter((name) => name.endsWith('.md')).map((name) => join(dir, name));
}

describe('git isolation from telemetry', () => {
  it('keeps branch, commit, PR and changelog constructors free of ExecutionRecord fields', async () => {
    const files = [...TARGETS, ...(await promptFiles())];
    const hits: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf-8');
      for (const token of FORBIDDEN) {
        if (text.includes(token)) hits.push(`${file}: ${token}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
