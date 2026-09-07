import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const WORKSPACE_STORAGE_DIR = '.issue-flow';

export const WORKSPACE_IGNORE_BLOCK = [
  '# Issue Flow operational storage (managed)',
  '/issues/',
  '/queues/',
  '/issue-flow.db',
  '/issue-flow.db-*',
  '/run.lock',
  '/metadata.json',
  '/backups/',
  '/.gitignore',
].join('\n');

export async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Select one complete artifact store; individual files never mix roots. */
export function selectArtifactStorage(
  projectRoot: string,
  globalRoot: string,
  projectId: string,
  workspaceSelected: boolean,
): { storageMode: 'global' | 'workspace'; projectDir: string } {
  return workspaceSelected
    ? { storageMode: 'workspace', projectDir: join(projectRoot, WORKSPACE_STORAGE_DIR) }
    : { storageMode: 'global', projectDir: join(globalRoot, 'projects', projectId) };
}

/** Protect an explicitly selected workspace store without hiding prompt overrides. */
export async function ensureWorkspaceStorageIgnored(projectRoot: string): Promise<void> {
  const path = join(projectRoot, WORKSPACE_STORAGE_DIR, '.gitignore');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (
    WORKSPACE_IGNORE_BLOCK.split('\n')
      .slice(1)
      .every((line) => current.includes(line))
  )
    return;
  const prefix = current.length === 0 ? '' : `${current.trimEnd()}\n\n`;
  await writeFile(path, `${prefix}${WORKSPACE_IGNORE_BLOCK}\n`, 'utf8');
}
