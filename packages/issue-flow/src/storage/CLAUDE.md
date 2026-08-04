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

## Gotchas

- `IssuePaths.prdFile` is `prd.md`; the task plan is `tasksFile` (`tasks.json`). This differs from
  the legacy `ResolvedPaths.prdFile` in `types.ts`, which points at `tasks.json`.
- Issue identifiers are not always numeric (`auth-refactor`, `pr-184`) — accept `string | number`.
- Tests that touch the filesystem must point `ISSUE_FLOW_HOME` at a `mkdtemp` directory.
- `paths.test.ts` mocks only `getRemoteUrl` from `../utils/git.js` (via `importOriginal` spread) so
  the real `normalizeRemoteUrl` keeps being exercised.
