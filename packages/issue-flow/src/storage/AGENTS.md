# src/storage

Resolved artifact storage layer (global by default, workspace-local by explicit
directory opt-in). Consumed by the pipeline commands through
`resolveIssuePaths()` (`analyze`, `prd`, `plan`, `review`, `pr`, `pr-review`, `run` and `execute`)
and by `LocalFileIssueProvider`, which resolves `issue.md` / `metadata.json` the same way.

The boundary with standalone Skill artifacts is documented in
[`docs/storage.md`](../../../../docs/storage.md) and the
[Skill integration contract](../../../../skills/README.md#artifacts-resumption-and-limits).

## Rules

- **`node:sqlite` has one boundary: `db/driver.ts`.** Consumers use its small
  `DatabaseDriver` interface; migrations and future repositories may issue SQL
  only under `src/storage/db/`. The driver owns connection PRAGMAs, the narrow
  SQLite ExperimentalWarning filter, transactions and online snapshots.

- **JSON-to-SQLite adoption is owned by `db/import.ts` and starts from
  `resolve.ts`.** Read all source artifacts before opening the project
  transaction, key `migrated_artifacts` by source path + SHA-256, and never
  mutate the JSON/JSONL source tree. An import failure must quarantine the
  database and let the existing JSON path continue.

- **The `projects` table is the project registry, and there is no second one.**
  `storage/projects/registry.ts` is the domain facade; the SQL lives in
  `db/projects.ts` like every other statement. Three rules make it work: the key
  is the `projectId`, never the path (a path is a locator and moves); nothing
  derivable from the repository is copied in (configuration stays in
  `.issue-flow.json`, the URL prefix is derived per process); and no
  `projects.json` is ever created next to the database. `source` classifies —
  `discovered` is what a plain `run` leaves behind, `registered` is curation,
  `ephemeral` is served in memory and **never written**, because a shared
  registry would otherwise make other servers adopt one server's cwd.
- **Registry reads never throw, and never create the database.** Both halves are
  load-bearing: they are called from boot paths where an exception would take
  down something more important than a project list, and opening the database
  *creates* it — the `json` compatibility driver has a test asserting no database
  file appears. Demotion (`project rm`) is a column update: runs, artifacts and
  telemetry hang off the id and outlive curation.

- **Never join `homedir()` by hand.** Every path under the global tree must derive from
  `getGlobalRoot()` in `paths.ts` — that is the single seam where `ISSUE_FLOW_HOME` takes effect,
  and it is what keeps tests, CI and sandboxes off the real `$HOME`.
- **Never build an issue path by hand either.** Ask `getIssuePaths(projectId, issueNumber)` for the
  artifact you need. Adding or renaming an artifact must stay a one-file change.
- **Outside this directory, always go through `resolveIssuePaths(issueNumber)` (`resolve.ts`)** —
  never `getIssuePaths()` directly. `paths.ts` and `compat.ts` are pure and take a `projectId` /
  `projectRoot` they never discover on their own; `resolve.ts` is the one place that knows the
  current repository, resolves the storage mode, triggers the legacy migration (project-level *and*
  per-issue) and caches the answer for the process. A command that calls `getIssuePaths()` itself
  skips the migration and reads an empty directory.
- `resolve.ts` never creates `.issue-flow/issues/` or an issue directory: a call
  site that writes keeps its own `mkdir(paths.issueDir, { recursive: true })`.
  When that opt-in directory already exists, resolution may create/update only
  `.issue-flow/.gitignore` with scoped operational-state rules.
- **This is enforced, not merely agreed on.** `handmade-issue-paths.test.ts` scans every
  non-test `src/**/*.ts` for a `join(...)` that names the `issues` segment itself and fails on it;
  only `paths.ts` and `compat.ts` are exempt. There is no `getIssueDir()` any more — it was removed
  rather than deprecated, precisely so no second way to resolve an issue directory can exist. If a
  new file legitimately needs the segment, it belongs in this directory, not in the allow-list.
- **A multi-issue queue resolves through `resolveQueuePaths(queueId)`**, same module and same
  cache. It resolves `<projectDir>/queues/<queueId>/execution-plan.json`, where `queueId` is the
  identifier of the primary issue — that is what lets `run 50` find the queue it started. There is
  no legacy tree for queues, so no migration is attempted, and nothing is created until a queue
  with more than one issue is actually persisted.
- **A question about the project rather than about one issue uses
  `resolveProjectPaths()`** (same module, same cache): "is this writable?" and "which identifiers
  are taken?" have no issue number to hand to `resolveIssuePaths()`. It returns `projectId`,
  `projectDir` and `issuesDir`; do not derive them from `dirname(paths.issueDir)`.
- **A headless phase that puts one of these paths in a prompt placeholder must also pass
  `addDirs: [issueDir]` to `runHeadless`** — the global tree is outside the working directory, so
  `claude -p` denies both the read and the write without a matching `--add-dir`. `core/executor.ts`
  (the `execute` phase) is the exception: it runs with `--dangerously-skip-permissions`.
- **A CLI prompt source in `prompts-src/`, and its generated `prompts/` artifact, must never spell out a path itself.** A relative `issues/<N>/…`
  written into a template silently points the agent at a directory that no longer exists — no error,
  just a step that quietly finds nothing (this is what happened to `prd.md`'s "read the analysis"
  step and to `generate.md`'s duplicate check). Resolve the path in the command, hand it over as a
  placeholder (`__ANALYSIS_PATH__`, `__LOCAL_ISSUES_DIR__`) and pair it with `addDirs`.
- **The migration notice is printed in `resolve.ts` and nowhere else** (`announceMigration`), gated
  on `MigrationResult.copied.length > 0`. `migrateLegacyStorage` is called speculatively — once per
  project, then once per issue first seen — so every run after the first copies zero files;
  announcing those would print a banner on every command. `compat.ts` itself never prints: it
  returns the result and lets the caller decide.
- Path helpers are pure and synchronous: they never create directories. Callers decide when (and
  whether) a directory should exist. `getProjectId()` is the exception — it is `async` because it
  shells out to `git remote get-url origin`, explicitly passing `projectRoot` as `cwd` so the
  result never depends on the calling process's own working directory. Its pure half is exported
  separately as `projectIdFromRemote(remote, projectRoot)`, so a caller that already resolved the
  remote for another reason (`compat.ts`'s `resolveStorageMode`, which also persists it into
  `metadata.json`) can derive the id without a second git call.
- Any identifier that becomes a path segment goes through validation first (see
  `normalizeIssueNumber` here and `normalizeId` in `issues/providers/local.ts`).
- Storage file formats live in `schemas.ts` here, not in `src/schemas.ts` (which stays focused on
  the pipeline domain: task plans, Issue metadata, session snapshots).
- **No `.default()` in an intermediate precedence layer.** `globalConfigSchema` is a middle layer
  (CLI > env > `.issue-flow.json` > `config.json` > defaults); a default materialized there is
  indistinguishable from a value the user wrote and silently overrides the layer above it.
  `resilienceConfigSchema` is the same kind of middle layer and follows the same rule — it is the
  format of the `resilience` key in **both** `config.json` and `.issue-flow.json`, which are two
  rungs of one ladder rather than two formats. Its enums are pinned to the types of
  `resilience/policy.ts` with `satisfies`, and `ResilienceConfigIsPolicyConfig` fails to compile if
  the file format ever stops being a superset of what `resolvePolicy()` reads.
- **`TaskPlan.executions` is additive and optional, with no `.default([])`.**
  SQLite is canonical for execution rows; `db/repository.ts` joins them into
  the materialized plan only when rows exist. `schemaVersion` does not change.
  Reconciliation of orphan `running` rows happens in `loadTaskPlan` via
  `telemetry/reconcile.ts`, using `isProcessAlive`.
- **`TaskPlan.runState` and the queue's `attempts`/`blockedReason` are additive, and
  `schemaVersion` stays `1`.** `runState` is `.optional()` with **no** default at the top
  level — absent means "this plan predates the field", which is not the same statement as
  `idle` — while every field *inside* it defaults, so a process killed mid-write leaves a
  half-object that still parses. On the queue the two new fields do carry `.default()`
  (`0` and `null`), because a plan written before them meant exactly "never attempted, not
  blocked". The `pipeline` booleans stay the resumption contract: `PipelineManager` reads
  them and nothing else, and `runState` is additional information, never a replacement.
- **`lock.ts` owns run ownership, and `web/lock.ts` now shares its liveness probe.** Same
  guard as the monitoring server — atomic `wx` create, `process.kill(pid, 0)` where **only
  `ESRCH` means dead** (`EPERM` is a live process owned by another user), and a read that
  degrades anything malformed to "no lock". What a long run adds is the **heartbeat**: a
  server proves it is alive by answering a health probe, a pipeline has no port, so it says
  so in the file every 10s and is stale after three missed beats. A lock written on another
  host is judged by the heartbeat **alone** — our pid table says nothing about a process
  over there. The lock is project-level (`<projectDir>/run.lock`): two runs in one
  repository share a working tree and a branch, so "a different issue" is not a different
  lock. Re-entering from the same pid+host is not a conflict and its release is a no-op —
  a nested acquisition must never remove the file the outer one still owns.
  `detached` is optional and additive: a lock written before it existed is a
  foreground run. `run.log` / `run.log.1` live on `IssuePaths` and are owned
  by `--background`; rotation is size-capped in `run-log.ts`.
  Machine-wide diagnostics are different: `diagnostics.ts` owns dated JSONL
  files under `getDiagnosticsDir()`, correlation fields, recursive secret
  redaction, 10 MiB rotation (five generations) and 30-day retention. Its
  queued best-effort writes must never make the pipeline fail.
  `execution/registry.ts` is the only cross-project reader of `run.lock`.
- **Provider health is SQLite-authoritative.** `providers.json` is a legacy
  JSON fallback whose path comes from `resolveProjectPaths().providersHealthFile`;
  agent code never joins the name. Health transitions go through
  `storage/db/repository.ts`, so cooldown and failure history survive restarts
  transactionally.
- Schemas read from disk are never `.strict()`: a file written by a newer version must stay
  readable by an older one.
- The *reader* of `config.json` lives in `src/config.ts` (`loadGlobalConfig`), next to the other
  loaders and to `mergeConfigLayers` — this directory owns the **format**, `config.ts` owns the
  **precedence**. Keep new loaders there rather than splitting precedence across two modules.
- **`<projectRoot>/issues/` is read-only forever.** `compat.ts` copies out of it and never writes,
  renames or deletes inside it — there is deliberately no removal option, not even opt-in. If a
  cleanup command is ever wanted, it belongs in its own explicit, user-confirmed code path.
- Migration is idempotent through one rule: **a destination file that already exists is skipped,
  never overwritten.** That is also what makes a failed run resumable — re-running it picks up
  where it stopped instead of clobbering what already crossed over.

- The user-facing documentation of this layer is [`docs/storage.md`](../../../../docs/storage.md)
  (tree, project id derivation, `ISSUE_FLOW_HOME`, `tasks.json`, `session.json`, telemetry,
  migration). Changing the layout, the id format or the precedence means changing that document in
  the same commit — and `paths.test.ts` already fails on purpose when its `## One issue directory`
  listing drifts from `getIssuePaths()`. That listing is the only place an issue artifact is named
  in prose; the tree above it stops at `issues/42/` so there is nothing to keep in sync twice.

## Gotchas

- `IssuePaths.prdFile` is `prd.md`; the task plan is `tasksFile` (`tasks.json`). This differs from
  the engine's `ResolvedPaths.prdFile` in `types.ts`, which points at `tasks.json` — so
  `resolvePaths()` in `config.ts` maps `prdFile → IssuePaths.tasksFile` on purpose. Wiring it to
  `IssuePaths.prdFile` would hand the engine a Markdown document where it expects a task plan.
- `resolvePaths()` forwards the `projectRoot` it already resolved to `resolveIssuePaths()`; a call
  site that has the root in hand should do the same instead of letting the resolver shell out to
  `git rev-parse --show-toplevel` again.
- Issue identifiers are not always numeric (`auth-refactor`, `pr-184`) — accept `string | number`.
- **The safety net is `src/test-setup.ts`** (vitest `setupFiles`): it points `ISSUE_FLOW_HOME` at a
  throwaway `mkdtemp` for every test file, so a suite that forgets its own setup can no longer write
  into the real `~/.issue-flow`. It must not import anything from `src/` — doing so loads that
  module and its `utils/git.js` dependency into the registry before a test file's `vi.mock()` calls
  are hoisted, and every one of those mocks silently stops applying (60 tests failed exactly that
  way). `storage/test-home.test.ts` guards both the net and the duplicated variable name.
- Tests that touch the filesystem must point `ISSUE_FLOW_HOME` at a `mkdtemp` directory — the net
  above is per *file*, so per-*case* isolation is still each suite's job. A test that
  drives a **command** (rather than a storage helper) has to set it on the real `process.env` and
  restore it afterwards — commands call `resolveIssuePaths()` with no options, so the `{ env }` seam
  never reaches them. Pair it with `resetStorageResolutionCache()` in `beforeEach`, or the previous
  case's project resolution leaks into the next one. This applies to any test whose call graph
  *reaches* a resolver, not only to the ones that assert on paths: `run.test.ts` writes into the
  real `~/.issue-flow` the moment the summary calls `prReviewDir()`. When a file has several
  `describe` blocks with their own hooks, put the `ISSUE_FLOW_HOME` setup in **file-level**
  `beforeEach`/`afterEach` (they run around each block's own hooks) so no block can forget it.
- **A test that mocks `utils/shell.js` (or `execa`) wholesale also intercepts `getRemoteUrl`.** The
  double must answer `git` first — `exitCode: 1`, i.e. no remote — or the payload meant for `gh`
  becomes the project's "remote" and the whole global tree moves to a different `projectId`
  (`local.test.ts`'s `mockGh` is the shape to copy).
- **A `mockImplementation` that writes to a resolved path leaks across `describe` blocks.**
  `vi.clearAllMocks()` clears calls but keeps implementations, so a phase double installed in one
  block still runs in the next one. While each block wrote under its own `join(tmp, 'issues', …)`
  the stale write landed in an already-deleted directory and was harmless; now that every block
  resolves to the same `<globalHome>/projects/<id>/issues/<N>/`, it silently overwrites the next
  block's plan. Use `mockImplementationOnce` for doubles that touch the filesystem.
- `paths.test.ts` mocks only `getRemoteUrl` from `../utils/git.js` (via `importOriginal` spread) so
  the real `normalizeRemoteUrl` keeps being exercised.
- `resolve.cwd.test.ts` mocks **nothing**: the CWD-independence guarantee is about what
  `git rev-parse --show-toplevel` answers from a subdirectory, so it needs a real `git init` and a
  real `process.chdir` (restored in `afterEach`). Keep it in its own file — the file-level
  `vi.mock('../utils/git.js')` of `resolve.test.ts` would fake away the very thing under test.
- Filesystem walks use `readdir(dir, { withFileTypes: true })` and act only on `isDirectory()` /
  `isFile()`. Symlinks are skipped on purpose: following one could copy content from outside the
  legacy directory into the global tree.
- `isoNow()` lives in `core/state-manager.ts` and is reused here; functions that stamp timestamps
  take an injectable `now?: () => string` so tests can assert `createdAt` vs `updatedAt` without
  faking the clock globally.
- **zod 4 applies a `.default()` even through `.optional()`**: `.partial()` does *not* strip
  defaults — `z.object({ p: z.number().default(1) }).partial().parse({})` returns `{ p: 1 }`. To
  reuse a field from a defaulted schema without its default, call `.unwrap()` on it
  (`webConfigSchema.shape.port.unwrap()`), which keeps the constraints. This also means the layer
  `readWebConfigFile()` (`config.ts`) returns already carries every web default.
