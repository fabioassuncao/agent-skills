import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rename } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { parseJournal } from '../../core/journal.js';
import { taskPlanSchema } from '../../schemas.js';
import { METADATA_FILENAME } from '../compat.js';
import {
  EVENTS_FILENAME,
  ISSUES_DIR_NAME,
  PROVIDERS_HEALTH_FILENAME,
  QUEUES_DIR_NAME,
  VERIFY_FILENAME,
} from '../paths.js';
import { projectMetadataSchema, providersHealthSchema } from '../schemas.js';
import { openDatabase } from './driver.js';
import {
  getDatabasePath,
  type OpenIssueFlowDatabaseOptions,
  openIssueFlowDatabase,
} from './index.js';
import { CURRENT_SCHEMA_VERSION } from './migrations.js';
import { writePlanRows } from './repository.js';

/** A source file that was imported into one or more relational tables. */
interface Artifact {
  path: string;
  relativePath: string;
  sha256: string;
  kind: 'metadata' | 'tasks' | 'health' | 'queue' | 'events' | 'verify';
  value: unknown;
  issueId?: string;
}

export interface ImportProjectOptions extends OpenIssueFlowDatabaseOptions {
  projectId: string;
  projectDir: string;
  projectRoot: string;
  remoteUrl: string | null;
  /** Number of pre-migration backups to retain. Defaults to five. */
  backupRetention?: number;
  /** Explicit database history retention. Omitted values retain every row. */
  retention?: {
    executions?: number;
    events?: number;
    snapshots?: number;
  };
  onWarning?: (message: string) => void;
}

export interface ImportProjectResult {
  imported: number;
  skipped: number;
  tableCounts: Record<string, number>;
  failed: boolean;
}

