import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { SessionEvent, SessionSnapshot } from '../../core/session-state.js';
import type { ExecutionPlan } from '../../execution/types.js';
import { taskPlanSchema } from '../../schemas.js';
import type { ExecutionRecord } from '../../telemetry/types.js';
import type { TaskPlan } from '../../types.js';
import { writeFileAtomic } from '../../utils/fs.js';
import type {
  ProviderHealthRecord,
  ProvidersHealth,
  UserStoryNumberingDecision,
} from '../schemas.js';
import {
  databaseOptionsForProject,
  type OpenIssueFlowDatabaseOptions,
  openIssueFlowDatabase,
} from './index.js';

/** Identity needed to address one plan in the shared SQLite database. */
export interface PlanRepositoryContext {
  tasksPath: string;
  projectId: string;
  issueId: string;
  projectRoot: string;
  /** Test/embedding seam for a non-default Issue Flow home. */
  databaseOptions?: OpenIssueFlowDatabaseOptions;
  /** Explicit row retention. Omitted values retain history indefinitely. */
  retention?: StoredRetentionPolicy;
}

export interface StoredRetentionPolicy {
  executions?: number;
  events?: number;
  snapshots?: number;
}

/** Identity for one multi-issue queue projection in the shared database. */
export interface QueueRepositoryContext {
  planFile: string;
  projectId: string;
  projectRoot: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
  retention?: StoredRetentionPolicy;
}

const contexts = new Map<string, PlanRepositoryContext>();
const providerHealthContexts = new Map<string, PlanRepositoryContext>();
const verificationContexts = new Map<string, PlanRepositoryContext>();
const lastBranchContexts = new Map<string, PlanRepositoryContext>();
const queueContexts = new Map<string, QueueRepositoryContext>();
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

/** Register the JSON compatibility projection for a multi-issue queue. */
export function registerQueueRepository(context: QueueRepositoryContext): void {
  queueContexts.set(context.planFile, context);
}

export function getQueueRepository(path: string): QueueRepositoryContext | undefined {
  return queueContexts.get(path);
}

/** Register project- and issue-level compatibility projections with their canonical store. */
export function registerStorageProjections(input: {
  context: PlanRepositoryContext;
  providersHealthFile?: string;
  verifyFile?: string;
  lastBranchFile?: string;
}): void {
  if (input.providersHealthFile !== undefined) {
    providerHealthContexts.set(input.providersHealthFile, input.context);
  }
  if (input.verifyFile !== undefined) verificationContexts.set(input.verifyFile, input.context);
  if (input.lastBranchFile !== undefined)
    lastBranchContexts.set(input.lastBranchFile, input.context);
}

export function getProviderHealthRepository(path: string): PlanRepositoryContext | undefined {
  return providerHealthContexts.get(path);
}

export function getVerificationRepository(path: string): PlanRepositoryContext | undefined {
  return verificationContexts.get(path);
}

export function getLastBranchRepository(path: string): PlanRepositoryContext | undefined {
  return lastBranchContexts.get(path);
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
  providerHealthContexts.clear();
  verificationContexts.clear();
  lastBranchContexts.clear();
  queueContexts.clear();
  agentProjectionWindows.clear();
}

