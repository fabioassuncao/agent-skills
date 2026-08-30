import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getPackageVersion, UNKNOWN_VERSION } from './version.js';

describe('getPackageVersion', () => {
  it('reports the version in the manifest, never the unknown fallback', async () => {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const { version } = JSON.parse(await readFile(manifest, 'utf-8')) as { version: string };

    // A wrong version is worse than no version: the terminal headline and the
    // dashboard both claim to name the build the user is running.
    expect(getPackageVersion()).toBe(version);
    expect(getPackageVersion()).not.toBe(UNKNOWN_VERSION);
  });
});
