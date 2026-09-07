# Storage rules

This module owns project identity, artifact paths, SQLite access, retention,
locks, diagnostics, and the project registry.

## Canonical state

- SQLite is the only operational store. Open it through `storage/db/index.ts`.
- `tasks.json`, PRD Markdown, issue Markdown and metadata are agent-facing
  artifacts, not alternate runtime databases.
- Session events, snapshots, executions, provider health, worktrees, agent
  sessions, inline issues, queues, handoffs, Pull Requests and reviews live in
  SQLite.
- The current database schema is created as a whole. A non-empty database with
  a different `user_version` is rejected.

## Resolution

- Every consumer resolves paths through `resolveIssuePaths`,
  `resolveProjectPaths`, or `resolveQueuePaths`.
- Do not join `~/.issue-flow`, `.issue-flow`, `projects`, `issues`, or queue
  paths at call sites.
- Global storage is the default. An existing workspace `.issue-flow/issues`
  directory selects workspace storage for that checkout.
- `ISSUE_FLOW_HOME` is the supported isolation seam for tests and embedding.
- Resolving paths registers the associated SQLite repository context. Writers
  must not silently fall back when that context is absent.

## Database discipline

- Use the small `DatabaseDriver` interface; keep `node:sqlite` inside
  `storage/db/driver.ts`.
- Multi-row state changes are transactional.
- Preserve foreign-key ownership by upserting the project and issue rows before
  dependent records.
- Apply explicit positive retention limits only. Omitted limits retain history.
- Tests always provide a temporary `ISSUE_FLOW_HOME` or explicit database
  options; they must never touch a developer's store.

## Artifacts

- Use `artifact-paths.ts` and `paths.ts` for filenames and locations.
- Writes use atomic helpers from `utils/fs.ts`.
- Agent-generated `tasks.json` is validated before ingestion. Fields controlled
  by the pipeline, such as closure authorization, cannot be granted by agent
  output.
- Projection windows prevent telemetry writes from overwriting an agent's
  pending task-plan mutation.

## Locks and diagnostics

- Lock ownership is an exact tuple. Cleanup removes only a lock still owned by
  the caller.
- Process liveness checks treat `EPERM` as alive.
- Diagnostic writes are best effort and must not change the pipeline result.
- Destructive cleanup must resolve and validate its exact target first.

## Validation

Changes here require focused storage tests, the CLI suite, typecheck, and
`git diff --check`. Schema changes also require fresh-database creation,
integrity, backup, and repository round-trip tests.