/** Apply only an explicitly configured, positive row limit for one project. */
function applyStoredRetention(
  database: Awaited<ReturnType<typeof openIssueFlowDatabase>>,
  projectId: string,
  retention: StoredRetentionPolicy | undefined,
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

function ensureStoredProject(
  database: Awaited<ReturnType<typeof openIssueFlowDatabase>>,
  context: PlanRepositoryContext,
  timestamp: string,
): void {
  database
    .prepare(
      // `last_seen_at` is what makes a project that only ever ran — never
      // curated — sort into the dashboard's "recent" list (§47.3). The row was
      // always created here; before the registry there was simply nothing that
      // could tell one dormant project from another.
      `INSERT INTO projects (id, root, remote_url, created_at, updated_at, last_seen_at)
       VALUES (?, ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET root = excluded.root, updated_at = excluded.updated_at,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(context.projectId, context.projectRoot, timestamp, timestamp, timestamp);
}

/**
 * Evidence and other issue-scoped facts can arrive before the plan phase has
 * materialized a canonical pipeline. Keep those writes relationally valid
 * without making the evidence writer parse or create a task-plan projection.
 * A later plan write replaces this placeholder with the plan's own status and
 * descriptive fields.
 */
function ensureStoredIssue(
  database: Awaited<ReturnType<typeof openIssueFlowDatabase>>,
  context: PlanRepositoryContext,
  timestamp: string,
): void {
  database
    .prepare(
      `INSERT INTO issues (project_id, id, title, status, branch_name, created_at, updated_at)
       VALUES (?, ?, NULL, 'pending', NULL, ?, ?)
       ON CONFLICT(project_id, id) DO NOTHING`,
    )
    .run(context.projectId, context.issueId, timestamp, timestamp);
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
      ...(row.close_issue == null ? {} : { closeIssue: Number(row.close_issue) === 1 }),
      ...(row.issue_closed_at == null ? {} : { issueClosedAt: String(row.issue_closed_at) }),
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
        ...(row.pr_review_completed === null
          ? {}
          : { prReviewCompleted: Number(row.pr_review_completed) === 1 }),
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
              ...(row.pr_review_pull_request_number === null
                ? {}
                : { pullRequestNumber: Number(row.pr_review_pull_request_number) }),
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
  }, context.databaseOptions);
}

export function writePlanRows(
  database: Awaited<ReturnType<typeof openIssueFlowDatabase>>,
  context: PlanRepositoryContext,
  plan: TaskPlan,
): void {
  const timestamp = plan.lastAttemptAt ?? new Date().toISOString();
  database
    .prepare(
      // `last_seen_at` is what makes a project that only ever ran — never
      // curated — sort into the dashboard's "recent" list (§47.3). The row was
      // always created here; before the registry there was simply nothing that
      // could tell one dormant project from another.
      `INSERT INTO projects (id, root, remote_url, created_at, updated_at, last_seen_at)
       VALUES (?, ?, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET root = excluded.root, updated_at = excluded.updated_at,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(context.projectId, context.projectRoot, timestamp, timestamp, timestamp);
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
       pr_created_at = ?, pr_review_enabled = ?, pr_review_pull_request_number = ?, pr_review_rounds = ?,
       pr_review_recommendation = ?, pr_reviewed_at = ?, close_issue = ?, issue_closed_at = ? WHERE project_id = ? AND issue_id = ?`,
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
      plan.pipeline.prReviewCompleted === undefined
        ? null
        : plan.pipeline.prReviewCompleted
          ? 1
          : 0,
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
      plan.prReview === undefined ? null : plan.prReview.enabled ? 1 : 0,
      plan.prReview?.pullRequestNumber ?? null,
      plan.prReview?.rounds ?? null,
      plan.prReview?.lastRecommendation ?? null,
      plan.prReview?.lastReviewedAt ?? null,
      plan.closeIssue === undefined ? null : plan.closeIssue ? 1 : 0,
      plan.issueClosedAt ?? null,
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

  if (plan.pullRequest !== undefined) {
    const pullRequestId = `pr:${context.projectId}:${context.issueId}:${plan.pullRequest.number}`;
    database
      .prepare(
        `INSERT INTO pull_requests (id, project_id, issue_id, number, url, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET url = excluded.url, status = excluded.status`,
      )
      .run(
        pullRequestId,
        context.projectId,
        context.issueId,
        plan.pullRequest.number,
        plan.pullRequest.url,
        plan.pipeline.prCreated ? 'created' : 'pending',
        plan.pullRequest.createdAt,
      );
    if (plan.prReview?.lastReviewedAt !== undefined) {
      database
        .prepare(
          `INSERT INTO reviews (id, pull_request_id, status, created_at, payload_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, created_at = excluded.created_at,
             payload_json = excluded.payload_json`,
        )
        .run(
          `review:${pullRequestId}:${plan.prReview.rounds}`,
          pullRequestId,
          plan.prReview.lastRecommendation ?? 'unknown',
          plan.prReview.lastReviewedAt,
          JSON.stringify(plan.prReview),
        );
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
  const content = `${JSON.stringify(projection, null, 2)}\n`;
  await writeFileAtomic(context.tasksPath, content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  await withDatabase(
    (database) =>
      database
        .prepare(
          `INSERT INTO migrated_artifacts (source_path, sha256, migrated_at, table_counts_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source_path) DO UPDATE SET sha256 = excluded.sha256,
             migrated_at = excluded.migrated_at, table_counts_json = excluded.table_counts_json`,
        )
        .run(context.tasksPath, sha256, new Date().toISOString(), '{}'),
    context.databaseOptions,
  );
}

/** Persist a queue's coordination state before refreshing its readable projection. */
export async function saveStoredQueue(
  context: QueueRepositoryContext,
  plan: ExecutionPlan,
): Promise<void> {
  await withDatabase(
    (database) =>
      database.transaction(() => {
        ensureStoredProject(
          database,
          {
            tasksPath: '',
            projectId: context.projectId,
            issueId: '',
            projectRoot: context.projectRoot,
          },
          plan.updatedAt,
        );
        database
          .prepare(
            `INSERT INTO queues (id, project_id, status, payload_json, created_at, updated_at,
              requested_json, branch_name, no_branch, pr_review, truncated)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json,
               updated_at = excluded.updated_at, requested_json = excluded.requested_json,
               branch_name = excluded.branch_name, no_branch = excluded.no_branch,
               pr_review = excluded.pr_review, truncated = excluded.truncated`,
          )
          .run(
            plan.id,
            context.projectId,
            plan.status,
            JSON.stringify(plan),
            plan.createdAt,
            plan.updatedAt,
            JSON.stringify(plan.requested),
            plan.branchName,
            plan.noBranch ? 1 : 0,
            plan.prReview ? 1 : 0,
            plan.truncated ? 1 : 0,
          );
        database.prepare('DELETE FROM queue_dependencies WHERE queue_id = ?').run(plan.id);
        database.prepare('DELETE FROM queue_issues WHERE queue_id = ?').run(plan.id);
        for (const entry of plan.issues) {
          database
            .prepare(
              `INSERT INTO issues (project_id, id, title, status, branch_name, created_at, updated_at)
               VALUES (?, ?, ?, ?, NULL, ?, ?)
               ON CONFLICT(project_id, id) DO UPDATE SET title = excluded.title, status = excluded.status,
                 updated_at = excluded.updated_at`,
            )
            .run(
              context.projectId,
              entry.id,
              entry.title,
              entry.status,
              plan.createdAt,
              plan.updatedAt,
            );
          database
            .prepare(
              `INSERT INTO queue_issues (queue_id, project_id, issue_id, position, status, number, title, url,
                source, origin, role, priority, heuristic, failed_phase, last_error_category,
                last_error_message, last_error_at, attempts, blocked_reason, started_at, completed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              plan.id,
              context.projectId,
              entry.id,
              entry.position,
              entry.status,
              entry.number,
              entry.title,
              entry.url,
              entry.source,
              entry.origin,
              entry.role,
              entry.priority,
              entry.heuristic ? 1 : 0,
              entry.failedPhase,
              entry.lastError?.category ?? null,
              entry.lastError?.message ?? null,
              entry.lastError?.at ?? null,
              entry.attempts,
              entry.blockedReason,
              entry.startedAt,
              entry.completedAt,
            );
          for (const dependency of entry.dependsOn) {
            database
              .prepare(
                'INSERT INTO queue_dependencies (queue_id, issue_id, depends_on_issue_id) VALUES (?, ?, ?)',
              )
              .run(plan.id, entry.id, dependency);
          }
        }
      }),
    context.databaseOptions,
  );
  await mkdir(dirname(context.planFile), { recursive: true });
  await writeFileAtomic(context.planFile, `${JSON.stringify(plan, null, 2)}\n`);
}

/** Load the canonical queue. The projection remains only for older JSON mode callers. */
export async function loadStoredQueue(
  context: QueueRepositoryContext,
): Promise<ExecutionPlan | null> {
  return withDatabase((database) => {
    const row = database
      .prepare('SELECT payload_json FROM queues WHERE id = ? AND project_id = ?')
      .get<{ payload_json: string }>(
        context.planFile === '' ? '' : basename(dirname(context.planFile)),
        context.projectId,
      );
    return row === undefined ? null : (JSON.parse(row.payload_json) as ExecutionPlan);
  }, context.databaseOptions);
}

/**
 * Reingest only the fields an execution agent is allowed to change. This is a
 * deliberate merge, not a file import: telemetry and pipeline updates made
 * while the agent ran remain authoritative in the database.
 */
export async function ingestAgentPlan(
  context: PlanRepositoryContext,
  baseline?: Pick<TaskPlan, 'lastReviewFindings' | 'lastError'>,
): Promise<TaskPlan> {
  const submitted = parsePlan(await readFile(context.tasksPath, 'utf-8'), context.tasksPath);
  await withDatabase(
    (database) =>
      database.transaction(() => {
        for (const story of submitted.userStories) {
          database
            .prepare(
              'UPDATE stories SET passes = ?, notes = ? WHERE project_id = ? AND issue_id = ? AND id = ?',
            )
            .run(story.passes ? 1 : 0, story.notes, context.projectId, context.issueId, story.id);
        }
        if (baseline !== undefined) {
          // A correction can acknowledge its own findings, never erase a newer review.
          if (submitted.lastReviewFindings === null) {
            database
              .prepare(
                'UPDATE pipelines SET last_review_findings = NULL WHERE project_id = ? AND issue_id = ? AND last_review_findings IS ?',
              )
              .run(context.projectId, context.issueId, baseline.lastReviewFindings);
          }
          database
            .prepare(
              `UPDATE pipelines SET last_error_category = ?, last_error_message = ?, last_error_at = ?
         WHERE project_id = ? AND issue_id = ? AND last_error_category IS ? AND last_error_message IS ? AND last_error_at IS ?`,
            )
            .run(
              submitted.lastError?.category ?? null,
              submitted.lastError?.message ?? null,
              submitted.lastError?.at ?? null,
              context.projectId,
              context.issueId,
              baseline.lastError?.category ?? null,
              baseline.lastError?.message ?? null,
              baseline.lastError?.at ?? null,
            );
        }
      }),
    context.databaseOptions,
  );
  const merged = await loadStoredPlan(context);
  await materializePlan(context, merged);
  return merged;
}

/** Promote a newly generated plan after the plan phase has validated it. */
export async function ingestGeneratedPlan(context: PlanRepositoryContext): Promise<TaskPlan> {
  const plan = parsePlan(await readFile(context.tasksPath, 'utf-8'), context.tasksPath);
  // Generated output cannot grant/revoke CLI authorization or fake confirmation.
  const current = await loadStoredPlan(context).catch((error: unknown) => {
    if (error instanceof Error && error.message.startsWith('No SQLite task plan exists'))
      return null;
    throw error;
  });
  delete plan.closeIssue;
  delete plan.issueClosedAt;
  if (current?.closeIssue !== undefined) plan.closeIssue = current.closeIssue;
  if (current?.issueClosedAt !== undefined) plan.issueClosedAt = current.issueClosedAt;
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
  await withDatabase(
    (database) =>
      database.transaction(() => {
        const columns = executionColumns(execution);
        const agent = execution.agent as Record<string, unknown> | undefined;
        const model = agent?.model as Record<string, unknown> | undefined;
        const usage = execution.usage as Record<string, unknown> | null | undefined;
        const runId = (execution.sessionId as string | null | undefined) ?? execution.id;
        const phaseId = `phase:${runId}:${String(execution.purpose ?? 'unknown')}`;
        // Documentation phases can invoke telemetry before a task plan exists.
        // Keep every relation valid in the same transaction as the execution.
        ensureStoredProject(database, context, columns.startedAt);
        ensureStoredIssue(database, context, columns.startedAt);
        database
          .prepare(
            `INSERT INTO runs (id, project_id, issue_id, status, started_at, finished_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at`,
          )
          .run(
            runId,
            context.projectId,
            context.issueId,
            columns.status,
            columns.startedAt,
            columns.finishedAt,
            (execution.sessionId as string | null | undefined) ?? null,
          );
        database
          .prepare(
            `INSERT INTO phases
         (id, run_id, name, status, started_at, finished_at, duration_ms, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, cost_status, cost_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at,
           duration_ms = excluded.duration_ms, input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens,
           cache_creation_tokens = excluded.cache_creation_tokens, cost_status = excluded.cost_status,
           cost_amount = excluded.cost_amount`,
          )
          .run(
            phaseId,
            runId,
            String(execution.purpose ?? 'unknown'),
            columns.status,
            columns.startedAt,
            columns.finishedAt,
            columns.durationMs,
            (usage?.inputTokens as number | undefined) ?? null,
            (usage?.outputTokens as number | undefined) ?? null,
            (usage?.cacheReadTokens as number | undefined) ?? null,
            (usage?.cacheCreationTokens as number | undefined) ?? null,
            columns.costStatus,
            columns.costAmount,
          );
        database
          .prepare(
            `INSERT INTO executions
         (id, project_id, issue_id, run_id, phase_id, status, started_at, finished_at, duration_ms, cost_status, cost_amount, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at,
         duration_ms = excluded.duration_ms, cost_status = excluded.cost_status, cost_amount = excluded.cost_amount,
         payload_json = excluded.payload_json`,
          )
          .run(
            execution.id,
            context.projectId,
            context.issueId,
            runId,
            phaseId,
            columns.status,
            columns.startedAt,
            columns.finishedAt,
            columns.durationMs,
            columns.costStatus,
            columns.costAmount,
            JSON.stringify(execution),
          );
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
        applyStoredRetention(database, context.projectId, context.retention);
      }),
    context.databaseOptions,
  );
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

/** Provider breaker state is a project-scoped canonical record, not a JSON file. */
export async function readStoredProvidersHealth(
  context: PlanRepositoryContext,
): Promise<ProvidersHealth> {
  return withDatabase((database) => {
    const providers = Object.fromEntries(
      database
        .prepare('SELECT provider, payload_json FROM provider_health WHERE project_id = ?')
        .all<{ provider: string; payload_json: string }>(context.projectId)
        .map((row) => [row.provider, JSON.parse(row.payload_json) as ProviderHealthRecord]),
    );
    return { schemaVersion: 1, providers };
  }, context.databaseOptions);
}

/** Apply one health transition under SQLite's write transaction. */
export async function updateStoredProviderHealth(
  context: PlanRepositoryContext,
  provider: string,
  update: (record: ProviderHealthRecord) => ProviderHealthRecord,
): Promise<ProviderHealthRecord> {
  return withDatabase(
    (database) =>
      database.transaction(() => {
        const updatedAt = new Date().toISOString();
        ensureStoredProject(database, context, updatedAt);
        const previous = database
          .prepare('SELECT payload_json FROM provider_health WHERE project_id = ? AND provider = ?')
          .get<{ payload_json: string }>(context.projectId, provider);
        const current: ProviderHealthRecord =
          previous === undefined
            ? {
                status: 'healthy',
                failures: [],
                consecutiveFailures: 0,
                cooldownLevel: 0,
                cooldownUntil: null,
                lastFailureKind: null,
                lastFailureAt: null,
                lastSuccessAt: null,
                probeInFlight: false,
                probeStartedAt: null,
              }
            : (JSON.parse(previous.payload_json) as ProviderHealthRecord);
        const next = update(current);
        database
          .prepare(
            `INSERT INTO provider_health
           (project_id, provider, payload_json, updated_at, status, consecutive_failures, cooldown_level,
            cooldown_until, last_failure_kind, last_failure_at, last_success_at, probe_in_flight, probe_started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, provider) DO UPDATE SET payload_json = excluded.payload_json,
             updated_at = excluded.updated_at, status = excluded.status,
             consecutive_failures = excluded.consecutive_failures, cooldown_level = excluded.cooldown_level,
             cooldown_until = excluded.cooldown_until, last_failure_kind = excluded.last_failure_kind,
             last_failure_at = excluded.last_failure_at, last_success_at = excluded.last_success_at,
             probe_in_flight = excluded.probe_in_flight, probe_started_at = excluded.probe_started_at`,
          )
          .run(
            context.projectId,
            provider,
            JSON.stringify(next),
            updatedAt,
            next.status,
            next.consecutiveFailures,
            next.cooldownLevel,
            next.cooldownUntil,
            next.lastFailureKind,
            next.lastFailureAt,
            next.lastSuccessAt,
            next.probeInFlight ? 1 : 0,
            next.probeStartedAt,
          );
        database
          .prepare('DELETE FROM provider_health_failures WHERE project_id = ? AND provider = ?')
          .run(context.projectId, provider);
        for (const failure of next.failures) {
          database
            .prepare(
              `INSERT INTO provider_health_failures (project_id, provider, occurred_at, kind)
             VALUES (?, ?, ?, ?)`,
            )
            .run(context.projectId, provider, failure.at, failure.kind);
        }
        return next;
      }),
    context.databaseOptions,
  );
}

/** Append a verification result while its JSON file remains a readable projection. */
export async function saveStoredVerification(
  context: PlanRepositoryContext,
  evidence: Record<string, unknown>,
): Promise<void> {
  await withDatabase((database) => {
    database.transaction(() => {
      const createdAt = String(evidence.at ?? new Date().toISOString());
      ensureStoredProject(database, context, createdAt);
      ensureStoredIssue(database, context, createdAt);
      database
        .prepare(
          `INSERT INTO verifications (id, project_id, issue_id, status, created_at, payload_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          context.projectId,
          context.issueId,
          String(evidence.verdict ?? 'unknown'),
          createdAt,
          JSON.stringify(evidence),
        );
    });
  }, context.databaseOptions);
}

/** Branch changes are audit events; the compatibility dotfile is never authoritative. */
export async function loadStoredLastBranch(context: PlanRepositoryContext): Promise<string | null> {
  return withDatabase((database) => {
    const row = database
      .prepare(
        `SELECT payload_json FROM audit_log WHERE project_id = ? AND action = ?
         ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
      )
      .get<{ payload_json: string }>(context.projectId, `last_branch:${context.issueId}`);
    if (row === undefined) return null;
    const payload = JSON.parse(row.payload_json) as { branch?: unknown };
    return typeof payload.branch === 'string' && payload.branch !== '' ? payload.branch : null;
  }, context.databaseOptions);
}

export async function saveStoredLastBranch(
  context: PlanRepositoryContext,
  branch: string,
): Promise<void> {
  await withDatabase((database) => {
    database.transaction(() => {
      const occurredAt = new Date().toISOString();
      ensureStoredProject(database, context, occurredAt);
      database
        .prepare(
          `INSERT INTO audit_log (id, project_id, occurred_at, action, payload_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          context.projectId,
          occurredAt,
          `last_branch:${context.issueId}`,
          JSON.stringify({ branch }),
        );
    });
  }, context.databaseOptions);
}

/** Store the project-wide numbering audit beside the indexed story history. */
export async function saveStoredUserStoryNumbering(
  context: Pick<PlanRepositoryContext, 'projectId' | 'projectRoot' | 'databaseOptions'>,
  decision: UserStoryNumberingDecision,
): Promise<void> {
  await withDatabase((database) => {
    database.transaction(() => {
      ensureStoredProject(database, { ...context, tasksPath: '', issueId: '' }, decision.decidedAt);
      database
        .prepare(
          `INSERT INTO user_story_numbering (project_id, next_number, source, issue_id, decided_at, detail)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET next_number = excluded.next_number,
             source = excluded.source, issue_id = excluded.issue_id, decided_at = excluded.decided_at,
             detail = excluded.detail`,
        )
        .run(
          context.projectId,
          decision.nextNumber,
          decision.source,
          decision.issueNumber,
          decision.decidedAt,
          decision.detail ?? null,
        );
    });
  }, context.databaseOptions);
}

/** A current session snapshot and its indexed identity for monitor readers. */
export interface StoredSession {
  projectId: string;
  issueId: string;
  sessionId: string;
  snapshot: SessionSnapshot;
  updatedAt: string;
}

/**
 * Persist one reduced session event and its resulting projection together.
 *
 * The session publisher deliberately queues this work after its synchronous
 * reducer has accepted the event, so monitoring storage can never interrupt a
 * pipeline. The event sequence is the publisher version and is unique per run.
 */
export async function saveSessionEvent(
  context: PlanRepositoryContext,
  input: { sessionId: string; sequence: number; event: SessionEvent; snapshot: SessionSnapshot },
): Promise<void> {
  await withDatabase(
    (database) =>
      database.transaction(() => {
        const updatedAt = input.snapshot.updatedAt ?? input.event.at;
        const startedAt = input.snapshot.startedAt ?? input.event.at;
        database
          .prepare(
            `INSERT INTO projects (id, root, remote_url, created_at, updated_at, last_seen_at)
             VALUES (?, ?, NULL, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET root = excluded.root, updated_at = excluded.updated_at,
               last_seen_at = excluded.last_seen_at`,
          )
          .run(context.projectId, context.projectRoot, startedAt, updatedAt, updatedAt);
        database
          .prepare(
            `INSERT INTO issues (project_id, id, title, status, branch_name, created_at, updated_at)
             VALUES (?, ?, NULL, ?, NULL, ?, ?)
             ON CONFLICT(project_id, id) DO UPDATE SET updated_at = excluded.updated_at`,
          )
          .run(context.projectId, context.issueId, 'in_progress', startedAt, updatedAt);
        database
          .prepare(
            `INSERT INTO runs (id, project_id, issue_id, status, started_at, finished_at, session_id, heartbeat_at, pid, host)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at,
             heartbeat_at = excluded.heartbeat_at, pid = excluded.pid, host = excluded.host`,
          )
          .run(
            input.sessionId,
            context.projectId,
            context.issueId,
            input.snapshot.status,
            startedAt,
            input.snapshot.endedAt,
            input.sessionId,
            updatedAt,
            process.pid,
            process.env.HOSTNAME ?? null,
          );
        database
          .prepare(
            `INSERT INTO events (id, project_id, run_id, occurred_at, kind, payload_json, session_id, sequence)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            context.projectId,
            input.sessionId,
            input.event.at,
            input.event.type,
            JSON.stringify(input.event),
            input.sessionId,
            input.sequence,
          );
        database
          .prepare(
            `INSERT INTO snapshots (id, project_id, run_id, created_at, payload_json, issue_id, session_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            context.projectId,
            input.sessionId,
            updatedAt,
            JSON.stringify(input.snapshot),
            context.issueId,
            input.sessionId,
            updatedAt,
          );
        applyStoredRetention(database, context.projectId, context.retention);
      }),
    context.databaseOptions,
  );
}

/** Read the most recent snapshot for every session active within a time window. */
export async function listStoredSessions(input: {
  activeSince: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}): Promise<StoredSession[]> {
  return withDatabase((database) => {
    return database
      .prepare(
        `SELECT project_id, issue_id, session_id, payload_json, updated_at FROM snapshots AS current
         WHERE current.session_id IS NOT NULL AND current.updated_at >= ?
         AND current.id = (
           SELECT newer.id FROM snapshots AS newer
           WHERE newer.project_id = current.project_id AND newer.session_id = current.session_id
           ORDER BY newer.updated_at DESC, newer.rowid DESC LIMIT 1
         )
         ORDER BY current.updated_at DESC, current.rowid DESC`,
      )
      .all<{
        project_id: string;
        issue_id: string;
        session_id: string;
        payload_json: string;
        updated_at: string;
      }>(input.activeSince)
      .map((row) => ({
        projectId: row.project_id,
        issueId: row.issue_id,
        sessionId: row.session_id,
        snapshot: JSON.parse(row.payload_json) as SessionSnapshot,
        updatedAt: row.updated_at,
      }));
  }, input.databaseOptions);
}

/** Latest snapshot for each durable run, used to enrich the live lock registry. */
export async function listStoredRunSnapshots(
  input: { databaseOptions?: OpenIssueFlowDatabaseOptions } = {},
): Promise<StoredSession[]> {
  return withDatabase((database) => {
    return database
      .prepare(
        `SELECT run.project_id, run.issue_id, run.session_id, snapshot.payload_json, snapshot.updated_at
         FROM runs AS run
         JOIN snapshots AS snapshot ON snapshot.id = (
           SELECT latest.id FROM snapshots AS latest
           WHERE latest.run_id = run.id ORDER BY latest.updated_at DESC, latest.rowid DESC LIMIT 1
         )
         WHERE run.session_id IS NOT NULL`,
      )
      .all<{
        project_id: string;
        issue_id: string;
        session_id: string;
        payload_json: string;
        updated_at: string;
      }>()
      .map((row) => ({
        projectId: row.project_id,
        issueId: row.issue_id,
        sessionId: row.session_id,
        snapshot: JSON.parse(row.payload_json) as SessionSnapshot,
        updatedAt: row.updated_at,
      }));
  }, input.databaseOptions);
}

/** Event history for one monitor session, in its original publisher order. */
export async function listStoredSessionEvents(input: {
  projectId: string;
  sessionId: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}): Promise<Array<{ seq: number; event: SessionEvent }>> {
  return withDatabase(
    (database) =>
      database
        .prepare(
          `SELECT sequence, payload_json FROM events
         WHERE project_id = ? AND session_id = ? ORDER BY sequence, rowid`,
        )
        .all<{ sequence: number; payload_json: string }>(input.projectId, input.sessionId)
        .map((row) => ({ seq: row.sequence, event: JSON.parse(row.payload_json) as SessionEvent })),
    input.databaseOptions,
  );
}

/** Keep a quiet, live session discoverable without creating a synthetic event. */
export async function touchStoredSession(
  context: PlanRepositoryContext,
  sessionId: string,
  updatedAt = new Date().toISOString(),
): Promise<void> {
  await withDatabase((database) => {
    database.transaction(() => {
      database
        .prepare('UPDATE runs SET heartbeat_at = ? WHERE id = ? AND project_id = ?')
        .run(updatedAt, sessionId, context.projectId);
      const latest = database
        .prepare(
          `SELECT id FROM snapshots WHERE project_id = ? AND session_id = ?
           ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
        )
        .get<{ id: string }>(context.projectId, sessionId);
      if (latest !== undefined) {
        database
          .prepare('UPDATE snapshots SET updated_at = ? WHERE id = ?')
          .run(updatedAt, latest.id);
      }
    });
  }, context.databaseOptions);
}

/**
 * Persist one agent lifecycle event reported by a hook.
 *
 * The upstream this is absorbed from keeps these in memory (§2.5). Writing them
 * down is the point of the difference: an `awaiting_input` that happened while
 * no monitor was open is exactly the one worth being able to look up.
 *
 * Never rejects. This runs inside a handler on the agent's hot path, and a
 * storage failure may not become an agent failure.
 */
export async function recordAgentEvent(
  context: PlanRepositoryContext,
  input: {
    runId: string;
    phase: string;
    type: string;
    lifecycle?: string | null;
    payload: unknown;
    occurredAt: string;
  },
): Promise<void> {
  await withDatabase((database) => {
    database
      .prepare(
        `INSERT INTO agent_events
           (id, project_id, run_id, phase, type, lifecycle, payload_json, occurred_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        context.projectId,
        input.runId,
        input.phase,
        input.type,
        input.lifecycle ?? null,
        JSON.stringify(input.payload),
        input.occurredAt,
        new Date().toISOString(),
      );
  }, context.databaseOptions);
}

export interface StoredAgentEvent {
  runId: string;
  phase: string;
  type: string;
  lifecycle: string | null;
  payload: unknown;
  occurredAt: string;
  recordedAt: string;
}

/** Lifecycle history of one run, oldest first. */
export async function listAgentEvents(input: {
  projectId: string;
  runId: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}): Promise<StoredAgentEvent[]> {
  return withDatabase(
    (database) =>
      database
        .prepare(
          `SELECT run_id, phase, type, lifecycle, payload_json, occurred_at, recorded_at
             FROM agent_events WHERE project_id = ? AND run_id = ?
            ORDER BY occurred_at, rowid`,
        )
        .all<{
          run_id: string;
          phase: string;
          type: string;
          lifecycle: string | null;
          payload_json: string;
          occurred_at: string;
          recorded_at: string;
        }>(input.projectId, input.runId)
        .map((row) => ({
          runId: row.run_id,
          phase: row.phase,
          type: row.type,
          lifecycle: row.lifecycle,
          payload: JSON.parse(row.payload_json) as unknown,
          occurredAt: row.occurred_at,
          recordedAt: row.recorded_at,
        })),
    input.databaseOptions,
  );
}

export interface StoredWorktree {
  worktreeId: string;
  branch: string;
  path: string;
  baseBranch: string | null;
  label: string | null;
  profile: string;
  agent: string;
  runtime: 'host' | 'docker';
  startupEnvValues: Record<string, string>;
  allocatedPorts: Record<string, number>;
  source: string | null;
  conversationId: string | null;
  /** Absent only in legacy/test callers; persisted and read back as false. */
  archived?: boolean;
  /** Active AgentSession tab in this worktree. Null/absent means the root. */
  activeAgentSessionId?: string | null;
  /** Monotonic allocator for fork labels; deleted sequences are not reused. */
  tabSequenceCounter?: number;
  createdAt: string;
  updatedAt: string;
}

function toStoredWorktree(row: {
  id: string;
  branch: string;
  path: string;
  base_branch: string | null;
  label: string | null;
  profile: string;
  agent: string;
  runtime: string;
  startup_env_json: string;
  allocated_ports_json: string;
  source: string | null;
  conversation_id: string | null;
  archived: number;
  active_agent_session_id: string | null;
  tab_sequence_counter: number;
  created_at: string;
  updated_at: string;
}): StoredWorktree {
  return {
    worktreeId: row.id,
    branch: row.branch,
    path: row.path,
    baseBranch: row.base_branch,
    label: row.label,
    profile: row.profile,
    agent: row.agent,
    runtime: row.runtime === 'docker' ? 'docker' : 'host',
    startupEnvValues: JSON.parse(row.startup_env_json) as Record<string, string>,
    allocatedPorts: JSON.parse(row.allocated_ports_json) as Record<string, number>,
    source: row.source,
    conversationId: row.conversation_id,
    archived: row.archived === 1,
    activeAgentSessionId: row.active_agent_session_id,
    tabSequenceCounter: row.tab_sequence_counter,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Read order, shared by every worktree query so the row shape stays one thing. */
const WORKTREE_COLUMNS =
  'id, branch, path, base_branch, label, profile, agent, runtime, startup_env_json, allocated_ports_json, source, conversation_id, archived, active_agent_session_id, tab_sequence_counter, created_at, updated_at';

/**
 * Record what a worktree is bound to.
 *
 * Keyed by `(project_id, branch)` rather than by path: a worktree is the branch
 * it carries, and moving the directory does not make it a different one.
 */
export async function saveWorktree(
  context: PlanRepositoryContext,
  worktree: StoredWorktree,
): Promise<void> {
  await withDatabase((database) => {
    database.transaction(() => {
      // The project row is a foreign key of this table and a worktree can be
      // the first thing a project ever records — a `run` that starts in a
      // worktree has not written a session yet. Upserting it here keeps the
      // writer self-sufficient, the same way saveSessionEvent does.
      database
        .prepare(
          `INSERT INTO projects (id, root, remote_url, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?)
           ON CONFLICT(id) DO UPDATE SET root = excluded.root, updated_at = excluded.updated_at`,
        )
        .run(context.projectId, context.projectRoot, worktree.createdAt, worktree.updatedAt);
      database
        .prepare(
          `INSERT INTO worktrees
           (project_id, id, branch, path, base_branch, label, profile, agent, runtime,
            startup_env_json, allocated_ports_json, source, conversation_id, archived,
            active_agent_session_id, tab_sequence_counter, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, branch) DO UPDATE SET
           path = excluded.path,
           base_branch = excluded.base_branch,
           label = excluded.label,
           profile = excluded.profile,
           agent = excluded.agent,
           runtime = excluded.runtime,
           startup_env_json = excluded.startup_env_json,
           allocated_ports_json = excluded.allocated_ports_json,
           source = excluded.source,
           conversation_id = excluded.conversation_id,
           archived = excluded.archived,
           active_agent_session_id = excluded.active_agent_session_id,
           tab_sequence_counter = excluded.tab_sequence_counter,
           updated_at = excluded.updated_at`,
        )
        .run(
          context.projectId,
          worktree.worktreeId,
          worktree.branch,
          worktree.path,
          worktree.baseBranch,
          worktree.label,
          worktree.profile,
          worktree.agent,
          worktree.runtime,
          JSON.stringify(worktree.startupEnvValues),
          JSON.stringify(worktree.allocatedPorts),
          worktree.source,
          worktree.conversationId,
          worktree.archived ? 1 : 0,
          worktree.activeAgentSessionId ?? null,
          worktree.tabSequenceCounter ?? 0,
          worktree.createdAt,
          worktree.updatedAt,
        );
    });
  }, context.databaseOptions);
}

export async function loadWorktree(
  context: PlanRepositoryContext,
  branch: string,
): Promise<StoredWorktree | null> {
  return withDatabase((database) => {
    const row = database
      .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE project_id = ? AND branch = ?`)
      .get<Parameters<typeof toStoredWorktree>[0]>(context.projectId, branch);
    return row === undefined ? null : toStoredWorktree(row);
  }, context.databaseOptions);
}

export async function listWorktrees(context: PlanRepositoryContext): Promise<StoredWorktree[]> {
  return withDatabase((database) => {
    return database
      .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE project_id = ? ORDER BY branch`)
      .all<Parameters<typeof toStoredWorktree>[0]>(context.projectId)
      .map(toStoredWorktree);
  }, context.databaseOptions);
}

export async function deleteWorktree(
  context: PlanRepositoryContext,
  branch: string,
): Promise<void> {
  await withDatabase((database) => {
    database
      .prepare('DELETE FROM worktrees WHERE project_id = ? AND branch = ?')
      .run(context.projectId, branch);
  }, context.databaseOptions);
}

const AGENT_SESSION_COLUMNS =
  'id, run_id, phase, story_id, branch, worktree_id, provider, permission, conversation_id, status, pane_target, pane_token, parent_session_id, tab_sequence, label, created_at, updated_at, ended_at';

interface AgentSessionRow {
  id: string;
  run_id: string | null;
  phase: string | null;
  story_id: string | null;
  branch: string;
  worktree_id: string | null;
  provider: string;
  permission: StoredAgentSession['permission'];
  conversation_id: string | null;
  status: string;
  pane_target: string | null;
  pane_token: string | null;
  parent_session_id: string | null;
  tab_sequence: number | null;
  label: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

function toStoredAgentSession(row: AgentSessionRow): StoredAgentSession {
  return {
    id: row.id,
    runId: row.run_id,
    phase: row.phase as StoredAgentSession['phase'],
    storyId: row.story_id,
    branch: row.branch,
    worktreeId: row.worktree_id,
    provider: row.provider as StoredAgentSession['provider'],
    permission: row.permission,
    conversationId: row.conversation_id,
    status: row.status as StoredAgentSession['status'],
    paneTarget: row.pane_target,
    paneToken: row.pane_token,
    parentSessionId: row.parent_session_id,
    tabSequence: row.tab_sequence,
    label: row.label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  };
}

/** Shape of `agent_sessions`. Mirrors `src/agents/session/types.ts`. */
export interface StoredAgentSession {
  id: string;
  runId: string | null;
  phase: string | null;
  storyId: string | null;
  branch: string;
  worktreeId: string | null;
  provider: string;
  permission: 'read-only' | 'workspace' | 'autonomous';
  conversationId: string | null;
  status: 'starting' | 'running' | 'idle' | 'stopped' | 'orphaned';
  paneTarget: string | null;
  paneToken: string | null;
  parentSessionId: string | null;
  tabSequence: number | null;
  /** Free caption for a session no issue names (ADR-16). */
  label: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export async function saveAgentSession(
  context: PlanRepositoryContext,
  session: StoredAgentSession,
): Promise<void> {
  await withDatabase((database) => {
    database.transaction(() => {
      // Same reason as saveWorktree: the project row is a foreign key and a
      // session can be the first thing a project records.
      database
        .prepare(
          `INSERT INTO projects (id, root, remote_url, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?)
           ON CONFLICT(id) DO UPDATE SET root = excluded.root, updated_at = excluded.updated_at`,
        )
        .run(context.projectId, context.projectRoot, session.createdAt, session.updatedAt);
      database
        .prepare(
          `INSERT INTO agent_sessions
             (project_id, id, run_id, phase, story_id, branch, worktree_id, provider, permission,
              conversation_id, status, pane_target, pane_token, parent_session_id, tab_sequence, label,
              created_at, updated_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             run_id = excluded.run_id,
             phase = excluded.phase,
             story_id = excluded.story_id,
             branch = excluded.branch,
             worktree_id = excluded.worktree_id,
             provider = excluded.provider,
             permission = excluded.permission,
             conversation_id = excluded.conversation_id,
             status = excluded.status,
             pane_target = excluded.pane_target,
             pane_token = excluded.pane_token,
             parent_session_id = excluded.parent_session_id,
             tab_sequence = excluded.tab_sequence,
             label = excluded.label,
             updated_at = excluded.updated_at,
             ended_at = excluded.ended_at`,
        )
        .run(
          context.projectId,
          session.id,
          session.runId,
          session.phase,
          session.storyId,
          session.branch,
          session.worktreeId,
          session.provider,
          session.permission,
          session.conversationId,
          session.status,
          session.paneTarget,
          session.paneToken,
          session.parentSessionId,
          session.tabSequence,
          session.label,
          session.createdAt,
          session.updatedAt,
          session.endedAt,
        );
    });
  }, context.databaseOptions);
}

/** Upsert one session and its worktree active pointer in the same transaction. */
export async function saveAgentSessionActivation(
  context: PlanRepositoryContext,
  session: StoredAgentSession,
  worktree: StoredWorktree,
): Promise<void> {
  await withDatabase((database) => {
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO projects (id, root, remote_url, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?)
           ON CONFLICT(id) DO UPDATE SET root = excluded.root, updated_at = excluded.updated_at`,
        )
        .run(context.projectId, context.projectRoot, session.createdAt, session.updatedAt);
      database
        .prepare(
          `INSERT INTO agent_sessions
             (project_id, id, run_id, phase, story_id, branch, worktree_id, provider, permission,
              conversation_id, status, pane_target, pane_token, parent_session_id, tab_sequence, label,
              created_at, updated_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             run_id = excluded.run_id,
             phase = excluded.phase,
             story_id = excluded.story_id,
             branch = excluded.branch,
             worktree_id = excluded.worktree_id,
             provider = excluded.provider,
             permission = excluded.permission,
             conversation_id = excluded.conversation_id,
             status = excluded.status,
             pane_target = excluded.pane_target,
             pane_token = excluded.pane_token,
             parent_session_id = excluded.parent_session_id,
             tab_sequence = excluded.tab_sequence,
             label = excluded.label,
             updated_at = excluded.updated_at,
             ended_at = excluded.ended_at`,
        )
        .run(
          context.projectId,
          session.id,
          session.runId,
          session.phase,
          session.storyId,
          session.branch,
          session.worktreeId,
          session.provider,
          session.permission,
          session.conversationId,
          session.status,
          session.paneTarget,
          session.paneToken,
          session.parentSessionId,
          session.tabSequence,
          session.label,
          session.createdAt,
          session.updatedAt,
          session.endedAt,
        );
      const updated = database
        .prepare(
          `UPDATE worktrees
              SET active_agent_session_id = ?, updated_at = ?
            WHERE project_id = ? AND id = ? AND branch = ?`,
        )
        .run(
          session.id,
          worktree.updatedAt,
          context.projectId,
          worktree.worktreeId,
          worktree.branch,
        );
      if (updated.changes !== 1) {
        throw new Error(`Worktree binding disappeared: ${worktree.branch}`);
      }
    });
  }, context.databaseOptions);
}

/** Persist stop intent for every live AgentSession of one worktree atomically. */
export async function stopAgentSessionsForWorktree(
  context: PlanRepositoryContext,
  worktreeId: string,
  at: string,
): Promise<void> {
  await withDatabase((database) => {
    database
      .prepare(
        `UPDATE agent_sessions
            SET status = 'stopped', updated_at = ?, ended_at = ?
          WHERE project_id = ? AND worktree_id = ?
            AND status IN ('starting', 'running', 'idle', 'orphaned')`,
      )
      .run(at, at, context.projectId, worktreeId);
  }, context.databaseOptions);
}

/** Restore a stop-intent snapshot atomically when physical teardown fails. */
export async function restoreAgentSessionStates(
  context: PlanRepositoryContext,
  sessions: readonly StoredAgentSession[],
): Promise<void> {
  await withDatabase((database) => {
    database.transaction(() => {
      const update = database.prepare(
        `UPDATE agent_sessions
            SET status = ?, updated_at = ?, ended_at = ?
          WHERE project_id = ? AND id = ? AND worktree_id IS ?`,
      );
      for (const session of sessions) {
        update.run(
          session.status,
          session.updatedAt,
          session.endedAt,
          context.projectId,
          session.id,
          session.worktreeId,
        );
      }
    });
  }, context.databaseOptions);
}

/** Persist a new fork row and its worktree active/counter pointer atomically. */
export async function saveAgentTabCreation(
  context: PlanRepositoryContext,
  session: StoredAgentSession,
  worktree: StoredWorktree,
): Promise<void> {
  await withDatabase((database) => {
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO agent_sessions
             (project_id, id, run_id, phase, story_id, branch, worktree_id, provider, permission,
              conversation_id, status, pane_target, pane_token, parent_session_id, tab_sequence, label,
              created_at, updated_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          context.projectId,
          session.id,
          session.runId,
          session.phase,
          session.storyId,
          session.branch,
          session.worktreeId,
          session.provider,
          session.permission,
          session.conversationId,
          session.status,
          session.paneTarget,
          session.paneToken,
          session.parentSessionId,
          session.tabSequence,
          session.label,
          session.createdAt,
          session.updatedAt,
          session.endedAt,
        );
      const updated = database
        .prepare(
          `UPDATE worktrees
              SET active_agent_session_id = ?, tab_sequence_counter = ?, updated_at = ?
            WHERE project_id = ? AND id = ? AND branch = ?`,
        )
        .run(
          worktree.activeAgentSessionId ?? null,
          worktree.tabSequenceCounter ?? 0,
          worktree.updatedAt,
          context.projectId,
          worktree.worktreeId,
          worktree.branch,
        );
      if (updated.changes !== 1)
        throw new Error(`Worktree binding disappeared: ${worktree.branch}`);
    });
  }, context.databaseOptions);
}

export async function loadStoredAgentSession(
  context: PlanRepositoryContext,
  id: string,
): Promise<StoredAgentSession | null> {
  return withDatabase((database) => {
    const row = database
      .prepare(
        `SELECT ${AGENT_SESSION_COLUMNS} FROM agent_sessions WHERE project_id = ? AND id = ?`,
      )
      .get<AgentSessionRow>(context.projectId, id);
    return row === undefined ? null : toStoredAgentSession(row);
  }, context.databaseOptions);
}

export async function listStoredAgentSessions(
  context: PlanRepositoryContext,
  filter: { branch?: string; runId?: string } = {},
): Promise<StoredAgentSession[]> {
  return withDatabase((database) => {
    const clauses = ['project_id = ?'];
    const values: string[] = [context.projectId];
    if (filter.branch !== undefined) {
      clauses.push('branch = ?');
      values.push(filter.branch);
    }
    if (filter.runId !== undefined) {
      clauses.push('run_id = ?');
      values.push(filter.runId);
    }
    return database
      .prepare(
        `SELECT ${AGENT_SESSION_COLUMNS} FROM agent_sessions
          WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, rowid DESC`,
      )
      .all<AgentSessionRow>(...values)
      .map(toStoredAgentSession);
  }, context.databaseOptions);
}

export async function deleteAgentSession(
  context: PlanRepositoryContext,
  id: string,
): Promise<void> {
  await withDatabase((database) => {
    database
      .prepare('DELETE FROM agent_sessions WHERE project_id = ? AND id = ?')
      .run(context.projectId, id);
  }, context.databaseOptions);
}

/**
 * The most recent run recorded for an issue, or `null` when it has none.
 *
 * Read-only on purpose: `issue-flow session link` uses it to point a free
 * session at an execution that already exists, and a link that found nothing
 * has to say so rather than invent a run. Creating one here would fabricate the
 * execution the person is about to be told they still have to start — and the
 * outside world, not this table, is the authority on whether work is running
 * (ADR-08).
 */
export async function findLatestRunIdForIssue(
  context: PlanRepositoryContext,
): Promise<string | null> {
  return withDatabase((database) => {
    const row = database
      .prepare(
        `SELECT id FROM runs WHERE project_id = ? AND issue_id = ?
          ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get<{ id: string }>(context.projectId, context.issueId);
    return row?.id ?? null;
  }, context.databaseOptions);
}

/**
 * Record — or clear — that a person took over a run.
 *
 * `null` clears it. Nothing else writes these columns, so a hold is only ever
 * set by a takeover and only ever released explicitly.
 */
export async function saveRunHumanHold(
  context: PlanRepositoryContext,
  runId: string,
  hold: { since: string; reason: string } | null,
): Promise<void> {
  await withDatabase((database) => {
    database
      .prepare(
        'UPDATE runs SET human_hold_at = ?, human_hold_reason = ? WHERE id = ? AND project_id = ?',
      )
      .run(hold?.since ?? null, hold?.reason ?? null, runId, context.projectId);
  }, context.databaseOptions);
}

export async function loadRunHumanHold(
  context: PlanRepositoryContext,
  runId: string,
): Promise<{ runId: string; since: string; reason: 'takeover' | 'requested' } | null> {
  return withDatabase((database) => {
    const row = database
      .prepare('SELECT human_hold_at, human_hold_reason FROM runs WHERE id = ? AND project_id = ?')
      .get<{ human_hold_at: string | null; human_hold_reason: string | null }>(
        runId,
        context.projectId,
      );
    if (row === undefined || row.human_hold_at === null) return null;
    return {
      runId,
      since: row.human_hold_at,
      // A reason written by a newer release is narrowed to the one that is
      // always true of a hold: somebody took over.
      reason: row.human_hold_reason === 'requested' ? 'requested' : 'takeover',
    };
  }, context.databaseOptions);
}

/** Runs a person currently holds, newest first. */
export async function listHeldRuns(input: {
  projectId: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}): Promise<Array<{ runId: string; issueId: string | null; since: string; reason: string }>> {
  return withDatabase(
    (database) =>
      database
        .prepare(
          `SELECT id, issue_id, human_hold_at, human_hold_reason FROM runs
            WHERE project_id = ? AND human_hold_at IS NOT NULL
            ORDER BY human_hold_at DESC`,
        )
        .all<{
          id: string;
          issue_id: string | null;
          human_hold_at: string;
          human_hold_reason: string | null;
        }>(input.projectId)
        .map((row) => ({
          runId: row.id,
          issueId: row.issue_id,
          since: row.human_hold_at,
          reason: row.human_hold_reason ?? 'takeover',
        })),
    input.databaseOptions,
  );
}

export interface StoredHandoff {
  id: string;
  runId: string;
  fromSessionId: string | null;
  fromPhase: string;
  fromProvider: string;
  toPhase: string;
  toProvider: string | null;
  payload: unknown;
  createdAt: string;
  consumedAt: string | null;
}

export async function saveStoredHandoff(
  context: PlanRepositoryContext,
  handoff: StoredHandoff,
): Promise<void> {
  await withDatabase((database) => {
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO projects (id, root, remote_url, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?)
           ON CONFLICT(id) DO UPDATE SET root = excluded.root, updated_at = excluded.updated_at`,
        )
        .run(context.projectId, context.projectRoot, handoff.createdAt, handoff.createdAt);
      database
        .prepare(
          `INSERT INTO handoffs
             (id, project_id, run_id, from_session_id, from_phase, from_provider,
              to_phase, to_provider, payload_json, created_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             payload_json = excluded.payload_json,
             consumed_at = excluded.consumed_at`,
        )
        .run(
          handoff.id,
          context.projectId,
          handoff.runId,
          handoff.fromSessionId,
          handoff.fromPhase,
          handoff.fromProvider,
          handoff.toPhase,
          handoff.toProvider,
          JSON.stringify(handoff.payload),
          handoff.createdAt,
          handoff.consumedAt,
        );
    });
  }, context.databaseOptions);
}

