# src/storage

Global storage layer (`~/.issue-flow`). Additive module: no pipeline command consumes it yet.

## Rules

- **Never join `homedir()` by hand.** Every path under the global tree must derive from
  `getGlobalRoot()` in `paths.ts` — that is the single seam where `ISSUE_FLOW_HOME` takes effect,
  and it is what keeps tests, CI and sandboxes off the real `$HOME`.
- **Never build an issue path by hand either.** Ask `getIssuePaths(projectId, issueNumber)` for the
  artifact you need. Adding or renaming an artifact must stay a one-file change.
- Path helpers are pure and synchronous: they never create directories. Callers decide when (and
  whether) a directory should exist. `getProjectId()` is the exception — it is `async` because it
  shells out to `git remote get-url origin`.
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

## Gotchas

- `IssuePaths.prdFile` is `prd.md`; the task plan is `tasksFile` (`tasks.json`). This differs from
  the legacy `ResolvedPaths.prdFile` in `types.ts`, which points at `tasks.json`.
- Issue identifiers are not always numeric (`auth-refactor`, `pr-184`) — accept `string | number`.
- Tests that touch the filesystem must point `ISSUE_FLOW_HOME` at a `mkdtemp` directory.
- `paths.test.ts` mocks only `getRemoteUrl` from `../utils/git.js` (via `importOriginal` spread) so
  the real `normalizeRemoteUrl` keeps being exercised.
- **zod 4 applies a `.default()` even through `.optional()`**: `.partial()` does *not* strip
  defaults — `z.object({ p: z.number().default(1) }).partial().parse({})` returns `{ p: 1 }`. To
  reuse a field from a defaulted schema without its default, call `.unwrap()` on it
  (`webConfigSchema.shape.port.unwrap()`), which keeps the constraints. This also means the layer
  `readWebConfigFile()` (`config.ts`) returns already carries every web default.
