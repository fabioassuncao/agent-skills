import type { SessionSnapshot } from '../../core/session-state.js';
import type { ExecutionPlan } from '../../execution/types.js';
import type { ExecutionRecord } from '../../telemetry/types.js';
import { type OpenIssueFlowDatabaseOptions, openIssueFlowDatabase } from './index.js';

async function query<T>(
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

/** Canonical issue identities for a project, ordered by their last plan update. */
export async function listStoredIssueIds(input: {
  projectId: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}): Promise<string[]> {
  return query(
    (database) =>
      database
        .prepare(
          `SELECT issue_id FROM pipelines WHERE project_id = ?
           ORDER BY COALESCE(last_attempt_at, updated_at) DESC, issue_id`,
        )
        .all<{ issue_id: string }>(input.projectId)
        .map((row) => row.issue_id),
    input.databaseOptions,
  );
}

/** Latest durable snapshot for one issue, whether the run is active or finished. */
export async function latestStoredIssueSnapshot(input: {
  projectId: string;
  issueId: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}): Promise<SessionSnapshot | null> {
  return query((database) => {
    const row = database
      .prepare(
        `SELECT snapshot.payload_json FROM snapshots AS snapshot
         WHERE snapshot.project_id = ? AND snapshot.issue_id = ?
         ORDER BY snapshot.updated_at DESC, snapshot.rowid DESC LIMIT 1`,
      )
      .get<{ payload_json: string }>(input.projectId, input.issueId);
    return row === undefined ? null : (JSON.parse(row.payload_json) as SessionSnapshot);
  }, input.databaseOptions);
}

/** Canonical queue plans for one project. */
export async function listStoredQueues(input: {
  projectId: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}): Promise<ExecutionPlan[]> {
  return query(
    (database) =>
      database
        .prepare('SELECT payload_json FROM queues WHERE project_id = ? ORDER BY updated_at DESC')
        .all<{ payload_json: string }>(input.projectId)
        .map((row) => JSON.parse(row.payload_json) as ExecutionPlan),
    input.databaseOptions,
  );
}

export interface StoredIssueEvent {
  seq: number;
  event: Record<string, unknown> & { type: string; at: string };
}

/** Ordered canonical journal for one issue across all of its runs. */
export async function listStoredIssueEvents(input: {
  projectId: string;
  issueId: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}): Promise<StoredIssueEvent[]> {
  return query(
    (database) =>
      database
        .prepare(
          `SELECT event.payload_json FROM events AS event
           JOIN runs AS run ON run.id = event.run_id
           WHERE event.project_id = ? AND run.issue_id = ?
           ORDER BY run.started_at, event.sequence, event.rowid`,
        )
        .all<{ payload_json: string }>(input.projectId, input.issueId)
        .map((row, index) => {
          const parsed = JSON.parse(row.payload_json) as unknown;
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'event' in parsed &&
            typeof parsed.event === 'object' &&
            parsed.event !== null
          ) {
            const entry = parsed as StoredIssueEvent;
            return { seq: index + 1, event: entry.event };
          }
          return {
            seq: index + 1,
            event: parsed as StoredIssueEvent['event'],
          };
        }),
    input.databaseOptions,
  );
}

export interface StoredIssueHistory {
  issueId: string;
  runs: Array<Record<string, unknown>>;
  phases: Array<Record<string, unknown>>;
  executions: ExecutionRecord[];
  verifications: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
}

/** Full relational history used by `issue-flow history`. */
export async function getStoredIssueHistory(input: {
  projectId: string;
  issueId: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}): Promise<StoredIssueHistory> {
  return query((database) => {
    const runs = database
      .prepare(
        `SELECT id, status, started_at, finished_at, heartbeat_at
         FROM runs WHERE project_id = ? AND issue_id = ? ORDER BY started_at`,
      )
      .all<Record<string, unknown>>(input.projectId, input.issueId);
    const phases = database
      .prepare(
        `SELECT phase.run_id, phase.name, phase.status, phase.started_at, phase.finished_at,
                phase.duration_ms, phase.input_tokens, phase.output_tokens, phase.cost_status,
                phase.cost_amount
         FROM phases AS phase JOIN runs AS run ON run.id = phase.run_id
         WHERE run.project_id = ? AND run.issue_id = ? ORDER BY run.started_at, phase.started_at`,
      )
      .all<Record<string, unknown>>(input.projectId, input.issueId);
    const executions = database
      .prepare(
        `SELECT payload_json FROM executions WHERE project_id = ? AND issue_id = ?
         ORDER BY started_at, rowid`,
      )
      .all<{ payload_json: string }>(input.projectId, input.issueId)
      .map((row) => JSON.parse(row.payload_json) as ExecutionRecord);
    const verifications = database
      .prepare(
        `SELECT payload_json FROM verifications WHERE project_id = ? AND issue_id = ?
         ORDER BY created_at, rowid`,
      )
      .all<{ payload_json: string }>(input.projectId, input.issueId)
      .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
    const reviews = database
      .prepare(
        `SELECT review.payload_json FROM reviews AS review
         JOIN pull_requests AS pull ON pull.id = review.pull_request_id
         WHERE pull.project_id = ? AND pull.issue_id = ? ORDER BY review.created_at, review.rowid`,
      )
      .all<{ payload_json: string }>(input.projectId, input.issueId)
      .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
    return { issueId: input.issueId, runs, phases, executions, verifications, reviews };
  }, input.databaseOptions);
}
