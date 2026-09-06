import type { OpenIssueFlowDatabaseOptions } from './index.js';
import { openIssueFlowDatabase } from './index.js';

/**
 * SQL for the `inline_issues` table — the demand a person typed straight into
 * `issue-flow run --prompt` (§17, migration 18).
 *
 * It lives here and not next to `issues/providers/inline.ts` because
 * `storage/AGENTS.md` gives `node:sqlite` a single boundary: statements are
 * written under `storage/db/` and nowhere else (`sql-boundary.test.ts` fails
 * the build otherwise). The provider above is the domain facade; this file is
 * the only place that knows the column names.
 */

/** One inline demand, in domain spelling. */
export interface StoredInlineIssue {
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

interface InlineIssueRow {
  id: string;
  title: string;
  body: string;
  state: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = 'id, title, body, state, content_hash, created_at, updated_at';

function toStoredInlineIssue(row: InlineIssueRow): StoredInlineIssue {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    // A row written by a newer release could hold a state this one does not
    // know. Reading it as `open` keeps the pipeline able to work on it, which
    // is the safe direction: the alternative is refusing to resume a run.
    state: row.state === 'closed' ? 'closed' : 'open',
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InlineIssueAddress {
  projectId: string;
  /** Where the repository is. Only used to create the project row on demand. */
  projectRoot: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}

async function withDatabase<T>(
  work: (database: Awaited<ReturnType<typeof openIssueFlowDatabase>>) => T,
  options: OpenIssueFlowDatabaseOptions | undefined,
): Promise<T> {
  const database = await openIssueFlowDatabase(options ?? {});
  try {
    return work(database);
  } finally {
    database.close();
  }
}

/**
 * Create the `projects` row the foreign key needs.
 *
 * An inline issue is minted *before* the pipeline has registered anything: the
 * prompt is read, the Issue is created, and only then does the run resolve its
 * paths. Without this the very first `--prompt` of a repository would fail on
 * a foreign key, which is the one moment the feature has to work.
 */
function ensureProjectRow(
  database: Awaited<ReturnType<typeof openIssueFlowDatabase>>,
  address: InlineIssueAddress,
  timestamp: string,
): void {
  database
    .prepare(
      `INSERT INTO projects (id, root, remote_url, created_at, updated_at, last_seen_at)
       VALUES (?, ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET root = excluded.root, updated_at = excluded.updated_at,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(address.projectId, address.projectRoot, timestamp, timestamp, timestamp);
}

/** Read one inline demand, or `null` when this project never recorded it. */
export async function loadStoredInlineIssue(
  address: InlineIssueAddress,
  id: string,
): Promise<StoredInlineIssue | null> {
  return withDatabase((database) => {
    const row = database
      .prepare(`SELECT ${SELECT_COLUMNS} FROM inline_issues WHERE project_id = ? AND id = ?`)
      .get<InlineIssueRow>(address.projectId, id);
    return row === undefined ? null : toStoredInlineIssue(row);
  }, address.databaseOptions);
}

/**
 * Record a demand, or leave the existing one untouched.
 *
 * The identifier is derived from the prompt, so re-running the same `--prompt`
 * addresses the same Issue. `created_at` and `state` are therefore preserved on
 * conflict: a second invocation of a demand that was already closed must not
 * silently reopen it, and the first time it was asked for is the useful date.
 */
export async function saveStoredInlineIssue(
  address: InlineIssueAddress,
  issue: StoredInlineIssue,
): Promise<StoredInlineIssue> {
  return withDatabase((database) => {
    return database.transaction(() => {
      ensureProjectRow(database, address, issue.updatedAt);
      database
        .prepare(
          `INSERT INTO inline_issues
             (project_id, id, title, body, state, content_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, id) DO UPDATE SET
             title = excluded.title,
             body = excluded.body,
             content_hash = excluded.content_hash,
             updated_at = excluded.updated_at`,
        )
        .run(
          address.projectId,
          issue.id,
          issue.title,
          issue.body,
          issue.state,
          issue.contentHash,
          issue.createdAt,
          issue.updatedAt,
        );
      const row = database
        .prepare(`SELECT ${SELECT_COLUMNS} FROM inline_issues WHERE project_id = ? AND id = ?`)
        .get<InlineIssueRow>(address.projectId, issue.id);
      return row === undefined ? issue : toStoredInlineIssue(row);
    });
  }, address.databaseOptions);
}

/** Move an inline demand to `closed`. Returns false when there is no such row. */
export async function closeStoredInlineIssue(
  address: InlineIssueAddress,
  id: string,
  at: string,
): Promise<boolean> {
  return withDatabase((database) => {
    const result = database
      .prepare(
        `UPDATE inline_issues SET state = 'closed', updated_at = ?
          WHERE project_id = ? AND id = ?`,
      )
      .run(at, address.projectId, id);
    return Number(result.changes) > 0;
  }, address.databaseOptions);
}
