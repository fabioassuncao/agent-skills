import type { OpenIssueFlowDatabaseOptions } from './index.js';
import { openIssueFlowDatabase } from './index.js';

/**
 * SQL for the `projects` table — the Project Registry (§47.2).
 *
 * It lives here and not next to `storage/projects/registry.ts` because
 * `storage/AGENTS.md` gives `node:sqlite` a single boundary: statements are
 * written under `storage/db/` and nowhere else (`sql-boundary.test.ts` fails
 * the build otherwise). The registry above is the domain facade; this file is
 * the only place that knows the column names.
 */

/**
 * How a project came to be known.
 *
 * - `discovered` — a plain `issue-flow run` created the row on its first
 *   execution. This is the default, so direct mode keeps working untouched.
 * - `registered` — explicit curation, from `issue-flow project add` or the
 *   dashboard. The only value `serve` reloads across restarts.
 * - `ephemeral` — the repository a `serve` process happens to sit in. Present
 *   in the domain and **never written**: persisting the cwd would make *other*
 *   servers start serving that repository on their next restart, which is the
 *   reason the upstream `addEphemeral()` exists at all.
 */
export type ProjectSource = 'registered' | 'discovered' | 'ephemeral';

export function isProjectSource(value: unknown): value is ProjectSource {
  return value === 'registered' || value === 'discovered' || value === 'ephemeral';
}

/** One row of the registry, in domain spelling. */
export interface StoredProject {
  /** `projectIdFromRemote()` — the identity, stable across moves and clones. */
  id: string;
  /** Where the repository currently is. A locator, never the identity. */
  root: string;
  remoteUrl: string | null;
  /** Dashboard label. Cosmetic: everything else is derived from the repo. */
  name: string | null;
  addedAt: string | null;
  lastSeenAt: string | null;
  source: ProjectSource;
  createdAt: string;
  updatedAt: string;
}

