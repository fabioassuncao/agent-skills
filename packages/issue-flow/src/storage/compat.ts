import type { Dirent } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { isoNow } from '../core/state-manager.js';
import { writeFileAtomic } from '../utils/fs.js';
import { getRemoteUrl, normalizeRemoteUrl } from '../utils/git.js';
import {
  type GetGlobalRootOptions,
  getProjectDir,
  ISSUES_DIR_NAME,
  projectIdFromRemote,
} from './paths.js';
import { type ProjectMetadata, projectMetadataSchema, STORAGE_SCHEMA_VERSION } from './schemas.js';

/**
 * Coexistence between the legacy per-project layout (`<projectRoot>/issues/`)
 * and the global storage tree (`~/.issue-flow/projects/<project-id>/`).
 *
 * The single rule of this module: **the legacy directory is read-only.** Nothing
 * here removes or rewrites a byte under `<projectRoot>/issues/` — not even
 * behind an opt-in flag — so adopting the global storage can never cost a user
 * their history. Migration is a copy, and a copy that refuses to overwrite.
 */

/** Directory holding the legacy per-project artifacts. */
export const LEGACY_ISSUES_DIR_NAME = 'issues';

/** File holding the per-project metadata inside the global storage. */
export const METADATA_FILENAME = 'metadata.json';

/**
 * - `global`: the global directory is the source of truth (it already exists,
 *   or neither layout does and a fresh project starts there).
 * - `needs-migration`: only the legacy directory exists, so its content has not
 *   been copied over yet.
 */
export type StorageMode = 'global' | 'needs-migration';

export interface StorageStatus {
  mode: StorageMode;
  /** Deterministic id, derived from {@link projectIdFromRemote}. */
  projectId: string;
  /** `<globalRoot>/projects/<projectId>`. */
  globalDir: string;
  /** `<projectRoot>/issues`. */
  legacyDir: string;
  /** Whether `globalDir` currently exists on disk. */
  globalExists: boolean;
  /** Whether `legacyDir` currently exists on disk. */
  legacyExists: boolean;
  /**
   * Normalized `origin` remote of `projectRoot`, or `null` without one.
   * Resolved once here so `migrateLegacyStorage` can reuse it instead of
   * shelling out to git a second time for `metadata.json`.
   */
  remoteUrl: string | null;
}

export interface MigrationResult {
  projectId: string;
  globalDir: string;
  legacyDir: string;
  /** Mode observed *before* the migration ran. */
  previousMode: StorageMode;
  /** Paths copied, relative to `legacyDir`. */
  copied: string[];
  /** Paths left alone because the destination already had a file. */
  skipped: string[];
  /** Absolute path of the metadata file written by this run. */
  metadataFile: string;
  /** Metadata as persisted. */
  metadata: ProjectMetadata;
}

