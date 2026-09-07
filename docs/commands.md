# Command reference

The CLI help is the authoritative, version-matched command and option list:

```bash
issue-flow --help
issue-flow <command> --help
```

## Pipeline

- `run` — execute `prd → plan → execute → review → pr`, with optional
  `pr-review`.
- `analyze` — write the issue analysis artifact.
- `prd` — create the product requirements document.
- `plan` — create and validate the task plan.
- `execute` — execute the current plan. `--max-iterations` is the iteration
  limit.
- `review` — review the implementation.
- `pr` — create or update the Pull Request.
- `pr-review` — run the independent Pull Request review loop.
- `resume` — continue a paused or interrupted issue.

## Observation and control

- `status`, `ps`, `runs`, `history`, `usage`, `logs`
- `pause`, `cancel`, `retry`, `continue`
- `serve`, `web status`, `web stop`, `web restart`
- `session`, `worktree`, `project`, `agent`

## Issues and queues

- `issue create`, `issue show`, `issue close`
- `queue show`, `queue confirm`, `queue run`

## Database

- `db check` — validate the current SQLite database.
- `db backup` — create a database backup.
- `db restore` — restore a selected backup.
- `db export` — export structured database state as JSON.

## Configuration and diagnostics

- `config`, `doctor`, `completion`
- `routing inspect`, `routing report`, `routing explain`
- `benchmark`

Commands return `0` on success. Validation or user-input errors return a
non-zero code and print an actionable message.