interface ProjectRow {
  id: string;
  root: string;
  remote_url: string | null;
  name: string | null;
  added_at: string | null;
  last_seen_at: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS =
  'id, root, remote_url, name, added_at, last_seen_at, source, created_at, updated_at';

function toStoredProject(row: ProjectRow): StoredProject {
  return {
    id: row.id,
    root: row.root,
    remoteUrl: row.remote_url,
    name: row.name,
    addedAt: row.added_at,
    lastSeenAt: row.last_seen_at,
    // A value this reader does not know must not become an exception: the file
    // may have been written by a newer release (the same rule the schemas in
    // `storage/schemas.ts` follow).
    source: isProjectSource(row.source) ? row.source : 'discovered',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function withDatabase<T>(
  work: (database: Awaited<ReturnType<typeof openIssueFlowDatabase>>) => T,
  options: OpenIssueFlowDatabaseOptions = {},
): Promise<T> {
  const database = await openIssueFlowDatabase(options);
  try {
    return work(database);
  } finally {
    database.close();
  }
}

export interface ListStoredProjectsInput {
  /** Restrict to these `source` values. Omitted means every project. */
  sources?: readonly ProjectSource[];
  /**
   * `recency` (default) is what a list shown to a person wants. `added` is
   * what *prefix derivation* wants: prefixes are assigned in the order the
   * list is walked, so walking oldest-first means the project that was curated
   * first keeps the unsuffixed prefix when a namesake shows up later.
   */
  order?: 'recency' | 'added';
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}

/**
 * Every known project, most recently seen first.
 *
 * The ordering is what the dashboard's "Recentes" section reads: a project
 * that never ran has no `last_seen_at`, so it sorts after the ones that did
 * without disappearing — which is the whole point of the registry.
 */
export async function listStoredProjects(
  input: ListStoredProjectsInput = {},
): Promise<StoredProject[]> {
  const sources = input.sources;
  const orderBy =
    input.order === 'added'
      ? 'added_at IS NULL, added_at, created_at, id'
      : 'last_seen_at IS NULL, last_seen_at DESC, added_at DESC, id';
  return withDatabase((database) => {
    const rows =
      sources === undefined
        ? database
            .prepare(`SELECT ${SELECT_COLUMNS} FROM projects ORDER BY ${orderBy}`)
            .all<ProjectRow>()
        : sources.length === 0
          ? []
          : database
              .prepare(
                `SELECT ${SELECT_COLUMNS} FROM projects
                 WHERE source IN (${sources.map(() => '?').join(', ')})
                 ORDER BY ${orderBy}`,
              )
              .all<ProjectRow>(...sources);
    return rows.map(toStoredProject);
  }, input.databaseOptions);
}

export async function getStoredProject(
  id: string,
  databaseOptions: OpenIssueFlowDatabaseOptions = {},
): Promise<StoredProject | null> {
  return withDatabase((database) => {
    const row = database
      .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ?`)
      .get<ProjectRow>(id);
    return row === undefined ? null : toStoredProject(row);
  }, databaseOptions);
}

export async function getStoredProjectByRoot(
  root: string,
  databaseOptions: OpenIssueFlowDatabaseOptions = {},
): Promise<StoredProject | null> {
  return withDatabase((database) => {
    const row = database
      .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE root = ? ORDER BY updated_at DESC`)
      .get<ProjectRow>(root);
    return row === undefined ? null : toStoredProject(row);
  }, databaseOptions);
}

export interface UpsertStoredProjectInput {
  id: string;
  root: string;
  remoteUrl?: string | null;
  name?: string | null;
  source: ProjectSource;
  /** Timestamp. Injected so a caller can make its writes deterministic. */
  now?: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}

/**
 * Create or promote one project row.
 *
 * `added_at` is only ever set once — promotion of a `discovered` project keeps
 * the moment it first appeared, because `project rm` followed by `project add`
 * must not look like a brand new project. Nothing here deletes anything: runs,
 * artifacts and telemetry are attached to `id`, and curation is a column.
 */
export async function upsertStoredProject(
  input: UpsertStoredProjectInput,
): Promise<StoredProject | null> {
  const now = input.now ?? new Date().toISOString();
  const options = input.databaseOptions ?? {};
  return withDatabase((database) => {
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO projects (id, root, remote_url, created_at, updated_at, name, added_at, last_seen_at, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT(id) DO UPDATE SET
             root = excluded.root,
             updated_at = excluded.updated_at,
             remote_url = COALESCE(excluded.remote_url, projects.remote_url),
             name = COALESCE(excluded.name, projects.name),
             added_at = COALESCE(projects.added_at, excluded.added_at),
             source = excluded.source`,
        )
        .run(
          input.id,
          input.root,
          input.remoteUrl ?? null,
          now,
          now,
          input.name ?? null,
          now,
          input.source,
        );
    });
    const row = database
      .prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ?`)
      .get<ProjectRow>(input.id);
    return row === undefined ? null : toStoredProject(row);
  }, options);
}

export interface SetStoredProjectSourceInput {
  id: string;
  source: ProjectSource;
  now?: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}

/**
 * Reclassify one project. Returns false when the project is unknown.
 *
 * This is what `project rm` runs: `registered` → `discovered`. The history it
 * leaves behind is the point — demotion is not deletion.
 */
export async function setStoredProjectSource(input: SetStoredProjectSourceInput): Promise<boolean> {
  const now = input.now ?? new Date().toISOString();
  return withDatabase((database) => {
    const result = database
      .prepare('UPDATE projects SET source = ?, updated_at = ? WHERE id = ?')
      .run(input.source, now, input.id);
    return Number(result.changes) > 0;
  }, input.databaseOptions ?? {});
}

export interface TouchStoredProjectInput {
  id: string;
  at?: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}

/** Record that a project was just opened or executed. */
export async function touchStoredProject(input: TouchStoredProjectInput): Promise<boolean> {
  const at = input.at ?? new Date().toISOString();
  return withDatabase((database) => {
    const result = database
      .prepare('UPDATE projects SET last_seen_at = ?, updated_at = ? WHERE id = ?')
      .run(at, at, input.id);
    return Number(result.changes) > 0;
  }, input.databaseOptions ?? {});
}
