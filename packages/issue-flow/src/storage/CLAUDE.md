# src/storage

Global storage layer (`~/.issue-flow`). Consumed by the pipeline commands through
`resolveIssuePaths()` (`analyze`, `prd`, `plan`, `review`, `pr`, `pr-review`, `run` and `execute`)
and by `LocalFileIssueProvider`, which resolves `issue.md` / `metadata.json` the same way.

## Rules

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
- `resolve.ts` still creates nothing: a call site that writes keeps its own
  `mkdir(paths.issueDir, { recursive: true })`.
- **This is enforced, not merely agreed on.** `handmade-issue-paths.test.ts` scans every
  non-test `src/**/*.ts` for a `join(...)` that names the `issues` segment itself and fails on it;
  only `paths.ts` and `compat.ts` are exempt. There is no `getIssueDir()` any more — it was removed
  rather than deprecated, precisely so no second way to resolve an issue directory can exist. If a
  new file legitimately needs the segment, it belongs in this directory, not in the allow-list.
- **A question about the project rather than about one issue uses
  `resolveProjectPaths()`** (same module, same cache): "is this writable?" and "which identifiers
  are taken?" have no issue number to hand to `resolveIssuePaths()`. It returns `projectId`,
  `projectDir` and `issuesDir`; do not derive them from `dirname(paths.issueDir)`.
- **A headless phase that puts one of these paths in a prompt placeholder must also pass
  `addDirs: [issueDir]` to `runHeadless`** — the global tree is outside the working directory, so
  `claude -p` denies both the read and the write without a matching `--add-dir`. `core/executor.ts`
  (the `execute` phase) is the exception: it runs with `--dangerously-skip-permissions`.
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

- The user-facing documentation of this layer is the `## Global Storage` section of the root
  `README.md` (tree, project id derivation, `config.json` schema, precedence table,
  `ISSUE_FLOW_HOME`, migration). Changing the layout, the id format or the precedence means
  changing that section in the same commit — and `paths.test.ts` already fails on purpose when the
  `## Pipeline State & File Structure` tree drifts from `getIssuePaths()`.

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
