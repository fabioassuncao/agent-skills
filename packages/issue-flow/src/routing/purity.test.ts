import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));

describe('routing purity', () => {
  it('does not import fs, execa or storage', async () => {
    const files = [
      'analyze.ts',
      'capabilities.ts',
      'priors.ts',
      'score.ts',
      'decide.ts',
      'budget.ts',
      'escalation.ts',
    ];
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf-8');
      expect(text).not.toMatch(/from 'node:fs|from 'execa'|from '\.\.\/storage\//);
    }
  });
});
