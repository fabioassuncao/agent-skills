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
      .prepare('SELECT * FROM pipelines WHERE project_id = ? AND issue_id = ?')
      .get<Record<string, unknown>>(context.projectId, context.issueId);
    if (row === undefined) {
      throw new Error(`No SQLite task plan exists for issue ${context.issueId}. Run plan first.`);
    }
    // Version 4 is fully relational. The fallback keeps a database imported by
    // an older binary readable until its next normal plan materialization.
    if (row.project === null || row.project === undefined) {
      return parsePlan(String(row.state_json), context.tasksPath);
    }
    const dependencies = new Map<string, string[]>();
    for (const dependency of database
      .prepare(
        'SELECT story_id, depends_on_story_id FROM story_dependencies WHERE project_id = ? AND issue_id = ?',
      )
      .all<{ story_id: string; depends_on_story_id: string }>(context.projectId, context.issueId)) {
      dependencies.set(dependency.story_id, [
        ...(dependencies.get(dependency.story_id) ?? []),
        dependency.depends_on_story_id,
      ]);
    }
    const stories = database
      .prepare(
        'SELECT * FROM stories WHERE project_id = ? AND issue_id = ? ORDER BY priority, rowid',
      )
      .all<Record<string, unknown>>(context.projectId, context.issueId)
      .map((story) => ({
        id: String(story.id),
        title: String(story.title),
        description: String(story.description ?? ''),
        acceptanceCriteria: JSON.parse(String(story.acceptance_criteria_json ?? '[]')) as string[],
        priority: Number(story.priority),
        passes: Number(story.passes) === 1,
        notes: String(story.notes ?? ''),
        ...(story.duration_seconds === null
          ? {}
          : { durationSeconds: Number(story.duration_seconds) }),
        ...(story.status === null
          ? {}
          : { status: String(story.status) as TaskPlan['userStories'][number]['status'] }),
        ...(story.stage === null
          ? {}
          : { stage: String(story.stage) as TaskPlan['userStories'][number]['stage'] }),
        ...(story.stage_since === null ? {} : { stageSince: String(story.stage_since) }),
        ...(story.stage_detail === null ? {} : { stageDetail: String(story.stage_detail) }),
        ...(story.input_tokens === null ? {} : { inputTokens: Number(story.input_tokens) }),
        ...(story.output_tokens === null ? {} : { outputTokens: Number(story.output_tokens) }),
        ...(story.cache_read_tokens === null
          ? {}
          : { cacheReadTokens: Number(story.cache_read_tokens) }),
        ...(story.cache_creation_tokens === null
          ? {}
          : { cacheCreationTokens: Number(story.cache_creation_tokens) }),
        ...(dependencies.has(String(story.id))
          ? { dependencies: dependencies.get(String(story.id)) }
          : {}),
      }));
    const plan: TaskPlan = {
      project: String(row.project),
      issueNumber: String(row.issue_number),
      issueUrl: String(row.issue_url ?? ''),
      branchName: String(row.branch_name ?? ''),
      ...(Number(row.no_branch) === 1 ? { noBranch: true } : {}),
      description: String(row.description ?? ''),
      issueStatus: String(row.issue_status) as TaskPlan['issueStatus'],
      completedAt: (row.completed_at as string | null) ?? null,
      lastAttemptAt: (row.last_attempt_at as string | null) ?? null,
      lastError:
        row.last_error_category === null
          ? null
          : {
              category: String(row.last_error_category),
              message: String(row.last_error_message),
              at: String(row.last_error_at),
            },
      correctionCycle: Number(row.correction_cycle),
      maxCorrectionCycles: Number(row.max_correction_cycles),
      lastReviewFindings: (row.last_review_findings as string | null) ?? null,
      pipeline: {
        ...(Number(row.analyze_completed) === 1 ? { analyzeCompleted: true } : {}),
        prdCompleted: Number(row.prd_completed) === 1,
        jsonCompleted: Number(row.json_completed) === 1,
        executionCompleted: Number(row.execution_completed) === 1,
        reviewCompleted: Number(row.review_completed) === 1,
        prCreated: Number(row.pr_created) === 1,
        ...(Number(row.pr_review_completed) === 1 ? { prReviewCompleted: true } : {}),
      },
      ...(row.run_status === null
        ? {}
        : {
            runState: {
              status: row.run_status as TaskPlan['runState'] extends infer R
                ? R extends { status: infer S }
                  ? S
                  : never
                : never,
              currentPhase: (row.run_phase as string | null) ?? null,
              attempt: Number(row.run_attempt ?? 0),
              lastHeartbeatAt: (row.run_heartbeat_at as string | null) ?? null,
              blockedReason: (row.run_blocked_reason as string | null) ?? null,
              owner:
                row.run_owner_pid === null
                  ? null
                  : {
                      pid: Number(row.run_owner_pid),
                      host: String(row.run_owner_host),
                      startedAt: String(row.run_owner_started_at),
                    },
            },
          }),
      ...(row.pr_number === null
        ? {}
        : {
            pullRequest: {
              number: Number(row.pr_number),
              url: String(row.pr_url),
              headBranch: String(row.pr_head_branch),
              createdAt: String(row.pr_created_at),
            },
          }),
      ...(row.pr_review_enabled === null
        ? {}
        : {
            prReview: {
              enabled: Number(row.pr_review_enabled) === 1,
              rounds: Number(row.pr_review_rounds ?? 0),
              ...(row.pr_review_recommendation === null
                ? {}
                : {
                    lastRecommendation: String(row.pr_review_recommendation) as NonNullable<
                      TaskPlan['prReview']
                    >['lastRecommendation'],
                  }),
              ...(row.pr_reviewed_at === null
                ? {}
                : { lastReviewedAt: String(row.pr_reviewed_at) }),
            },
          }),
      userStories: stories,
    };
    const executions = database
      .prepare(
        'SELECT payload_json FROM executions WHERE project_id = ? AND issue_id = ? ORDER BY started_at, rowid',
      )
      .all<{ payload_json: string }>(context.projectId, context.issueId)
      .map((execution) => JSON.parse(execution.payload_json));
    return executions.length > 0 ? { ...plan, executions } : plan;
  });
}

