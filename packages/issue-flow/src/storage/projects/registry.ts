import { existsSync } from 'node:fs';
import { getDatabasePath, type OpenIssueFlowDatabaseOptions } from '../db/index.js';
import {
  getStoredProject,
  getStoredProjectByRoot,
  listStoredProjects,
  type ProjectSource,
  type StoredProject,
  setStoredProjectSource,
  touchStoredProject,
  upsertStoredProject,
} from '../db/projects.js';

export type { ProjectSource, StoredProject } from '../db/projects.js';

/** What a caller needs to know about one registered project. */
export interface ProjectRecord {
  id: string;
  root: string;
  remoteUrl: string | null;
  name: string | null;
  addedAt: string | null;
  lastSeenAt: string | null;
  source: ProjectSource;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRegistryOptions {
  databaseOptions?: OpenIssueFlowDatabaseOptions;
  /** Timestamp source, injected so tests can assert ordering without sleeping. */
  now?: () => string;
}

export interface RegisterProjectInput {
  id: string;
  root: string;
  remoteUrl?: string | null;
  name?: string | null;
  /** Defaults to `registered` — the only reason to call this explicitly. */
  source?: ProjectSource;
}

export interface ProjectRegistry {
  /** Every known project, most recently seen first. Never throws. */
  list(): Promise<ProjectRecord[]>;
  /**
   * Only the curated ones — what `serve` reloads across restarts — oldest
   * first, so prefix derivation is stable as projects are added.
   */
  listRegistered(): Promise<ProjectRecord[]>;
  get(id: string): Promise<ProjectRecord | null>;
  getByRoot(root: string): Promise<ProjectRecord | null>;
  /** Create or promote. Returns the stored row. */
  register(input: RegisterProjectInput): Promise<ProjectRecord | null>;
  /** Demote to `discovered`. Runs, artifacts and telemetry are untouched. */
  unregister(id: string): Promise<boolean>;
  /** Record that the project was just opened or executed. */
  touch(id: string): Promise<boolean>;
}

function toRecord(stored: StoredProject): ProjectRecord {
  return { ...stored };
}

/** `ephemeral` is a runtime state, so persisting it is a programming error. */
function assertPersistable(source: ProjectSource): void {
  if (source === 'ephemeral') {
    throw new Error(
      'An ephemeral project is served in-process only and is never written to the registry.',
    );
  }
}

export function createProjectRegistry(options: ProjectRegistryOptions = {}): ProjectRegistry {
  const databaseOptions = options.databaseOptions ?? {};
  const now = options.now ?? (() => new Date().toISOString());

  /**
   * Run a read, degrading to `fallback` instead of throwing.
   *
   * The existence check is not an optimization: opening the database *creates*
   * it, and asking "which projects exist" must never be what brings the
   * storage into being. The `json` compatibility driver depends on that — a
   * monitor running without SQLite has a test asserting no database file
   * appears — and so does every read on a machine that has never run anything.
   */
  async function tolerant<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    try {
      if (!existsSync(getDatabasePath(databaseOptions))) return fallback;
      return await work();
    } catch {
      return fallback;
    }
  }

  return {
    list: () =>
      tolerant(() => listStoredProjects({ databaseOptions }), []).then((rows) =>
        rows.map(toRecord),
      ),

    listRegistered: () =>
      tolerant(
        () => listStoredProjects({ sources: ['registered'], order: 'added', databaseOptions }),
        [],
      ).then((rows) => rows.map(toRecord)),

    get: (id) =>
      tolerant(() => getStoredProject(id, databaseOptions), null).then((row) =>
        row === null ? null : toRecord(row),
      ),

    getByRoot: (root) =>
      tolerant(() => getStoredProjectByRoot(root, databaseOptions), null).then((row) =>
        row === null ? null : toRecord(row),
      ),

    register: async (input) => {
      const source = input.source ?? 'registered';
      assertPersistable(source);
      const stored = await upsertStoredProject({
        id: input.id,
        root: input.root,
        remoteUrl: input.remoteUrl ?? null,
        name: input.name ?? null,
        source,
        now: now(),
        databaseOptions,
      });
      return stored === null ? null : toRecord(stored);
    },

    unregister: (id) =>
      setStoredProjectSource({ id, source: 'discovered', now: now(), databaseOptions }),

    touch: (id) => touchStoredProject({ id, at: now(), databaseOptions }),
  };
}