const EMPTY_COUNTS: Record<string, number> = {
  projects: 0,
  issues: 0,
  pipelines: 0,
  stories: 0,
  executions: 0,
  events: 0,
  queues: 0,
  provider_health: 0,
  verifications: 0,
  pull_requests: 0,
  user_story_numbering: 0,
};

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${digest(value).slice(0, 24)}`;
}

async function fileIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function collectArtifacts(projectDir: string): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  const addJson = async (path: string, kind: Artifact['kind'], issueId?: string): Promise<void> => {
    const content = await fileIfPresent(path);
    if (content === null) return;
    artifacts.push({
      path,
      relativePath: relative(projectDir, path),
      sha256: digest(content),
      kind,
      issueId,
      value: JSON.parse(content),
    });
  };

  await addJson(join(projectDir, METADATA_FILENAME), 'metadata');
  await addJson(join(projectDir, PROVIDERS_HEALTH_FILENAME), 'health');

  const issuesDir = join(projectDir, ISSUES_DIR_NAME);
  let issueEntries: string[] = [];
  try {
    issueEntries = await readdir(issuesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const issueId of issueEntries) {
    const issueDir = join(issuesDir, issueId);
    await addJson(join(issueDir, 'tasks.json'), 'tasks', issueId);
    await addJson(join(issueDir, VERIFY_FILENAME), 'verify', issueId);
    for (const name of [EVENTS_FILENAME, 'events.1.jsonl']) {
      const path = join(issueDir, name);
      const content = await fileIfPresent(path);
      if (content !== null) {
        artifacts.push({
          path,
          relativePath: relative(projectDir, path),
          sha256: digest(content),
          kind: 'events',
          issueId,
          value: parseJournal(content),
        });
      }
    }
  }

  const queuesDir = join(projectDir, QUEUES_DIR_NAME);
  let queueEntries: string[] = [];
  try {
    queueEntries = await readdir(queuesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const queueId of queueEntries) {
    await addJson(join(queuesDir, queueId, 'execution-plan.json'), 'queue');
  }
  return artifacts;
}

function increment(counts: Record<string, number>, table: string): void {
  counts[table] = (counts[table] ?? 0) + 1;
}

function insertIssue(
  database: Awaited<ReturnType<typeof openIssueFlowDatabase>>,
  projectId: string,
  id: string,
  status: string,
  title: string | null,
  branchName: string | null,
  timestamp: string,
  counts: Record<string, number>,
): void {
  database
    .prepare(
      `INSERT INTO issues (project_id, id, title, status, branch_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, id) DO UPDATE SET
         title = excluded.title, status = excluded.status, branch_name = excluded.branch_name,
         updated_at = excluded.updated_at`,
    )
    .run(projectId, id, title, status, branchName, timestamp, timestamp);
  increment(counts, 'issues');
}

function importArtifact(
  database: Awaited<ReturnType<typeof openIssueFlowDatabase>>,
  artifact: Artifact,
  projectId: string,
  fallback: { root: string; remoteUrl: string | null; timestamp: string },
  counts: Record<string, number>,
): void {
  const value = artifact.value as Record<string, unknown>;
  if (artifact.kind === 'metadata') {
    const metadata = projectMetadataSchema.parse(value);
    database
      .prepare(
        `INSERT INTO projects (id, root, remote_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET root = excluded.root, remote_url = excluded.remote_url,
         updated_at = excluded.updated_at`,
      )
      .run(projectId, metadata.root, metadata.remoteUrl, metadata.createdAt, metadata.updatedAt);
    increment(counts, 'projects');
    if (metadata.userStoryNumbering !== undefined) {
      const decision = metadata.userStoryNumbering;
      database
        .prepare(
          `INSERT INTO user_story_numbering (project_id, next_number, source, issue_id, decided_at, detail)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET next_number = excluded.next_number,
             source = excluded.source, issue_id = excluded.issue_id, decided_at = excluded.decided_at,
             detail = excluded.detail`,
        )
        .run(
          projectId,
          decision.nextNumber,
          decision.source,
          decision.issueNumber,
          decision.decidedAt,
          decision.detail ?? null,
        );
      increment(counts, 'user_story_numbering');
    }
    return;
  }
  if (artifact.kind === 'tasks') {
    // Some pre-plan legacy trees use `tasks.json` as a tiny placeholder. It
    // is not structured pipeline state yet, so leave it available for the
    // legacy reader instead of failing the project-wide SQLite import.
    const parsed = taskPlanSchema.safeParse(value);
    if (!parsed.success) return;
    const plan = parsed.data;
    const issueId = artifact.issueId ?? String(plan.issueNumber);
    writePlanRows(
      database,
      {
        tasksPath: artifact.path,
        projectId,
        issueId,
        projectRoot: fallback.root,
      },
      plan,
    );
    increment(counts, 'issues');
    increment(counts, 'pipelines');
    counts.stories += plan.userStories.length;
    for (const execution of plan.executions ?? []) {
      const cost = execution.cost.status === 'unknown' ? null : execution.cost.amount;
      database
        .prepare(
          `INSERT INTO executions
           (id, project_id, issue_id, status, started_at, finished_at, duration_ms, cost_status, cost_amount, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at,
           duration_ms = excluded.duration_ms, cost_status = excluded.cost_status,
           cost_amount = excluded.cost_amount, payload_json = excluded.payload_json`,
        )
        .run(
          execution.id,
          projectId,
          issueId,
          execution.status,
          execution.startedAt,
          execution.finishedAt,
          execution.durationMs,
          execution.cost.status,
          cost,
          JSON.stringify(execution),
        );
      increment(counts, 'executions');
    }
    if (plan.pullRequest !== undefined) {
      const id = stableId('pr', `${projectId}:${issueId}:${plan.pullRequest.number}`);
      database
        .prepare(
          `INSERT INTO pull_requests (id, project_id, issue_id, number, url, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET url = excluded.url, status = excluded.status`,
        )
        .run(
          id,
          projectId,
          issueId,
          plan.pullRequest.number,
          plan.pullRequest.url,
          'created',
          plan.pullRequest.createdAt,
        );
      increment(counts, 'pull_requests');
    }
    return;
  }
  if (artifact.kind === 'health') {
    const health = providersHealthSchema.parse(value);
    for (const [provider, record] of Object.entries(health.providers)) {
      database
        .prepare(
          `INSERT INTO provider_health (project_id, provider, payload_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id, provider) DO UPDATE SET payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
        )
        .run(projectId, provider, JSON.stringify(record), fallback.timestamp);
      increment(counts, 'provider_health');
    }
    return;
  }
  if (artifact.kind === 'events') {
    for (const entry of artifact.value as ReturnType<typeof parseJournal>) {
      const id = stableId('event', `${artifact.relativePath}:${entry.seq}`);
      const event = entry.event as { at?: string; type: string };
      database
        .prepare(
          `INSERT INTO events (id, project_id, occurred_at, kind, payload_json) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET occurred_at = excluded.occurred_at, kind = excluded.kind,
           payload_json = excluded.payload_json`,
        )
        .run(id, projectId, event.at ?? fallback.timestamp, event.type, JSON.stringify(entry));
      increment(counts, 'events');
    }
    return;
  }
  if (artifact.kind === 'verify') {
    const id = stableId('verify', artifact.relativePath);
    database
      .prepare(
        `INSERT INTO verifications (id, project_id, issue_id, status, created_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json`,
      )
      .run(
        id,
        projectId,
        artifact.issueId ?? null,
        String(value.verdict ?? 'unknown'),
        fallback.timestamp,
        JSON.stringify(value),
      );
    increment(counts, 'verifications');
    return;
  }

  const queue = value as {
    id: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    issues: Array<{ id: string; position: number; status: string }>;
    pullRequest?: { number: number; url: string; createdAt: string };
  };
  database
    .prepare(
      `INSERT INTO queues (id, project_id, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json,
       updated_at = excluded.updated_at`,
    )
    .run(
      queue.id,
      projectId,
      queue.status,
      JSON.stringify(queue),
      queue.createdAt,
      queue.updatedAt,
    );
  increment(counts, 'queues');
  for (const entry of queue.issues) {
    insertIssue(database, projectId, entry.id, entry.status, null, null, queue.updatedAt, counts);
    database
      .prepare(
        `INSERT INTO queue_issues (queue_id, project_id, issue_id, position, status) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(queue_id, project_id, issue_id) DO UPDATE SET position = excluded.position,
         status = excluded.status`,
      )
      .run(queue.id, projectId, entry.id, entry.position, entry.status);
  }
  if (queue.pullRequest !== undefined) {
    const id = stableId('pr', `${projectId}:queue:${queue.id}:${queue.pullRequest.number}`);
    database
      .prepare(
        `INSERT INTO pull_requests (id, project_id, number, url, status, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET url = excluded.url, status = excluded.status`,
      )
      .run(
        id,
        projectId,
        queue.pullRequest.number,
        queue.pullRequest.url,
        'created',
        queue.pullRequest.createdAt,
      );
    increment(counts, 'pull_requests');
  }
}

