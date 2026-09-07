import * as fsp from 'node:fs/promises';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from './fs.js';

describe('writeFileAtomic', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'issue-flow-fs-'));
    dirs.push(dir);
    return dir;
  }

  it('creates missing parent directories before writing', async () => {
    const root = await tempDir();
    const target = join(root, 'issues', '42', 'session.json');

    await writeFileAtomic(target, '{"ok":true}\n');

    expect(await readFile(target, 'utf-8')).toBe('{"ok":true}\n');
  });

  it('replaces an existing file without leaving a .tmp sibling', async () => {
    const root = await tempDir();
    const target = join(root, 'tasks.json');
    await writeFile(target, 'old', 'utf-8');

    await writeFileAtomic(target, 'new');

    expect(await readFile(target, 'utf-8')).toBe('new');
    await expect(readFile(`${target}.tmp`, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('falls back to copy + unlink when rename fails with EXDEV', async () => {
    const root = await tempDir();
    const target = join(root, 'out.json');

    const rename = vi.fn(async () => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    });
    const copyFile = vi.fn(fsp.copyFile.bind(fsp));
    const unlink = vi.fn(fsp.unlink.bind(fsp));

    await writeFileAtomic(target, 'exdev-ok', {
      mkdir: fsp.mkdir.bind(fsp),
      writeFile: fsp.writeFile.bind(fsp),
      rename,
      copyFile,
      unlink,
    });

    expect(rename).toHaveBeenCalled();
    expect(copyFile).toHaveBeenCalled();
    expect(unlink).toHaveBeenCalled();
    expect(await readFile(target, 'utf-8')).toBe('exdev-ok');
  });

  it('removes a partially written temp when writeFile fails', async () => {
    const root = await tempDir();
    const target = join(root, 'partial.json');
    const failedWrite = vi.fn(async (path: Parameters<typeof fsp.writeFile>[0]) => {
      await fsp.writeFile(path, 'partial');
      throw new Error('disk full');
    });

    await expect(
      writeFileAtomic(target, 'complete', {
        mkdir: fsp.mkdir.bind(fsp),
        writeFile: failedWrite as typeof fsp.writeFile,
        rename: fsp.rename.bind(fsp),
        copyFile: fsp.copyFile.bind(fsp),
        unlink: fsp.unlink.bind(fsp),
      }),
    ).rejects.toThrow('disk full');
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('removes the temp when the EXDEV fallback copy fails', async () => {
    const root = await tempDir();
    const target = join(root, 'copy-failure.json');
    await expect(
      writeFileAtomic(target, 'complete', {
        mkdir: fsp.mkdir.bind(fsp),
        writeFile: fsp.writeFile.bind(fsp),
        rename: async () => {
          throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        },
        copyFile: async () => {
          throw new Error('copy failed');
        },
        unlink: fsp.unlink.bind(fsp),
      }),
    ).rejects.toThrow('copy failed');
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
