import { readFile, stat as statFile } from 'node:fs/promises';
import { sessionSnapshotSchema, type ValidatedSessionSnapshot } from '../schemas.js';

export interface ReadSessionFileResult {
  snapshot: ValidatedSessionSnapshot;
  updatedAtMs: number;
}

/**
 * Read and validate one `session.json`. Anything short of a fully valid file
 * (missing, mid-write, corrupted, written by an incompatible future version)
 * reads as "not currently a session" — a directory scan must never fail
 * because one file is momentarily inconsistent.
 */
export async function readSessionFile(filePath: string): Promise<ReadSessionFileResult | null> {
  let raw: string;
  let mtimeMs: number;
  try {
    const [content, stat] = await Promise.all([readFile(filePath, 'utf-8'), statFile(filePath)]);
    raw = content;
    mtimeMs = stat.mtimeMs;
  } catch {
    return null;
  }

  try {
    const parsed = sessionSnapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.sessionId === null) return null;
    return { snapshot: parsed.data, updatedAtMs: mtimeMs };
  } catch {
    return null;
  }
}
