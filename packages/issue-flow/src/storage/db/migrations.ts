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
