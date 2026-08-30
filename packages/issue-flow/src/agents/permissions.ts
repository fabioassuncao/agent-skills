import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getGlobalRoot } from '../storage/paths.js';
import { writeFileAtomic } from '../utils/fs.js';
import { getProjectRoot } from '../utils/git.js';
import type { CursorPermissionsFile } from './types.js';

export const MANAGED_MARKER = 'issue-flow:managed';

function managedEntries(root: string): string[] {
  const glob = `${root.replace(/\\/g, '/')}/**`;
  return [`Read(${glob})`, `Write(${glob})`];
}

export function cursorPermissionsPath(
  mode: CursorPermissionsFile,
  projectRoot?: string,
): string | null {
  if (mode === 'none') return null;
  if (mode === 'project') {
    return join(projectRoot ?? process.cwd(), '.cursor', 'cli.json');
  }
  return join(homedir(), '.cursor', 'cli-config.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Additive merge of `~/.cursor/cli-config.json` (or the project file).
 * Never removes foreign entries. Idempotent.
 */
export async function ensureCursorStorageGrant(options: {
  mode?: CursorPermissionsFile;
  projectRoot?: string;
  globalRoot?: string;
  /** Test seam: write this file instead of the Cursor config path. */
  filePath?: string;
}): Promise<{ path: string; wrote: boolean } | { skipped: true; reason: 'none' }> {
  const mode = options.mode ?? 'global';
  if (mode === 'none') return { skipped: true, reason: 'none' };

  const path =
    options.filePath ??
    cursorPermissionsPath(
      mode,
      options.projectRoot ?? (await getProjectRoot().catch(() => process.cwd())),
    );
  if (path === null) return { skipped: true, reason: 'none' };

  const root = options.globalRoot ?? getGlobalRoot();
  const wanted = managedEntries(root);

  let current: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    if (isRecord(raw)) current = raw;
  } catch {
    current = {};
  }

  const permissions = isRecord(current.permissions) ? { ...current.permissions } : {};
  const allow = Array.isArray(permissions.allow)
    ? permissions.allow.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const missing = wanted.filter((entry) => !allow.includes(entry));
  if (missing.length === 0) {
    return { path, wrote: false };
  }

  permissions.allow = [...allow, ...missing];
  const next = {
    ...current,
    permissions,
    [MANAGED_MARKER]: true,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return { path, wrote: true };
}

export function cursorStorageGranted(allow: unknown, globalRoot?: string): boolean {
  if (!Array.isArray(allow)) return false;
  const wanted = managedEntries(globalRoot ?? getGlobalRoot());
  return wanted.every((entry) => allow.includes(entry));
}
