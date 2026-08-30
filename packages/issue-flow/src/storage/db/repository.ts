import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { taskPlanSchema } from '../../schemas.js';
import type { ExecutionRecord } from '../../telemetry/types.js';
import type { TaskPlan } from '../../types.js';
import { writeFileAtomic } from '../../utils/fs.js';
import { type OpenIssueFlowDatabaseOptions, openIssueFlowDatabase } from './index.js';

/** Identity needed to address one plan in the shared SQLite database. */
export interface PlanRepositoryContext {
  tasksPath: string;
  projectId: string;
  issueId: string;
  projectRoot: string;
  /** Test/embedding seam for a non-default Issue Flow home. */
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}

const contexts = new Map<string, PlanRepositoryContext>();
const agentProjectionWindows = new Set<string>();

/** Keep the tolerant US-NNN interpretation next to the indexed representation. */
function storyNumber(id: string): number | null {
  const matches = id.match(/\d+/g);
  if (matches === null || matches.length === 0) return null;
  const value = Number.parseInt(matches.at(-1) ?? '', 10);
  return Number.isNaN(value) ? null : value;
}

/** Register the SQLite-backed projection for an issue path resolved by storage. */
export function registerPlanRepository(context: PlanRepositoryContext): void {
  contexts.set(context.tasksPath, context);
}

export function getPlanRepository(path: string): PlanRepositoryContext | undefined {
  return contexts.get(path);
}

/**
 * Compatibility bootstrap for direct engine consumers that bind telemetry
 * without first resolving an Issue Flow issue path. Production issue commands
 * always register their real project identity in `resolve.ts`; this preserves
 * the standalone API without making telemetry parse or rewrite its projection.
 */
export async function ensurePlanRepository(path: string): Promise<PlanRepositoryContext | null> {
  const known = getPlanRepository(path);
  if (known !== undefined) return known;
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 24);
  const context: PlanRepositoryContext = {
    tasksPath: path,
    projectId: `projection-${digest}`,
    issueId: `projection-${digest}`,
    projectRoot: dirname(path),
  };
  try {
    const plan = parsePlan(await readFile(path, 'utf-8'), path);
    await saveStoredPlan(context, plan);
    registerPlanRepository(context);
    return context;
  } catch {
    return null;
  }
}

export function resetPlanRepositories(): void {
  contexts.clear();
  agentProjectionWindows.clear();
}

/** Prevent telemetry projection refreshes while an agent owns tasks.json. */
export function setAgentProjectionWindow(path: string, active: boolean): void {
  if (active) agentProjectionWindows.add(path);
  else agentProjectionWindows.delete(path);
}

