# Worktree runtime rules

This module owns Git worktree paths, creation, binding, synchronization,
archiving, garbage collection, and rollback.

- Branch names are validated before use.
- Worktrees live under the configured Issue Flow runtime root and are keyed by
  project plus branch.
- SQLite bindings are authoritative for runtime ownership.
- Creation is plan-then-apply: validate first, record each completed side
  effect, and roll back only effects created by the current operation.
- A worktree with an active authenticated pane cannot be removed.
- Git operations use the shared git helpers and explicit repository roots.
- Cleanup resolves exact paths and refuses the project root, workspace root,
  home directory, or any path outside the managed worktree root.
- Archive and garbage collection preserve active sessions and report partial
  failures without broad deletion.
- Port allocation is deterministic per binding and checked before publication.

Changes require lifecycle, Git, path-safety, binding, and rollback tests.
