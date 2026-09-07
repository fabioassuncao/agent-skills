import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withSerializedFileLock } from '../storage/lock.js';
import { writeFileAtomic } from '../utils/fs.js';
import { PROJECT_CONFIG_FILENAME } from './sources.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readWritableProjectConfig(projectRoot: string): Promise<Record<string, unknown>> {
  const path = join(projectRoot, PROJECT_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Report the same stable error for malformed JSON and a non-object root.
  }
  throw new Error(`Cannot update ${PROJECT_CONFIG_FILENAME}: expected a valid JSON object.`);
}

/**
 * Update one project-config section without losing concurrent settings writes.
 *
 * Every dashboard writer shares the same durable lock file. This matters when,
 * for example, an agent edit and a Linear toggle arrive in adjacent requests:
 * both re-read after acquiring the lock and preserve the other's keys.
 */
export async function updateProjectConfigSection(
  projectRoot: string,
  section: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const path = join(projectRoot, PROJECT_CONFIG_FILENAME);
  await withSerializedFileLock(`${path}.lock`, `project-settings:${path}`, async () => {
    const config = await readWritableProjectConfig(projectRoot);
    const current = isRecord(config[section]) ? config[section] : {};
    config[section] = update({ ...current });
    await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
  });
}
