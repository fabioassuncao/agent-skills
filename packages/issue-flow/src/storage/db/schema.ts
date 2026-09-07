import type { DatabaseDriver } from './driver.js';

/** The only schema this release reads and writes. */
export const CURRENT_SCHEMA_VERSION = 23;

const CURRENT_SCHEMA = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY, root TEXT NOT NULL, remote_url TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, name TEXT, added_at TEXT, last_seen_at TEXT,
  source TEXT NOT NULL DEFAULT 'discovered' CHECK (source IN ('registered', 'discovered', 'ephemeral'))
);
CREATE TABLE issues (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL,
  title TEXT, status TEXT NOT NULL, branch_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE pipelines (
  project_id TEXT NOT NULL, issue_id TEXT NOT NULL, updated_at TEXT NOT NULL,
  project TEXT, issue_number TEXT, issue_url TEXT, branch_name TEXT,
  no_branch INTEGER NOT NULL DEFAULT 0 CHECK (no_branch IN (0, 1)), description TEXT,
  issue_status TEXT, completed_at TEXT, last_attempt_at TEXT, last_error_category TEXT,
  last_error_message TEXT, last_error_at TEXT, correction_cycle INTEGER NOT NULL DEFAULT 0,
  max_correction_cycles INTEGER NOT NULL DEFAULT 3, last_review_findings TEXT,
  prd_completed INTEGER CHECK (prd_completed IN (0, 1)),
  json_completed INTEGER CHECK (json_completed IN (0, 1)),
  execution_completed INTEGER CHECK (execution_completed IN (0, 1)),
  review_completed INTEGER CHECK (review_completed IN (0, 1)),
  pr_created INTEGER CHECK (pr_created IN (0, 1)),
  pr_review_completed INTEGER CHECK (pr_review_completed IN (0, 1)),
  run_status TEXT, run_phase TEXT, run_attempt INTEGER, run_heartbeat_at TEXT,
  run_blocked_reason TEXT, run_owner_pid INTEGER, run_owner_host TEXT, run_owner_started_at TEXT,
  pr_number INTEGER, pr_url TEXT, pr_head_branch TEXT, pr_created_at TEXT,
  pr_review_enabled INTEGER CHECK (pr_review_enabled IN (0, 1)), pr_review_rounds INTEGER,
  pr_review_recommendation TEXT, pr_reviewed_at TEXT, pr_review_pull_request_number INTEGER,
  close_issue INTEGER CHECK (close_issue IN (0, 1)), issue_closed_at TEXT,
  PRIMARY KEY (project_id, issue_id),
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE stories (
  project_id TEXT NOT NULL, issue_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
  priority INTEGER NOT NULL, passes INTEGER NOT NULL CHECK (passes IN (0, 1)), notes TEXT NOT NULL DEFAULT '',
  story_number INTEGER, description TEXT, acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  duration_seconds REAL, status TEXT, stage TEXT, stage_since TEXT, stage_detail TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
  PRIMARY KEY (project_id, issue_id, id),
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE story_dependencies (
  project_id TEXT NOT NULL, issue_id TEXT NOT NULL, story_id TEXT NOT NULL,
  depends_on_story_id TEXT NOT NULL,
  PRIMARY KEY (project_id, issue_id, story_id, depends_on_story_id),
  FOREIGN KEY (project_id, issue_id, story_id) REFERENCES stories(project_id, issue_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, issue_id, depends_on_story_id) REFERENCES stories(project_id, issue_id, id) ON DELETE CASCADE,
  CHECK (story_id <> depends_on_story_id)
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  session_id TEXT, heartbeat_at TEXT, pid INTEGER, host TEXT, human_hold_at TEXT, human_hold_reason TEXT,
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE phases (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  duration_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER, cost_status TEXT, cost_amount REAL
);
CREATE TABLE executions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id TEXT, run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  phase_id TEXT REFERENCES phases(id) ON DELETE SET NULL, status TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER,
  cost_status TEXT NOT NULL CHECK (cost_status IN ('reported', 'estimated', 'unknown')),
  cost_amount REAL, payload_json TEXT NOT NULL DEFAULT '{}', session_id TEXT, purpose TEXT,
  attempt INTEGER, trigger TEXT, trigger_reason TEXT, input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_creation_tokens INTEGER, reasoning_tokens INTEGER,
  harness TEXT, provider TEXT, model_requested TEXT, model_resolved TEXT,
  CHECK ((cost_status = 'unknown' AND cost_amount IS NULL) OR
    (cost_status IN ('reported', 'estimated') AND cost_amount IS NOT NULL AND cost_amount >= 0)),
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL, payload_json TEXT NOT NULL, session_id TEXT, sequence INTEGER
);
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL, issue_id TEXT, session_id TEXT, updated_at TEXT
);
CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id TEXT, number INTEGER, url TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY, pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  status TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE TABLE verifications (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL,
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE provider_health (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, provider TEXT NOT NULL,
  payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, cooldown_level INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT, last_failure_kind TEXT, last_failure_at TEXT, last_success_at TEXT,
  probe_in_flight INTEGER NOT NULL DEFAULT 0 CHECK (probe_in_flight IN (0, 1)), probe_started_at TEXT,
  PRIMARY KEY (project_id, provider)
);
CREATE TABLE queues (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, requested_json TEXT NOT NULL DEFAULT '[]', branch_name TEXT,
  no_branch INTEGER NOT NULL DEFAULT 0 CHECK (no_branch IN (0, 1)),
  pr_review INTEGER NOT NULL DEFAULT 0 CHECK (pr_review IN (0, 1)),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1))
);
CREATE TABLE queue_issues (
  queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE, project_id TEXT NOT NULL,
  issue_id TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL, number INTEGER,
  title TEXT, url TEXT, source TEXT, origin TEXT, role TEXT, priority TEXT,
  heuristic INTEGER NOT NULL DEFAULT 0 CHECK (heuristic IN (0, 1)), failed_phase TEXT,
  last_error_category TEXT, last_error_message TEXT, last_error_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT, started_at TEXT, completed_at TEXT,
  PRIMARY KEY (queue_id, project_id, issue_id), UNIQUE (queue_id, position),
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id) ON DELETE CASCADE
);
CREATE TABLE queue_dependencies (
  queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE, issue_id TEXT NOT NULL,
  depends_on_issue_id TEXT NOT NULL, PRIMARY KEY (queue_id, issue_id, depends_on_issue_id),
  CHECK (issue_id <> depends_on_issue_id)
);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL, action TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE TABLE user_story_numbering (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  next_number INTEGER NOT NULL CHECK (next_number > 0), source TEXT NOT NULL,
  issue_id TEXT NOT NULL, decided_at TEXT NOT NULL, detail TEXT
);
CREATE TABLE agent_events (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL, phase TEXT NOT NULL, type TEXT NOT NULL,
  lifecycle TEXT CHECK (lifecycle IN ('starting', 'running', 'idle', 'stopped')),
  payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch TEXT NOT NULL, path TEXT NOT NULL, base_branch TEXT, label TEXT, profile TEXT NOT NULL,
  agent TEXT NOT NULL, runtime TEXT NOT NULL CHECK (runtime IN ('host', 'docker')),
  startup_env_json TEXT NOT NULL, allocated_ports_json TEXT NOT NULL, source TEXT,
  conversation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)), active_agent_session_id TEXT,
  tab_sequence_counter INTEGER NOT NULL DEFAULT 0 CHECK (tab_sequence_counter >= 0)
);
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT, phase TEXT, story_id TEXT, branch TEXT NOT NULL, worktree_id TEXT,
  provider TEXT NOT NULL, conversation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'idle', 'stopped', 'orphaned')),
  pane_target TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT,
  label TEXT, permission TEXT NOT NULL DEFAULT 'workspace'
    CHECK (permission IN ('read-only', 'workspace', 'autonomous')),
  parent_session_id TEXT, tab_sequence INTEGER CHECK (tab_sequence IS NULL OR tab_sequence >= 0),
  pane_token TEXT
);
CREATE TABLE inline_issues (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL, from_session_id TEXT, from_phase TEXT NOT NULL, from_provider TEXT NOT NULL,
  to_phase TEXT NOT NULL, to_provider TEXT, payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL, consumed_at TEXT
);
CREATE INDEX projects_source_last_seen_idx ON projects(source, last_seen_at DESC);
CREATE INDEX stories_project_issue_priority_idx ON stories(project_id, issue_id, priority);
CREATE INDEX stories_project_number_idx ON stories(project_id, story_number DESC);
CREATE INDEX runs_project_status_started_idx ON runs(project_id, status, started_at);
CREATE INDEX phases_run_name_idx ON phases(run_id, name);
CREATE INDEX phases_run_status_started_idx ON phases(run_id, status, started_at);
CREATE INDEX executions_project_issue_started_idx ON executions(project_id, issue_id, started_at);
CREATE INDEX executions_run_id_idx ON executions(run_id);
CREATE INDEX executions_project_purpose_started_idx ON executions(project_id, purpose, started_at);
CREATE INDEX executions_harness_started_idx ON executions(harness, started_at);
CREATE INDEX events_project_run_occurred_idx ON events(project_id, run_id, occurred_at);
CREATE INDEX events_project_session_sequence_idx ON events(project_id, session_id, sequence);
CREATE UNIQUE INDEX events_run_sequence_idx ON events(run_id, sequence)
  WHERE run_id IS NOT NULL AND sequence IS NOT NULL;