export async function listStoredHandoffs(
  context: PlanRepositoryContext,
  filter: { runId: string; toPhase?: string; pendingOnly?: boolean },
): Promise<StoredHandoff[]> {
  return withDatabase((database) => {
    const clauses = ['project_id = ?', 'run_id = ?'];
    const values: string[] = [context.projectId, filter.runId];
    if (filter.toPhase !== undefined) {
      clauses.push('to_phase = ?');
      values.push(filter.toPhase);
    }
    if (filter.pendingOnly === true) clauses.push('consumed_at IS NULL');

    return database
      .prepare(
        `SELECT id, run_id, from_session_id, from_phase, from_provider, to_phase, to_provider,
                payload_json, created_at, consumed_at
           FROM handoffs WHERE ${clauses.join(' AND ')} ORDER BY created_at, rowid`,
      )
      .all<{
        id: string;
        run_id: string;
        from_session_id: string | null;
        from_phase: string;
        from_provider: string;
        to_phase: string;
        to_provider: string | null;
        payload_json: string;
        created_at: string;
        consumed_at: string | null;
      }>(...values)
      .map((row) => ({
        id: row.id,
        runId: row.run_id,
        fromSessionId: row.from_session_id,
        fromPhase: row.from_phase,
        fromProvider: row.from_provider,
        toPhase: row.to_phase,
        toProvider: row.to_provider,
        payload: JSON.parse(row.payload_json) as unknown,
        createdAt: row.created_at,
        consumedAt: row.consumed_at,
      }));
  }, context.databaseOptions);
}

