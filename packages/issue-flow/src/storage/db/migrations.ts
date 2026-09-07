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

/**
 * Forward-only migrations, applied in order.
 *
 * **Version numbers have gaps**, and that is deliberate rather than a sign that
 * something was lost. The WebMux absorption ran its phases in parallel, and
 * each was given a reserved number up front so two of them could never write
 * the same one; the phases that turned out not to need a schema change left
 * theirs unused. A gap costs nothing — `migrateDatabase` applies whatever is
 * greater than the recorded version and stamps each as it goes — and renumbering
 * afterwards would rewrite the history of databases that already migrated.
 */
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
  {
    version: 8,
    name: 'explicit issue closure authorization',
    up: (database) =>
      database.exec(`
      ALTER TABLE pipelines ADD COLUMN close_issue INTEGER CHECK (close_issue IN (0, 1));
      ALTER TABLE pipelines ADD COLUMN issue_closed_at TEXT;
    `),
  },
  {
    version: 9,
    name: 'persist agent lifecycle events reported by hooks',
    // The upstream this is absorbed from keeps runtime events in memory only
    // (§2.5). Persisting them is the deliberate difference: an `awaiting_input`
    // that happens while nobody is watching is precisely the one worth knowing
    // about afterwards.
    //
    // `run_id` has no foreign key on purpose. The event arrives from a hook in
    // the agent's process, and the mundane race — a hook firing before the
    // run's first snapshot has been committed — must not lose the event.
    // ADR-08 also puts authority over existence outside SQLite.
    up: (database) =>
      database.exec(`
        CREATE TABLE agent_events (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          type TEXT NOT NULL,
          lifecycle TEXT CHECK (lifecycle IN ('starting', 'running', 'idle', 'stopped')),
          payload_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        );
        CREATE INDEX agent_events_run_occurred_idx ON agent_events(run_id, occurred_at);
      `),
  },
  {
    version: 10,
    name: 'curate the known projects registry',
    // The `projects` table already existed as a foreign-key anchor: a row is
    // created the first time a project runs. What it could not answer is
    // "which projects does this user actually work on" — a project only
    // appeared after it had executed at least once.
    //
    // These four columns turn the same table into the single Project Registry
    // (§47.2) instead of adding a second state file next to the database.
    // Nothing derivable from the repository is stored here: `name` is a label,
    // the rest is curation and recency. The URL prefix stays *derived* per
    // process (`storage/projects/prefix.ts`), never persisted, so moving or
    // renaming a checkout cannot strand a route.
    //
    // `source` is what keeps direct mode intact: `discovered` is what a plain
    // `issue-flow run` already creates (hence the default, which reclassifies
    // no existing row), `registered` is explicit curation, and `ephemeral` is
    // never written — it exists in the domain, in memory only, for a repo that
    // one `serve` process happens to sit in. Demotion is a column update:
    // `project rm` never destroys runs, artifacts or telemetry.
    up: (database) =>
      database.exec(`
        ALTER TABLE projects ADD COLUMN name TEXT;
        ALTER TABLE projects ADD COLUMN added_at TEXT;
        ALTER TABLE projects ADD COLUMN last_seen_at TEXT;
        ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'discovered'
          CHECK (source IN ('registered', 'discovered', 'ephemeral'));
        CREATE INDEX projects_source_last_seen_idx ON projects(source, last_seen_at DESC);
      `),
  },
  {
    version: 11,
    name: 'bind managed worktrees to their project',
    // ADR-08 draws the line this table sits on: git is the authority on
    // whether a worktree *exists*, SQLite on what it is *bound to* — which
    // branch, which agent, which conversation to resume, which ports it owns.
    // A row whose directory git no longer lists is `orphaned`, never recreated.
    //
    // The upstream keeps the same model in a `meta.json` per worktree
    // (§45.2-G). The model is kept; the vehicle is not, because a second store
    // beside the database is a second thing that can disagree with it.
    up: (database) =>
      database.exec(`
        CREATE TABLE worktrees (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          branch TEXT NOT NULL,
          path TEXT NOT NULL,
          base_branch TEXT,
          label TEXT,
          profile TEXT NOT NULL,
          agent TEXT NOT NULL,
          runtime TEXT NOT NULL CHECK (runtime IN ('host', 'docker')),
          startup_env_json TEXT NOT NULL,
          allocated_ports_json TEXT NOT NULL,
          source TEXT,
          conversation_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX worktrees_project_branch_idx ON worktrees(project_id, branch);
      `),
  },
  {
    version: 12,
    name: 'bind an agent conversation to a run, a phase and a worktree',
    // The durable half of a session (§27): the provider owns the conversation
    // itself, this row owns what it is *for*. `run_id`, `phase` and `story_id`
    // are nullable on purpose (ADR-16) — a free session is the same entity with
    // those columns empty, which is what avoids a second execution model.
    //
    // `conversation_id` is the provider's own id and is what makes `--resume`
    // possible: without it a reopened worktree can only start over.
    up: (database) =>
      database.exec(`
        CREATE TABLE agent_sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT,
          phase TEXT,
          story_id TEXT,
          branch TEXT NOT NULL,
          worktree_id TEXT,
          provider TEXT NOT NULL,
          conversation_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'idle', 'stopped', 'orphaned')),
          pane_target TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          ended_at TEXT
        );
        CREATE INDEX agent_sessions_project_branch_idx ON agent_sessions(project_id, branch);
        CREATE INDEX agent_sessions_run_idx ON agent_sessions(run_id);
      `),
  },
  {
    version: 15,
    name: 'record that a human took over a run',
    // A hold is *intent*, and intent is what SQLite is the authority over
    // (ADR-08). It also has to cross a process boundary — the person types in
    // the monitor, the watchdog runs in the pipeline — and outlive both, which
    // rules out an in-memory flag.
    up: (database) =>
      database.exec(`
        ALTER TABLE runs ADD COLUMN human_hold_at TEXT;
        ALTER TABLE runs ADD COLUMN human_hold_reason TEXT;
      `),
  },
  {
    version: 17,
    name: 'name a session that has no issue to name it',
    // A free session (ADR-16) has no run, no phase and no story, so the three
    // columns a workflow session is identified by are all empty. Without a
    // label the only thing left to show a person is a uuid and a branch, and
    // the branch of a session opened without `--branch` is generated.
    //
    // Nullable and unconstrained on purpose: it is a human caption, never an
    // identity. Nothing looks a session up by it, and a workflow session that
    // never sets one is not missing anything — its issue already names it.
    up: (database) => database.exec('ALTER TABLE agent_sessions ADD COLUMN label TEXT'),
  },
  {
    version: 18,
    name: 'accept a free-form prompt as an issue of its own',
    // §17 converges `webmux oneshot` into `issue-flow run`: a demand typed on
    // the command line enters the pipeline as an Issue like any other, under
    // the `inline` origin. It needs somewhere to live, because every phase
    // after the first re-resolves the Issue by id, and so does `resume`.
    //
    // It is a table rather than a file for the reason the local provider is a
    // file: the local origin's issues are *authored* (a person edits
    // `issue.md`), while an inline one is *dictated once* and never edited.
    // Storing it beside the run that owns it keeps the repository clean — a
    // one-line demand must not leave a directory behind — and keeps the two
    // origins from ever answering for the same identifier.
    //
    // The primary key is `(project_id, id)`, not `id`: the identifier is
    // derived from the prompt's content, so the same demand typed in two
    // repositories is two issues, exactly as it would be on GitHub.
    up: (database) =>
      database.exec(`
        CREATE TABLE inline_issues (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
          content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (project_id, id)
        );
      `),
  },
  {
    version: 19,
    name: 'hand structured context from one phase to the next',
    // §29: agents do not talk over a terminal. What one phase learned reaches
    // the next as a persisted, auditable row — written at the end of a phase
    // and read at the start of the following one.
    //
    // `run_id` has no foreign key for the same reason `agent_events` has none:
    // the row is evidence of something that happened, and losing it to an
    // ordering race would defeat the point of writing it down.
    up: (database) =>
      database.exec(`
        CREATE TABLE handoffs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL,
          from_session_id TEXT,
          from_phase TEXT NOT NULL,
          from_provider TEXT NOT NULL,
          to_phase TEXT NOT NULL,
          to_provider TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          consumed_at TEXT
        );
        CREATE INDEX handoffs_run_target_idx ON handoffs(run_id, to_phase, created_at);
      `),
  },
  {
    version: 20,
    name: 'remember archived worktrees',
    // Archive is curation, not git state. It therefore belongs beside the
    // worktree binding rather than in a second dashboard-only registry.
    up: (database) =>
      database.exec(`
        ALTER TABLE worktrees ADD COLUMN archived INTEGER NOT NULL DEFAULT 0
          CHECK (archived IN (0, 1));
      `),
  },
  {
    version: 21,
    name: 'preserve semantic permission on agent sessions',
    // Existing sessions predate this field and ran with the historical
    // workspace default. Persisting it prevents reopen/profile operations from
    // silently widening a read-only session back to workspace.
    up: (database) =>
      database.exec(`
        ALTER TABLE agent_sessions ADD COLUMN permission TEXT NOT NULL DEFAULT 'workspace'
          CHECK (permission IN ('read-only', 'workspace', 'autonomous'));
      `),
  },
  {
    version: 22,
    name: 'persist worktree agent tabs and active session',
    // A tab is another AgentSession in the same worktree (ADR-16), not a
    // dashboard layout row. The provider conversation id remains separate.
    // The counter lives on the worktree so deleting Fork 2 never recycles 2.
    up: (database) =>
      database.exec(`
        ALTER TABLE agent_sessions ADD COLUMN parent_session_id TEXT;
        ALTER TABLE agent_sessions ADD COLUMN tab_sequence INTEGER
          CHECK (tab_sequence IS NULL OR tab_sequence >= 0);
        ALTER TABLE agent_sessions ADD COLUMN pane_token TEXT;
        ALTER TABLE worktrees ADD COLUMN active_agent_session_id TEXT;
        ALTER TABLE worktrees ADD COLUMN tab_sequence_counter INTEGER NOT NULL DEFAULT 0
          CHECK (tab_sequence_counter >= 0);
        -- A pre-v22 row had no durable worktree incarnation. It is safe to
        -- adopt only when it is the sole session ever seen for that branch;
        -- multiple rows may belong to older incarnations after branch reuse.
        UPDATE agent_sessions
           SET worktree_id = (
             SELECT worktrees.id
               FROM worktrees
              WHERE worktrees.project_id = agent_sessions.project_id
                AND worktrees.branch = agent_sessions.branch
           )
         WHERE worktree_id IS NULL
           AND 1 = (
             SELECT COUNT(*)
               FROM agent_sessions AS same_branch
              WHERE same_branch.project_id = agent_sessions.project_id
                AND same_branch.branch = agent_sessions.branch
           );
        UPDATE agent_sessions
           SET tab_sequence = 0
         WHERE id IN (
           SELECT (
             SELECT chosen.id
               FROM agent_sessions AS chosen
              WHERE chosen.project_id = worktrees.project_id
                AND chosen.branch = worktrees.branch
                AND chosen.worktree_id = worktrees.id
              ORDER BY
                CASE chosen.status
                  WHEN 'running' THEN 0
                  WHEN 'idle' THEN 1
                  WHEN 'starting' THEN 2
                  ELSE 3
                END,
                chosen.updated_at DESC,
                chosen.id DESC
              LIMIT 1
           )
             FROM worktrees
         );
        UPDATE worktrees
           SET active_agent_session_id = (
             SELECT agent_sessions.id
               FROM agent_sessions
              WHERE agent_sessions.project_id = worktrees.project_id
                AND agent_sessions.worktree_id = worktrees.id
                AND agent_sessions.tab_sequence = 0
              LIMIT 1
           );
        CREATE INDEX agent_sessions_parent_sequence_idx
          ON agent_sessions(project_id, parent_session_id, tab_sequence);
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