CREATE INDEX snapshots_project_session_updated_idx ON snapshots(project_id, session_id, updated_at DESC);
CREATE INDEX reviews_pull_request_created_idx ON reviews(pull_request_id, created_at DESC);
CREATE INDEX queue_issues_project_status_idx ON queue_issues(project_id, status, position);
CREATE INDEX agent_events_run_occurred_idx ON agent_events(run_id, occurred_at);
CREATE UNIQUE INDEX worktrees_project_branch_idx ON worktrees(project_id, branch);
CREATE INDEX agent_sessions_project_branch_idx ON agent_sessions(project_id, branch);
CREATE INDEX agent_sessions_run_idx ON agent_sessions(run_id);
CREATE INDEX agent_sessions_parent_sequence_idx
  ON agent_sessions(project_id, parent_session_id, tab_sequence);
CREATE INDEX handoffs_run_target_idx ON handoffs(run_id, to_phase, created_at);
`;

function userVersion(database: DatabaseDriver): number {
  return Number(
    database.prepare('PRAGMA user_version').get<{ user_version: number }>()?.user_version ?? 0,
  );
}

export function ensureDatabaseSchema(database: DatabaseDriver): number {
  const current = userVersion(database);
  if (current === CURRENT_SCHEMA_VERSION) return current;
  if (current !== 0) {
    throw new Error(
      `Unsupported database schema version ${current}. This release requires version ${CURRENT_SCHEMA_VERSION}. Back up the file, remove it, and let Issue Flow create a fresh database.`,
    );
  }
  database.transaction(() => {
    database.exec(CURRENT_SCHEMA);
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
  return CURRENT_SCHEMA_VERSION;
}