function parsePlan(value: string, path: string): TaskPlan {
  try {
    return taskPlanSchema.parse(JSON.parse(value)) as TaskPlan;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid SQLite task plan for ${path}: ${detail}`, { cause: error });
  }
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

/** Read the canonical plan plus execution rows, never the projection file. */
export async function loadStoredPlan(context: PlanRepositoryContext): Promise<TaskPlan> {
  return withDatabase((database) => {
    const row = database
      .prepare('SELECT state_json FROM pipelines WHERE project_id = ? AND issue_id = ?')
      .get<{ state_json: string }>(context.projectId, context.issueId);
    if (row === undefined) {
      throw new Error(`No SQLite task plan exists for issue ${context.issueId}. Run plan first.`);
    }
    const plan = parsePlan(row.state_json, context.tasksPath);
    const executions = database
      .prepare(
        'SELECT payload_json FROM executions WHERE project_id = ? AND issue_id = ? ORDER BY started_at, rowid',
      )
      .all<{ payload_json: string }>(context.projectId, context.issueId)
      .map((execution) => JSON.parse(execution.payload_json));
    return executions.length > 0 ? { ...plan, executions } : plan;
  });
}

function writePlanRows(
  database: Awaited<ReturnType<typeof openIssueFlowDatabase>>,
  context: PlanRepositoryContext,
  plan: TaskPlan,
): void {
  const timestamp = plan.lastAttemptAt ?? new Date().toISOString();
  database
    .prepare(
      `INSERT INTO projects (id, root, remote_url, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET root = excluded.root, updated_at = excluded.updated_at`,
    )
    .run(context.projectId, context.projectRoot, timestamp, timestamp);
  database
    .prepare(
      `INSERT INTO issues (project_id, id, title, status, branch_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, id) DO UPDATE SET title = excluded.title, status = excluded.status,
       branch_name = excluded.branch_name, updated_at = excluded.updated_at`,
    )
    .run(
      context.projectId,
      context.issueId,
      plan.description || null,
      plan.issueStatus,
      plan.branchName || null,
      timestamp,
      timestamp,
    );
  const { executions: _executions, ...storedPlan } = plan;
  database
    .prepare(
      `INSERT INTO pipelines (project_id, issue_id, state_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, issue_id) DO UPDATE SET state_json = excluded.state_json,
       updated_at = excluded.updated_at`,
    )
    .run(context.projectId, context.issueId, JSON.stringify(storedPlan), timestamp);

  database
    .prepare('DELETE FROM story_dependencies WHERE project_id = ? AND issue_id = ?')
    .run(context.projectId, context.issueId);
  database
    .prepare('DELETE FROM stories WHERE project_id = ? AND issue_id = ?')
    .run(context.projectId, context.issueId);
  for (const story of plan.userStories) {
    database
      .prepare(
        `INSERT INTO stories (project_id, issue_id, id, title, priority, passes, notes, story_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        context.projectId,
        context.issueId,
        story.id,
        story.title,
        story.priority,
        story.passes ? 1 : 0,
        story.notes,
        storyNumber(story.id),
      );
  }
  for (const story of plan.userStories) {
    for (const dependency of story.dependencies ?? []) {
      database
        .prepare(
          `INSERT INTO story_dependencies (project_id, issue_id, story_id, depends_on_story_id)
           VALUES (?, ?, ?, ?)`,
        )
        .run(context.projectId, context.issueId, story.id, dependency);
    }
  }
}

/** Persist the canonical plan and refresh its file projection atomically. */
export async function saveStoredPlan(
  context: PlanRepositoryContext,
  plan: TaskPlan,
): Promise<void> {
  await withDatabase(
    (database) => database.transaction(() => writePlanRows(database, context, plan)),
    context.databaseOptions,
  );
  await materializePlan(context);
}

/** Write the compatibility file used by agents and legacy prompt contracts. */
export async function materializePlan(
  context: PlanRepositoryContext,
  plan?: TaskPlan,
): Promise<void> {
  const projection = plan ?? (await loadStoredPlan(context));
  await writeFileAtomic(context.tasksPath, `${JSON.stringify(projection, null, 2)}\n`);
}

/**
 * Reingest only the fields an execution agent is allowed to change. This is a
 * deliberate merge, not a file import: telemetry and pipeline updates made
 * while the agent ran remain authoritative in the database.
 */
export async function ingestAgentPlan(context: PlanRepositoryContext): Promise<TaskPlan> {
  const submitted = parsePlan(await readFile(context.tasksPath, 'utf-8'), context.tasksPath);
  const current = await loadStoredPlan(context);
  const submittedStories = new Map(submitted.userStories.map((story) => [story.id, story]));
  const merged: TaskPlan = {
    ...current,
    userStories: current.userStories.map((story) => {
      const change = submittedStories.get(story.id);
      return change === undefined
        ? story
        : { ...story, passes: change.passes, notes: change.notes };
    }),
  };
  await saveStoredPlan(context, merged);
  return merged;
}

/** Promote a newly generated plan after the plan phase has validated it. */
export async function ingestGeneratedPlan(context: PlanRepositoryContext): Promise<TaskPlan> {
  const plan = parsePlan(await readFile(context.tasksPath, 'utf-8'), context.tasksPath);
  await saveStoredPlan(context, plan);
  return plan;
}

function executionColumns(record: Record<string, unknown>): {
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  costStatus: string;
  costAmount: number | null;
} {
  const cost = record.cost as { status?: string; amount?: number } | undefined;
  return {
    status: String(record.status),
    startedAt: String(record.startedAt),
    finishedAt: (record.finishedAt as string | null | undefined) ?? null,
    durationMs: (record.durationMs as number | null | undefined) ?? null,
    costStatus: cost?.status ?? 'unknown',
    costAmount: cost?.status === 'unknown' ? null : (cost?.amount ?? null),
  };
}

/** Insert or update one invocation independently from the plan projection. */
export async function saveExecution(
  context: PlanRepositoryContext,
  execution: { id: string } & Record<string, unknown>,
): Promise<void> {
  await withDatabase((database) => {
    const columns = executionColumns(execution);
    database
      .prepare(
        `INSERT INTO executions
         (id, project_id, issue_id, status, started_at, finished_at, duration_ms, cost_status, cost_amount, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at,
         duration_ms = excluded.duration_ms, cost_status = excluded.cost_status, cost_amount = excluded.cost_amount,
         payload_json = excluded.payload_json`,
      )
      .run(
        execution.id,
        context.projectId,
        context.issueId,
        columns.status,
        columns.startedAt,
        columns.finishedAt,
        columns.durationMs,
        columns.costStatus,
        columns.costAmount,
        JSON.stringify(execution),
      );
  });
  // Direct library consumers historically read the projection themselves.
  // Keep that contract only for their synthetic context; real issue paths
  // intentionally leave projection refresh to the phase boundary so an
  // execution ending cannot overwrite an agent's pending file mutation.
  if (
    context.projectId.startsWith('projection-') &&
    !agentProjectionWindows.has(context.tasksPath)
  ) {
    await materializePlan(context);
  }
}

export async function loadExecution(
  context: PlanRepositoryContext,
  id: string,
): Promise<Record<string, unknown> | null> {
  return withDatabase((database) => {
    const row = database
      .prepare(
        'SELECT payload_json FROM executions WHERE id = ? AND project_id = ? AND issue_id = ?',
      )
      .get<{ payload_json: string }>(id, context.projectId, context.issueId);
    return row === undefined ? null : (JSON.parse(row.payload_json) as Record<string, unknown>);
  });
}

/** Execution history is queried directly from SQLite; tasks.json is only a projection. */
export async function listStoredExecutions(input: {
  projectId: string;
  issueId?: string;
  since?: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}): Promise<ExecutionRecord[]> {
  return withDatabase((database) => {
    const clauses = ['project_id = ?'];
    const values: string[] = [input.projectId];
    if (input.issueId !== undefined) {
      clauses.push('issue_id = ?');
      values.push(input.issueId);
    }
    if (input.since !== undefined) {
      clauses.push('started_at >= ?');
      values.push(input.since);
    }
    return database
      .prepare(
        `SELECT payload_json FROM executions WHERE ${clauses.join(' AND ')} ORDER BY started_at, rowid`,
      )
      .all<{ payload_json: string }>(...values)
      .map((row) => JSON.parse(row.payload_json) as ExecutionRecord);
  }, input.databaseOptions);
}

export interface StoredUserStoryNumber {
  number: number;
  issueId: string;
  storyId: string;
}

/** Use the relational story index for project-wide US-NNN continuity. */
export async function findHighestStoredUserStoryNumber(input: {
  projectId: string;
  excludeIssueId?: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}): Promise<StoredUserStoryNumber | null> {
  return withDatabase((database) => {
    const statement =
      input.excludeIssueId === undefined
        ? 'SELECT issue_id, id, story_number FROM stories WHERE project_id = ? AND story_number IS NOT NULL ORDER BY story_number DESC LIMIT 1'
        : 'SELECT issue_id, id, story_number FROM stories WHERE project_id = ? AND issue_id <> ? AND story_number IS NOT NULL ORDER BY story_number DESC LIMIT 1';
    const row = database
      .prepare(statement)
      .get<{ issue_id: string; id: string; story_number: number }>(
        input.projectId,
        ...(input.excludeIssueId === undefined ? [] : [input.excludeIssueId]),
      );
    return row === undefined
      ? null
      : { number: row.story_number, issueId: row.issue_id, storyId: row.id };
  }, input.databaseOptions);
}

/** A stable, JSON-friendly diagnostic export that never exposes SQL to callers. */
export async function exportStoredState(): Promise<Record<string, unknown>> {
  return withDatabase((database) => {
    const tables = [
      'projects',
      'issues',
      'pipelines',
      'stories',
      'story_dependencies',
      'runs',
      'phases',
      'executions',
      'events',
      'snapshots',
      'pull_requests',
      'reviews',
      'verifications',
      'provider_health',
      'queues',
      'queue_issues',
      'migrated_artifacts',
      'audit_log',
    ];
    return Object.fromEntries(
      tables.map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()]),
    );
  });
}
