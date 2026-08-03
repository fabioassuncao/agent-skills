import { copyFile, mkdtemp, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * Write a file atomically (write-to-temp + rename).
 *
 * A crash mid-write leaves the previous content untouched instead of a
 * truncated file, which matters for every artifact the pipeline reloads on the
 * next run (tasks.json, metadata.json).
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'issue-flow-'));
  const tmpFile = join(tmpDir, basename(path));

  await writeFile(tmpFile, content, 'utf-8');

  try {
    await rename(tmpFile, path);
  } catch (err: unknown) {
    // EXDEV: rename fails across different devices/drives (common on Windows)
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      await copyFile(tmpFile, path);
      await unlink(tmpFile);
    } else {
      throw err;
    }
  }
}