async function retainBackups(directory: string, retention: number): Promise<void> {
  let names: string[] = [];
  try {
    names = (await readdir(directory)).filter(
      (name) => name.startsWith('issue-flow-') && name.endsWith('.db'),
    );
  } catch {
    return;
  }
  for (const name of names.sort().slice(0, Math.max(0, names.length - retention))) {
    // A retention cleanup is deliberately best-effort; losing an old backup
    // must never make a migration fail.
    await import('node:fs/promises').then(({ unlink }) =>
      unlink(join(directory, name)).catch(() => undefined),
    );
  }
}

/** Trim only explicitly limited project history; zero means retain all rows. */
function applyRetention(
  database: Awaited<ReturnType<typeof openIssueFlowDatabase>>,
  projectId: string,
  retention: ImportProjectOptions['retention'],
): void {
  const trim = (table: 'executions' | 'events' | 'snapshots', limit: number | undefined) => {
    if (limit === undefined || limit === 0) return;
    const timestamp =
      table === 'executions' ? 'started_at' : table === 'events' ? 'occurred_at' : 'updated_at';
    database
      .prepare(
        `DELETE FROM ${table} WHERE id IN (
           SELECT id FROM ${table} WHERE project_id = ?
           ORDER BY ${timestamp} DESC, rowid DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(projectId, limit);
  };
  trim('executions', retention?.executions);
  trim('events', retention?.events);
  trim('snapshots', retention?.snapshots);
}

export const DEFAULT_BACKUP_RETENTION = 5;

async function prepareDatabase(options: ImportProjectOptions): Promise<void> {
  const path = getDatabasePath(options);
  if (!existsSync(path)) return;
  const raw = await openDatabase(path, options);
  try {
    const integrity = raw.integrityCheck();
    if (integrity !== 'ok') {
      raw.close();
      const quarantine = `${path}.corrupt-${Date.now()}`;
      await rename(path, quarantine);
      options.onWarning?.(
        `SQLite integrity check failed; isolated ${path} as ${quarantine} and will re-import preserved JSON artifacts.`,
      );
      return;
    }
    const version = Number(
      raw.prepare('PRAGMA user_version').get<{ user_version: number }>()?.user_version ?? 0,
    );
    // A database upgrade is destructive enough to deserve a recovery point
    // even when there are no JSON artifacts to import. An empty project may
    // still contain the only copy of its SQLite state.
    const backupDirectory = join(getDatabasePath(options).replace(/[/\\][^/\\]+$/, ''), 'backups');
    if (version < CURRENT_SCHEMA_VERSION) {
      const backup = join(backupDirectory, `issue-flow-${Date.now()}.db`);
      raw.backup(backup);
    }
    await retainBackups(backupDirectory, options.backupRetention ?? DEFAULT_BACKUP_RETENTION);
  } finally {
    try {
      raw.close();
    } catch {
      /* closed after quarantine */
    }
  }
}

/**
 * Import the structured JSON state already present in one global project tree.
 * Sources are read first and never written. A complete project is then applied
 * in one SQLite transaction, so a repeat after interruption is safe.
 */
export async function importProjectArtifacts(
  options: ImportProjectOptions,
): Promise<ImportProjectResult> {
  const counts = { ...EMPTY_COUNTS };
  try {
    await prepareDatabase(options);
    const database = await openIssueFlowDatabase(options);
    try {
      const adopted = database
        .prepare('SELECT project_id FROM project_imports WHERE project_id = ?')
        .get<{ project_id: string }>(options.projectId);
      // JSON becomes a compatibility projection after successful adoption;
      // never scan it again in a later process and overwrite canonical rows.
      if (adopted !== undefined)
        return { imported: 0, skipped: 0, tableCounts: counts, failed: false };
      const artifacts = await collectArtifacts(options.projectDir);
      let imported = 0;
      let skipped = 0;
      database.transaction(() => {
        database
          .prepare(
            `INSERT INTO projects (id, root, remote_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET root = excluded.root, remote_url = excluded.remote_url,
             updated_at = excluded.updated_at`,
          )
          .run(
            options.projectId,
            options.projectRoot,
            options.remoteUrl,
            new Date().toISOString(),
            new Date().toISOString(),
          );
        increment(counts, 'projects');
        for (const artifact of artifacts) {
          const previous = database
            .prepare('SELECT sha256 FROM migrated_artifacts WHERE source_path = ?')
            .get<{ sha256: string }>(artifact.path);
          // Reprocess an otherwise unchanged legacy tasks file exactly once
          // when it predates the relational plan columns, so upgrading does
          // not require touching the source artifact.
          const requiresPlanProjection =
            artifact.kind === 'tasks' &&
            taskPlanSchema.safeParse(artifact.value).success &&
            database
              .prepare('SELECT project FROM pipelines WHERE project_id = ? AND issue_id = ?')
              .get<{ project: string | null }>(options.projectId, artifact.issueId ?? '')
              ?.project === null;
          if (previous?.sha256 === artifact.sha256 && !requiresPlanProjection) {
            skipped++;
            continue;
          }
          importArtifact(
            database,
            artifact,
            options.projectId,
            {
              root: options.projectRoot,
              remoteUrl: options.remoteUrl,
              timestamp: new Date().toISOString(),
            },
            counts,
          );
          database
            .prepare(
              `INSERT INTO migrated_artifacts (source_path, sha256, migrated_at, table_counts_json)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(source_path) DO UPDATE SET sha256 = excluded.sha256,
               migrated_at = excluded.migrated_at, table_counts_json = excluded.table_counts_json`,
            )
            .run(artifact.path, artifact.sha256, new Date().toISOString(), JSON.stringify(counts));
          imported++;
        }
        applyRetention(database, options.projectId, options.retention);
        database
          .prepare('INSERT INTO project_imports (project_id, completed_at) VALUES (?, ?)')
          .run(options.projectId, new Date().toISOString());
      });
      return { imported, skipped, tableCounts: counts, failed: false };
    } finally {
      database.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // These are database-opening compatibility failures, not failed imports.
    // Leave the database in place so the actionable driver/schema error is not
    // turned into a destructive-looking recovery event.
    if (
      message.includes('newer than this Issue Flow supports') ||
      message.includes('SQLite storage requires Node.js')
    ) {
      throw error;
    }
    const path = getDatabasePath(options);
    if (existsSync(path)) {
      const failed = `${path}.failed-${Date.now()}`;
      try {
        await rename(path, failed);
        options.onWarning?.(
          `SQLite import failed; preserved the database for diagnosis as ${basename(failed)}. Continuing with the intact JSON storage.`,
        );
      } catch {
        // The original import error remains the useful diagnostic.
      }
    }
    options.onWarning?.(`SQLite import skipped: ${message}`);
    return { imported: 0, skipped: 0, tableCounts: counts, failed: true };
  }
}
