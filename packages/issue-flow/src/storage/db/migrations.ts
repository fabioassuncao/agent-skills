import type { DatabaseDriver } from './driver.js';

export interface Migration {
  version: number;
  name: string;
  up(database: DatabaseDriver): void;
}

const INITIAL_SCHEMA = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  remote_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE issues (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  branch_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE pipelines (
  project_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, issue_id),
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE stories (
  project_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  priority INTEGER NOT NULL,
  passes INTEGER NOT NULL CHECK (passes IN (0, 1)),
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, issue_id, id),
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE story_dependencies (
  project_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  story_id TEXT NOT NULL,
  depends_on_story_id TEXT NOT NULL,
  PRIMARY KEY (project_id, issue_id, story_id, depends_on_story_id),
  FOREIGN KEY (project_id, issue_id, story_id) REFERENCES stories(project_id, issue_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, issue_id, depends_on_story_id) REFERENCES stories(project_id, issue_id, id) ON DELETE CASCADE,
  CHECK (story_id <> depends_on_story_id)
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE phases (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id TEXT,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  phase_id TEXT REFERENCES phases(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  cost_status TEXT NOT NULL CHECK (cost_status IN ('reported', 'estimated', 'unknown')),
  cost_amount REAL,
  CHECK ((cost_status = 'unknown' AND cost_amount IS NULL) OR (cost_status IN ('reported', 'estimated') AND cost_amount IS NOT NULL AND cost_amount >= 0)),
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id TEXT,
  number INTEGER,
  url TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE provider_health (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, provider)
);
CREATE TABLE queues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE queue_issues (
  queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (queue_id, project_id, issue_id),
  UNIQUE (queue_id, position),
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE migrated_artifacts (
  source_path TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  migrated_at TEXT NOT NULL,
  table_counts_json TEXT NOT NULL
);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX executions_project_issue_started_idx ON executions(project_id, issue_id, started_at);
CREATE INDEX runs_project_status_started_idx ON runs(project_id, status, started_at);
CREATE INDEX stories_project_issue_priority_idx ON stories(project_id, issue_id, priority);
CREATE INDEX phases_run_name_idx ON phases(run_id, name);
CREATE INDEX events_project_run_occurred_idx ON events(project_id, run_id, occurred_at);
`;

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial relational storage',
    up: (database) => database.exec(INITIAL_SCHEMA),
  },
  {
    version: 2,
    name: 'preserve imported execution details',
    up: (database) =>
      database.exec("ALTER TABLE executions ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'"),
  },
  {
    version: 3,
    name: 'index numeric user story identifiers',
    up: (database) =>
      database.exec(`
        ALTER TABLE stories ADD COLUMN story_number INTEGER;
        CREATE INDEX stories_project_number_idx ON stories(project_id, story_number DESC);
      `),
  },
  {
    version: 4,
    name: 'complete relational state and history indexes',
    up: (database) =>
      database.exec(`
        ALTER TABLE pipelines ADD COLUMN project TEXT;
        ALTER TABLE pipelines ADD COLUMN issue_number TEXT;
        ALTER TABLE pipelines ADD COLUMN issue_url TEXT;
        ALTER TABLE pipelines ADD COLUMN branch_name TEXT;
        ALTER TABLE pipelines ADD COLUMN no_branch INTEGER NOT NULL DEFAULT 0 CHECK (no_branch IN (0, 1));
        ALTER TABLE pipelines ADD COLUMN description TEXT;
        ALTER TABLE pipelines ADD COLUMN issue_status TEXT;
        ALTER TABLE pipelines ADD COLUMN completed_at TEXT;
        ALTER TABLE pipelines ADD COLUMN last_attempt_at TEXT;
        ALTER TABLE pipelines ADD COLUMN last_error_category TEXT;
        ALTER TABLE pipelines ADD COLUMN last_error_message TEXT;
        ALTER TABLE pipelines ADD COLUMN last_error_at TEXT;
        ALTER TABLE pipelines ADD COLUMN correction_cycle INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE pipelines ADD COLUMN max_correction_cycles INTEGER NOT NULL DEFAULT 3;
        ALTER TABLE pipelines ADD COLUMN last_review_findings TEXT;
        ALTER TABLE pipelines ADD COLUMN analyze_completed INTEGER CHECK (analyze_completed IN (0, 1));
        ALTER TABLE pipelines ADD COLUMN prd_completed INTEGER CHECK (prd_completed IN (0, 1));
        ALTER TABLE pipelines ADD COLUMN json_completed INTEGER CHECK (json_completed IN (0, 1));
        ALTER TABLE pipelines ADD COLUMN execution_completed INTEGER CHECK (execution_completed IN (0, 1));
        ALTER TABLE pipelines ADD COLUMN review_completed INTEGER CHECK (review_completed IN (0, 1));
        ALTER TABLE pipelines ADD COLUMN pr_created INTEGER CHECK (pr_created IN (0, 1));
        ALTER TABLE pipelines ADD COLUMN pr_review_completed INTEGER CHECK (pr_review_completed IN (0, 1));
        ALTER TABLE pipelines ADD COLUMN run_status TEXT;
        ALTER TABLE pipelines ADD COLUMN run_phase TEXT;
        ALTER TABLE pipelines ADD COLUMN run_attempt INTEGER;
        ALTER TABLE pipelines ADD COLUMN run_heartbeat_at TEXT;
        ALTER TABLE pipelines ADD COLUMN run_blocked_reason TEXT;
        ALTER TABLE pipelines ADD COLUMN run_owner_pid INTEGER;
        ALTER TABLE pipelines ADD COLUMN run_owner_host TEXT;
        ALTER TABLE pipelines ADD COLUMN run_owner_started_at TEXT;
        ALTER TABLE pipelines ADD COLUMN pr_number INTEGER;
        ALTER TABLE pipelines ADD COLUMN pr_url TEXT;
        ALTER TABLE pipelines ADD COLUMN pr_head_branch TEXT;
        ALTER TABLE pipelines ADD COLUMN pr_created_at TEXT;
        ALTER TABLE pipelines ADD COLUMN pr_review_enabled INTEGER CHECK (pr_review_enabled IN (0, 1));
        ALTER TABLE pipelines ADD COLUMN pr_review_rounds INTEGER;
        ALTER TABLE pipelines ADD COLUMN pr_review_recommendation TEXT;
        ALTER TABLE pipelines ADD COLUMN pr_reviewed_at TEXT;

        ALTER TABLE stories ADD COLUMN description TEXT;
        ALTER TABLE stories ADD COLUMN acceptance_criteria_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE stories ADD COLUMN duration_seconds REAL;
        ALTER TABLE stories ADD COLUMN status TEXT;
        ALTER TABLE stories ADD COLUMN stage TEXT;
        ALTER TABLE stories ADD COLUMN stage_since TEXT;
        ALTER TABLE stories ADD COLUMN stage_detail TEXT;
        ALTER TABLE stories ADD COLUMN input_tokens INTEGER;
        ALTER TABLE stories ADD COLUMN output_tokens INTEGER;
        ALTER TABLE stories ADD COLUMN cache_read_tokens INTEGER;
        ALTER TABLE stories ADD COLUMN cache_creation_tokens INTEGER;

        ALTER TABLE runs ADD COLUMN session_id TEXT;
        ALTER TABLE runs ADD COLUMN heartbeat_at TEXT;
        ALTER TABLE runs ADD COLUMN pid INTEGER;
        ALTER TABLE runs ADD COLUMN host TEXT;
        ALTER TABLE events ADD COLUMN session_id TEXT;
        ALTER TABLE events ADD COLUMN sequence INTEGER;
        ALTER TABLE snapshots ADD COLUMN issue_id TEXT;
        ALTER TABLE snapshots ADD COLUMN session_id TEXT;
        ALTER TABLE snapshots ADD COLUMN updated_at TEXT;
        ALTER TABLE executions ADD COLUMN session_id TEXT;
        ALTER TABLE executions ADD COLUMN purpose TEXT;
        ALTER TABLE executions ADD COLUMN attempt INTEGER;
        ALTER TABLE executions ADD COLUMN trigger TEXT;
        ALTER TABLE executions ADD COLUMN trigger_reason TEXT;
        ALTER TABLE executions ADD COLUMN input_tokens INTEGER;
        ALTER TABLE executions ADD COLUMN output_tokens INTEGER;
        ALTER TABLE executions ADD COLUMN cache_read_tokens INTEGER;
        ALTER TABLE executions ADD COLUMN cache_creation_tokens INTEGER;
        ALTER TABLE executions ADD COLUMN reasoning_tokens INTEGER;
        ALTER TABLE executions ADD COLUMN harness TEXT;
        ALTER TABLE executions ADD COLUMN provider TEXT;
        ALTER TABLE executions ADD COLUMN model_requested TEXT;
        ALTER TABLE executions ADD COLUMN model_resolved TEXT;

        ALTER TABLE provider_health ADD COLUMN status TEXT;
        ALTER TABLE provider_health ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE provider_health ADD COLUMN cooldown_level INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE provider_health ADD COLUMN cooldown_until TEXT;
        ALTER TABLE provider_health ADD COLUMN last_failure_kind TEXT;
        ALTER TABLE provider_health ADD COLUMN last_failure_at TEXT;
        ALTER TABLE provider_health ADD COLUMN last_success_at TEXT;
        ALTER TABLE provider_health ADD COLUMN probe_in_flight INTEGER NOT NULL DEFAULT 0 CHECK (probe_in_flight IN (0, 1));
        ALTER TABLE provider_health ADD COLUMN probe_started_at TEXT;
        CREATE TABLE provider_health_failures (
          project_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          kind TEXT NOT NULL,
          PRIMARY KEY (project_id, provider, occurred_at, kind),
          FOREIGN KEY (project_id, provider) REFERENCES provider_health(project_id, provider) ON DELETE CASCADE
        );

        ALTER TABLE queues ADD COLUMN requested_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE queues ADD COLUMN branch_name TEXT;
        ALTER TABLE queues ADD COLUMN no_branch INTEGER NOT NULL DEFAULT 0 CHECK (no_branch IN (0, 1));
        ALTER TABLE queues ADD COLUMN pr_review INTEGER NOT NULL DEFAULT 0 CHECK (pr_review IN (0, 1));
        ALTER TABLE queues ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1));
        ALTER TABLE queue_issues ADD COLUMN number INTEGER;
        ALTER TABLE queue_issues ADD COLUMN title TEXT;
        ALTER TABLE queue_issues ADD COLUMN url TEXT;
        ALTER TABLE queue_issues ADD COLUMN source TEXT;
        ALTER TABLE queue_issues ADD COLUMN origin TEXT;
        ALTER TABLE queue_issues ADD COLUMN role TEXT;
        ALTER TABLE queue_issues ADD COLUMN priority TEXT;
        ALTER TABLE queue_issues ADD COLUMN heuristic INTEGER NOT NULL DEFAULT 0 CHECK (heuristic IN (0, 1));
        ALTER TABLE queue_issues ADD COLUMN failed_phase TEXT;
        ALTER TABLE queue_issues ADD COLUMN last_error_category TEXT;
        ALTER TABLE queue_issues ADD COLUMN last_error_message TEXT;
        ALTER TABLE queue_issues ADD COLUMN last_error_at TEXT;
        ALTER TABLE queue_issues ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE queue_issues ADD COLUMN blocked_reason TEXT;
        ALTER TABLE queue_issues ADD COLUMN started_at TEXT;
        ALTER TABLE queue_issues ADD COLUMN completed_at TEXT;
        CREATE TABLE queue_dependencies (
          queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
          issue_id TEXT NOT NULL,
          depends_on_issue_id TEXT NOT NULL,
          PRIMARY KEY (queue_id, issue_id, depends_on_issue_id),
          CHECK (issue_id <> depends_on_issue_id)
        );
        CREATE TABLE user_story_numbering (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          next_number INTEGER NOT NULL CHECK (next_number > 0),
          source TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          decided_at TEXT NOT NULL,
          detail TEXT
        );
        CREATE UNIQUE INDEX events_run_sequence_idx ON events(run_id, sequence) WHERE run_id IS NOT NULL AND sequence IS NOT NULL;
        CREATE INDEX snapshots_project_session_updated_idx ON snapshots(project_id, session_id, updated_at DESC);
        CREATE INDEX events_project_session_sequence_idx ON events(project_id, session_id, sequence);
        CREATE INDEX executions_project_purpose_started_idx ON executions(project_id, purpose, started_at);
        CREATE INDEX queue_issues_project_status_idx ON queue_issues(project_id, status, position);
        CREATE INDEX provider_health_failures_lookup_idx ON provider_health_failures(project_id, provider, occurred_at DESC);
      `),
  },
  {
    version: 5,
    name: 'preserve pr review target state',
    up: (database) =>
      database.exec('ALTER TABLE pipelines ADD COLUMN pr_review_pull_request_number INTEGER;'),
  },
  {
    version: 6,
    name: 'record completed project adoption and runtime phase history',
    up: (database) =>
      database.exec(`
        CREATE TABLE project_imports (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          completed_at TEXT NOT NULL
        );
        ALTER TABLE phases ADD COLUMN duration_ms INTEGER;
        ALTER TABLE phases ADD COLUMN input_tokens INTEGER;
        ALTER TABLE phases ADD COLUMN output_tokens INTEGER;
        ALTER TABLE phases ADD COLUMN cache_read_tokens INTEGER;
        ALTER TABLE phases ADD COLUMN cache_creation_tokens INTEGER;
        ALTER TABLE phases ADD COLUMN cost_status TEXT;
        ALTER TABLE phases ADD COLUMN cost_amount REAL;
        CREATE INDEX phases_run_status_started_idx ON phases(run_id, status, started_at);
        CREATE INDEX reviews_pull_request_created_idx ON reviews(pull_request_id, created_at DESC);
      `),
  },
  {
    version: 7,
    name: 'index execution history by harness and run',
    up: (database) =>
      database.exec(`
        CREATE INDEX executions_harness_started_idx ON executions(harness, started_at);
        CREATE INDEX executions_run_id_idx ON executions(run_id);
      `),
  },
];

export const CURRENT_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;

function userVersion(database: DatabaseDriver): number {
  return Number(
    database.prepare('PRAGMA user_version').get<{ user_version: number }>()?.user_version ?? 0,
  );
}

export function migrateDatabase(database: DatabaseDriver): number {
  const current = userVersion(database);
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this Issue Flow supports (${CURRENT_SCHEMA_VERSION}). Upgrade Issue Flow before opening this database.`,
    );
  }

  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    database.transaction(() => {
      migration.up(database);
      database
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
  return CURRENT_SCHEMA_VERSION;
}