export async function consumeStoredHandoff(
  context: PlanRepositoryContext,
  id: string,
  at: string,
): Promise<void> {
  await withDatabase((database) => {
    database
      .prepare('UPDATE handoffs SET consumed_at = ? WHERE id = ? AND project_id = ?')
      .run(at, id, context.projectId);
  }, context.databaseOptions);
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
  }, input.databaseOptions ?? databaseOptionsForProject(input.projectId));
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
  }, input.databaseOptions ?? databaseOptionsForProject(input.projectId));
}

/** A stable, JSON-friendly diagnostic export that never exposes SQL to callers. */
export async function exportStoredState(
  options: OpenIssueFlowDatabaseOptions = {},
): Promise<Record<string, unknown>> {
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
      'queue_dependencies',
      'user_story_numbering',
      'provider_health_failures',
      'migrated_artifacts',
      'audit_log',
    ];
    return Object.fromEntries(
      tables.map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()]),
    );
  }, options);
}

/* ── audit log ──────────────────────────────────────────────────────────── */

export interface StoredAuditEntry {
  action: string;
  payload: unknown;
  occurredAt: string;
}

/**
 * Record a fact worth being able to explain later.
 *
 * `audit_log` already backed the branch history; reconciliation needs the same
 * append for a different reason (§30): when the outside world contradicts a row
 * and a session is closed as `orphaned`, the closure must leave a trace. A
 * status that changed with no record of why is indistinguishable from a bug,
 * and the row itself only carries the new value, never the reason.
 */
