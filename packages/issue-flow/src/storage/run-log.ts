import { rename, stat } from 'node:fs/promises';

/** Default ceiling before `run.log` rotates into `run.log.1`. */
export const DEFAULT_RUN_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * If `run.log` is already at the ceiling, move it to the rotated name so the
 * next writer starts a fresh file. The current generation is never deleted.
 */
export async function rotateRunLogIfNeeded(
  filePath: string,
  rotatedPath: string,
  maxBytes = DEFAULT_RUN_LOG_MAX_BYTES,
): Promise<void> {
  if (maxBytes <= 0) return;
  try {
    const size = (await stat(filePath)).size;
    if (size < maxBytes) return;
  } catch {
    return;
  }
  try {
    await rename(filePath, rotatedPath);
  } catch {
    // A concurrent rotator already moved it, or the disk is full — the
    // writer will append to whatever is there.
  }
}
