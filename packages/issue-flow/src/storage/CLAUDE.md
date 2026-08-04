# src/storage

Global storage layer (`~/.issue-flow`). Additive module: no pipeline command consumes it yet.

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
  the legacy `ResolvedPaths.prdFile` in `types.ts`, which points at `tasks.json`.
- Issue identifiers are not always numeric (`auth-refactor`, `pr-184`) — accept `string | number`.
- Tests that touch the filesystem must point `ISSUE_FLOW_HOME` at a `mkdtemp` directory.
- `paths.test.ts` mocks only `getRemoteUrl` from `../utils/git.js` (via `importOriginal` spread) so
  the real `normalizeRemoteUrl` keeps being exercised.
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
