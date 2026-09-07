# Storage

Issue Flow uses one SQLite database as its authoritative store. The default
location is `~/.issue-flow/issue-flow.db`; set `ISSUE_FLOW_HOME` to move the
entire machine-wide data directory.

## Global tree

```text
~/.issue-flow/
  issue-flow.db
  config.json
  web.lock
  web.restart.lock
  projects/
    <project-id>/
      run.lock
      locks/
      issues/
        <issue-id>/
```

`<project-id>` is derived from the normalized Git remote, or from the absolute
repository path when no remote exists. The database contains projects, issues,
pipelines, stories, runs, phases, executions, events, snapshots, queues,
worktrees, agent sessions, Pull Requests, reviews, verification results,
provider health and audit entries.

The files below are projections or human/agent-facing artifacts. They are not a
second database.

## One issue directory

```text
<issue-id>/
  issue.md
  metadata.json
  analysis.md
  prd.md
  tasks.json
  progress.txt
  run.log
  run.log.1
  decomposition.md
  verify.json
  .last-branch
  archive/
  pr-review/
```

`tasks.json` is materialized from SQLite for execution agents. Changes an agent
is allowed to make are validated and merged back into SQLite. Session state,
events, execution telemetry and provider health are queried directly from the
database.

## Schema policy

The current database schema version is `23`. A fresh database is created at
that version. A database with any other non-zero schema version is rejected
with an error; replace it with a current backup or start with an empty Issue
Flow home.

## Retention and backup

Optional `storage.retention` values control the number of execution, event,
snapshot and backup rows retained. Omitted values retain history. Use
`issue-flow db backup`, `issue-flow db restore`, `issue-flow db check` and
`issue-flow db export` for database operations.