export function writePlanRows(
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
  // `state_json` is kept as an empty compatibility column for pre-v4 database
  // files. Relational columns below are the source of truth.
  database
    .prepare(
      `INSERT INTO pipelines (project_id, issue_id, state_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, issue_id) DO UPDATE SET state_json = excluded.state_json,
       updated_at = excluded.updated_at`,
    )
    .run(context.projectId, context.issueId, '{}', timestamp);
  database
    .prepare(
      `UPDATE pipelines SET project = ?, issue_number = ?, issue_url = ?, branch_name = ?, no_branch = ?,
       description = ?, issue_status = ?, completed_at = ?, last_attempt_at = ?, last_error_category = ?,
       last_error_message = ?, last_error_at = ?, correction_cycle = ?, max_correction_cycles = ?,
       last_review_findings = ?, analyze_completed = ?, prd_completed = ?, json_completed = ?,
       execution_completed = ?, review_completed = ?, pr_created = ?, pr_review_completed = ?, run_status = ?,
       run_phase = ?, run_attempt = ?, run_heartbeat_at = ?, run_blocked_reason = ?, run_owner_pid = ?,
       run_owner_host = ?, run_owner_started_at = ?, pr_number = ?, pr_url = ?, pr_head_branch = ?,
       pr_created_at = ?, pr_review_enabled = ?, pr_review_rounds = ?, pr_review_recommendation = ?,
       pr_reviewed_at = ? WHERE project_id = ? AND issue_id = ?`,
    )
    .run(
      plan.project,
      String(plan.issueNumber),
      plan.issueUrl,
      plan.branchName,
      plan.noBranch === true ? 1 : 0,
      plan.description,
      plan.issueStatus,
      plan.completedAt,
      plan.lastAttemptAt,
      plan.lastError?.category ?? null,
      plan.lastError?.message ?? null,
      plan.lastError?.at ?? null,
      plan.correctionCycle,
      plan.maxCorrectionCycles,
      plan.lastReviewFindings,
      plan.pipeline.analyzeCompleted === true ? 1 : 0,
      plan.pipeline.prdCompleted ? 1 : 0,
      plan.pipeline.jsonCompleted ? 1 : 0,
      plan.pipeline.executionCompleted ? 1 : 0,
      plan.pipeline.reviewCompleted ? 1 : 0,
      plan.pipeline.prCreated ? 1 : 0,
      plan.pipeline.prReviewCompleted === true ? 1 : 0,
      plan.runState?.status ?? null,
      plan.runState?.currentPhase ?? null,
      plan.runState?.attempt ?? null,
      plan.runState?.lastHeartbeatAt ?? null,
      plan.runState?.blockedReason ?? null,
      plan.runState?.owner?.pid ?? null,
      plan.runState?.owner?.host ?? null,
      plan.runState?.owner?.startedAt ?? null,
      plan.pullRequest?.number ?? null,
      plan.pullRequest?.url ?? null,
      plan.pullRequest?.headBranch ?? null,
      plan.pullRequest?.createdAt ?? null,
      plan.prReview?.enabled === true ? 1 : 0,
      plan.prReview?.rounds ?? null,
      plan.prReview?.lastRecommendation ?? null,
      plan.prReview?.lastReviewedAt ?? null,
      context.projectId,
      context.issueId,
    );

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
    database
      .prepare(
        `UPDATE stories SET description = ?, acceptance_criteria_json = ?, duration_seconds = ?, status = ?,
         stage = ?, stage_since = ?, stage_detail = ?, input_tokens = ?, output_tokens = ?,
         cache_read_tokens = ?, cache_creation_tokens = ? WHERE project_id = ? AND issue_id = ? AND id = ?`,
      )
      .run(
        story.description,
        JSON.stringify(story.acceptanceCriteria),
        story.durationSeconds ?? null,
        story.status ?? null,
        story.stage ?? null,
        story.stageSince ?? null,
        story.stageDetail ?? null,
        story.inputTokens ?? null,
        story.outputTokens ?? null,
        story.cacheReadTokens ?? null,
        story.cacheCreationTokens ?? null,
        context.projectId,
        context.issueId,
        story.id,
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
    const agent = execution.agent as Record<string, unknown> | undefined;
    const model = agent?.model as Record<string, unknown> | undefined;
    const usage = execution.usage as Record<string, unknown> | null | undefined;
    database
      .prepare(
        `UPDATE executions SET session_id = ?, purpose = ?, attempt = ?, trigger = ?, trigger_reason = ?,
         input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?, reasoning_tokens = ?,
         harness = ?, provider = ?, model_requested = ?, model_resolved = ? WHERE id = ?`,
      )
      .run(
        (execution.sessionId as string | null | undefined) ?? null,
        (execution.purpose as string | undefined) ?? null,
        (execution.attempt as number | undefined) ?? null,
        (execution.trigger as string | undefined) ?? null,
        (execution.triggerReason as string | null | undefined) ?? null,
        (usage?.inputTokens as number | undefined) ?? null,
        (usage?.outputTokens as number | undefined) ?? null,
        (usage?.cacheReadTokens as number | undefined) ?? null,
        (usage?.cacheCreationTokens as number | undefined) ?? null,
        (usage?.reasoningTokens as number | undefined) ?? null,
        (agent?.harness as string | undefined) ?? null,
        (agent?.provider as string | null | undefined) ?? null,
        (model?.requested as string | null | undefined) ?? null,
        (model?.resolved as string | null | undefined) ?? null,
        execution.id,
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