export async function appendAuditEntry(
  context: PlanRepositoryContext,
  action: string,
  payload: unknown,
): Promise<void> {
  await withDatabase((database) => {
    database.transaction(() => {
      const occurredAt = new Date().toISOString();
      ensureStoredProject(database, context, occurredAt);
      database
        .prepare(
          `INSERT INTO audit_log (id, project_id, occurred_at, action, payload_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), context.projectId, occurredAt, action, JSON.stringify(payload));
    });
  }, context.databaseOptions);
}

/** Audit entries of one project, oldest first. `action` filters by exact match. */
export async function listAuditEntries(
  context: PlanRepositoryContext,
  filter: { action?: string } = {},
): Promise<StoredAuditEntry[]> {
  return withDatabase((database) => {
    const clauses = ['project_id = ?'];
    const values: string[] = [context.projectId];
    if (filter.action !== undefined) {
      clauses.push('action = ?');
      values.push(filter.action);
    }
    return database
      .prepare(
        `SELECT action, payload_json, occurred_at FROM audit_log
          WHERE ${clauses.join(' AND ')} ORDER BY occurred_at, rowid`,
      )
      .all<{ action: string; payload_json: string; occurred_at: string }>(...values)
      .map((row) => ({
        action: row.action,
        payload: JSON.parse(row.payload_json) as unknown,
        occurredAt: row.occurred_at,
      }));
  }, context.databaseOptions);
}
