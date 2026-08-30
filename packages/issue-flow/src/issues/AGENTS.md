# src/issues

Origin-agnostic Issue model, registry, resolution, relation graph, and
the only place commands may talk to GitHub or local issues. Built-in
providers live under `providers/`.

User-facing behaviour: [`docs/issues.md`](../../../../docs/issues.md).

## Invariants

- **Commands never call `gh issue *`.** Enforced by `migration.test.ts`.
  Resolve once, pass `__ISSUE_*` placeholders; `preResolved` must not
  re-query.
- **Extensible by registration.** `IssueSource` is open; a new origin
  needs no command or template edits. `ensureProvidersRegistered` is
  idempotent and never replaces a caller-registered provider.
- **`get` returning null ≠ throw.** Absent versus broken.
  `isAvailable` / `checkAvailability` never throw. Optional methods via
  `?.`.
- **Resolver is origin-agnostic.** Same `contentHash` → preferred (or
  first found), no prompt. Divergence follows `conflictPolicy`; non-TTY
  `ask` falls back to preferred + warning.
- **Hash is CRLF / trim-stable.** Local `contentHash` is always
  recomputed from `issue.md`.
- **Graph is structural only.** Expand parent / children / blockedBy /
  blocking; never expand plain `references`. Mentions are context.
  Parent/child is not a schedule constraint (`dependencyEdges`).
- **Validate labels, never create** (unless `allowLabelCreation`). An
  empty known set passes through (offline ≠ missing).
- **Local provider:** never mutate the filesystem in `isAvailable`;
  never write under `<projectRoot>/issues/`; paths go through
  `resolveIssuePaths`; create uses `wx`.

## Never

- Never shell `gh issue view|create|close` from commands or prompts.
- Never invent an Issue Type or default labels for "absent".
- Never expand mention-only citations into the execution graph.
- Never treat self as a dependency.
- Never materialize CLI override keys as `undefined` (would wipe
  config).
