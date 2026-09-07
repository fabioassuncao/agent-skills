import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { dirname } from 'node:path';

/** Filesystem ops writeFileAtomic needs — injectable for EXDEV tests. */
type AtomicWriteFs = Pick<typeof fsp, 'mkdir' | 'writeFile' | 'rename' | 'copyFile' | 'unlink'>;

/**
 * Write a file atomically (write-to-temp + rename).
 *
 * A crash mid-write leaves the previous content untouched instead of a
 * truncated file, which matters for every artifact the pipeline reloads on the
 * next run (tasks.json, metadata.json, session.json).
 *
 * The temp file sits beside the target so rename stays on one filesystem; on
 * EXDEV (cross-device rename) it falls back to copy + unlink. The destination
 * directory is created when missing — the first write for a fresh issue can
 * land before any other phase has mkdir'd `issues/N/`.
 */
export async function writeFileAtomic(
  path: string,
  content: string,
  fs: AtomicWriteFs = fsp,
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmpFile = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpFile, content, { encoding: 'utf-8', mode: 0o600 });
    try {
      await fs.rename(tmpFile, path);
    } catch (err: unknown) {
      // EXDEV: rename fails across different devices/drives (common on Windows)
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fs.copyFile(tmpFile, path);
    }
  } finally {
    // Also covers partial writes and an EXDEV copy that failed midway. After a
    // successful rename the temp no longer exists, so ENOENT is expected.
    await fs.unlink(tmpFile).catch(() => {});
  }
}
