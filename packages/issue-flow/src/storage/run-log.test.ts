import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rotateRunLogIfNeeded } from './run-log.js';

describe('rotateRunLogIfNeeded', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'issue-flow-run-log-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('leaves a small file in place', async () => {
    const file = join(dir, 'run.log');
    await writeFile(file, 'hello');
    await rotateRunLogIfNeeded(file, join(dir, 'run.log.1'), 100);
    expect(await readFile(file, 'utf-8')).toBe('hello');
  });

  it('moves a full file to the rotated name without dropping it', async () => {
    const file = join(dir, 'run.log');
    const rotated = join(dir, 'run.log.1');
    await writeFile(file, 'abcdef');
    await rotateRunLogIfNeeded(file, rotated, 4);
    expect(await readFile(rotated, 'utf-8')).toBe('abcdef');
  });

  it('is a no-op when the file does not exist yet', async () => {
    await mkdir(dir, { recursive: true });
    await rotateRunLogIfNeeded(join(dir, 'missing.log'), join(dir, 'missing.log.1'), 4);
  });
});