export interface MigrateLegacyStorageOptions extends GetGlobalRootOptions {
  /** Timestamp source, injectable so tests can assert createdAt/updatedAt. */
  now?: () => string;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Describe where a project's artifacts live, without touching anything.
 *
 * Read-only by construction: it stats the two candidate directories and reports
 * what it found. It never creates a directory, so a caller can ask the question
 * (a status command, a warning banner) without committing the user to the new
 * layout.
 *
 * An existing global directory always wins: once artifacts are there, that is
 * the source of truth, and a legacy directory left behind is simply preserved
 * rather than re-read or re-migrated.
 */
export async function resolveStorageMode(
  projectRoot: string,
  options: GetGlobalRootOptions = {},
): Promise<StorageStatus> {
  const remoteUrl = normalizeRemoteUrl(await getRemoteUrl(projectRoot));
  const projectId = projectIdFromRemote(remoteUrl, projectRoot);
  const globalDir = getProjectDir(projectId, options);
  const legacyDir = join(resolve(projectRoot), LEGACY_ISSUES_DIR_NAME);

  const [globalExists, legacyExists] = await Promise.all([
    directoryExists(globalDir),
    directoryExists(legacyDir),
  ]);

  return {
    // Only one state calls for work: legacy content that has nowhere to be read
    // from yet. Everything else — including "neither exists" — is already the
    // global layout.
    mode: legacyExists && !globalExists ? 'needs-migration' : 'global',
    projectId,
    globalDir,
    legacyDir,
    globalExists,
    legacyExists,
    remoteUrl,
  };
}

/**
 * Wrap an IO failure with the issue and file it happened on, so a partial
 * migration is diagnosable instead of a bare `EACCES`.
 */
function migrationFailure(issue: string, relativePath: string, err: unknown): Error {
  const reason = err instanceof Error ? err.message : String(err);

  return new Error(
    `Failed to migrate '${relativePath}' (issue '${issue}'): ${reason}. ` +
      'The legacy directory was left untouched — fix the cause and run the migration again.',
  );
}

/** First path segment of a relative path — the issue a file belongs to. */
function issueOf(relativePath: string): string {
  return relativePath.split(sep)[0] || '.';
}

/**
 * Copy one directory level, recursing into subdirectories.
 *
 * Symlinks and other non-regular entries are skipped on purpose: following them
 * could copy content from outside the legacy directory into the global tree.
 */
async function copyTree(
  sourceRoot: string,
  targetRoot: string,
  relativeDir: string,
  result: { copied: string[]; skipped: string[] },
): Promise<void> {
  const source = join(sourceRoot, relativeDir);
  const target = join(targetRoot, relativeDir);

  let entries: Dirent[];
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (err) {
    throw migrationFailure(issueOf(relativeDir), relativeDir || '.', err);
  }

  try {
    // recursive: true also makes re-running a no-op on an existing directory.
    await mkdir(target, { recursive: true });
  } catch (err) {
    throw migrationFailure(issueOf(relativeDir), relativeDir || '.', err);
  }

  for (const entry of entries) {
    const relativePath = join(relativeDir, entry.name);

    if (entry.isDirectory()) {
      await copyTree(sourceRoot, targetRoot, relativePath, result);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const to = join(targetRoot, relativePath);
    try {
      // Idempotency and safety in one check: a destination that already exists
      // is never overwritten, so a second run copies nothing and a hand-edited
      // artifact in the global tree survives.
      if (await pathExists(to)) {
        result.skipped.push(relativePath);
        continue;
      }
      await copyFile(join(sourceRoot, relativePath), to);
      result.copied.push(relativePath);
    } catch (err) {
      throw migrationFailure(issueOf(relativePath), relativePath, err);
    }
  }
}

/**
 * Read `metadata.json`, tolerating every failure.
 *
 * A missing, corrupt or schema-invalid file must not block a migration: the
 * caller simply writes a fresh one. The only thing worth recovering is
 * `createdAt`/`lastAttemptAt` from a valid previous file.
 */
async function readExistingMetadata(file: string): Promise<ProjectMetadata | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    return null;
  }

  try {
    const parsed = projectMetadataSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Copy `<projectRoot>/issues/` into the project's global directory and stamp
 * its `metadata.json`.
 *
 * Non-destructive and idempotent, by design rather than by convention:
 *
 * - the source is only ever read — there is no removal option in this release;
 * - a destination file that already exists is skipped, never overwritten, so a
 *   second run reports everything as skipped and changes nothing but
 *   `updatedAt`;
 * - a failure mid-way leaves the legacy directory intact and names the issue
 *   and file that failed, so the run can be repeated after the fix and will
 *   resume by skipping what already made it across.
 *
 * Called on a project with no legacy directory it is still useful: it creates
 * the project directory and its metadata.
 */
export async function migrateLegacyStorage(
  projectRoot: string,
  options: MigrateLegacyStorageOptions = {},
): Promise<MigrationResult> {
  const status = await resolveStorageMode(projectRoot, { env: options.env });
  const result = { copied: [] as string[], skipped: [] as string[] };

  try {
    await mkdir(status.globalDir, { recursive: true });
  } catch (err) {
    throw migrationFailure('.', status.globalDir, err);
  }

  if (status.legacyExists) {
    await copyTree(status.legacyDir, join(status.globalDir, ISSUES_DIR_NAME), '', result);
  }

  const now = (options.now ?? isoNow)();
  const metadataFile = join(status.globalDir, METADATA_FILENAME);
  const existing = await readExistingMetadata(metadataFile);

  const metadata: ProjectMetadata = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    projectId: status.projectId,
    root: resolve(projectRoot),
    remoteUrl: status.remoteUrl,
    // The project was first seen whenever it was first written, not now.
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastAttemptAt: existing?.lastAttemptAt ?? null,
  };

  await writeFileAtomic(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);

  return {
    projectId: status.projectId,
    globalDir: status.globalDir,
    legacyDir: status.legacyDir,
    previousMode: status.mode,
    ...result,
    metadataFile,
    metadata,
  };
}
