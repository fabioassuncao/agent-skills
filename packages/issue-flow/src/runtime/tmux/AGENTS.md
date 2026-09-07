# tmux runtime rules

This module owns the dedicated tmux socket, project sessions, worktree windows,
pane layouts, environment propagation, and ownership tags.

- Use `TmuxGateway`; other modules do not shell out to tmux.
- Project session and worktree window names come from `names.ts`.
- Stable pane ids (`%N`) and owner tokens are required for mutation or
  teardown. Named/positional targets are not accepted as ownership proof.
- A worktree window contains the configured agent, shell, and command panes.
- Environment values are applied through tmux environment commands and must be
  stripped from command strings and logs.
- Grouped viewer sessions are scoped by process and never own project windows.
- Strict kill operations verify session, window, pane id, and owner token.
- Reconciliation may repair durable pointers; it never kills an unproven
  process.

Changes require gateway, naming, layout, ownership, and terminal attachment
tests.
