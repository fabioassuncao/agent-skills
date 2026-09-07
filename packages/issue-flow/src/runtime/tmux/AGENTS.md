# src/runtime/tmux

The multiplexer the `interactive` and `sandbox` modes run agents in: one session
per project, one window per worktree, one pane per role.

Ported from WebMux `adapters/tmux.ts`, `adapters/project-env.ts` and
`services/session-service.ts`.

## Invariants

- **A dedicated socket, `-L issue-flow`** (ADR-09). The server this project
  talks to is never the user's own. That removes structurally the entire class
  of bug the upstream cures reactively — a session created here cannot inherit
  or pollute the environment of the user's personal tmux.
- **Every spawn uses `extendEnv: false`.** `execa` merges `process.env` by
  default; the upstream depends on the environment being *replaced*. Without the
  flag `stripProjectEnv` does nothing at all, silently.
- **A UTF-8 locale is pinned on every command.** Under a non-UTF-8 locale — a
  macOS launchd agent that inherits no `LANG`, for instance — tmux rewrites the
  TAB byte in `-F` output as `_`. Every parse of `list-windows` then produces
  nothing, so every window disappears and every session looks closed, with no
  error anywhere. This is the single most expensive thing to rediscover in this
  directory.
- **`destroy-unattached off` on every ensure.** It is what lets an agent keep
  working after the last viewer detaches. Applied when adopting an existing
  session too, not only when creating one.
- **Reopening does not kill.** `ensureSessionLayout` distinguishes `reattach`
  (the window is intact — select the pane and touch nothing else) from `resume`
  (panes are missing, so something died and rebuilding is correct) and `fresh`.
  The upstream kills unconditionally, which means reopening a worktree kills the
  agent working in it. The pane count is the signal: tmux removes a pane as soon
  as its command exits.
- **`listWindows()` asks once for everything** (ADR-13). One `list-windows -a`
  for every window of every session. Asking per entity is what turns
  reconciliation from O(1) into O(N). Measured: 6 ms at N=1, 14 ms at N=21.
- **Session creation is one invocation.** `new-session … ; set-option …` travel
  together, and `has-session` is not asked first. Each extra invocation is a
  process spawn costing about half the 30 ms budget §35 allows for an additional
  session.
- **No tmux is not an error; an installed tmux that cannot answer is unknown.**
  `isAvailable()` answers the first question and aggregate inventories return
  `[]` for an absent executable/server. Transport and protocol failures throw,
  so reconciliation never rewrites live rows from an unknown observation.
- **Pane ids, not coordinates, identify tab processes.** `%N` survives
  `swap-pane` and `join-pane`; `session:window.index` does not. A fork starts in
  the worktree's parking window and selection swaps/moves that pane into the
  visible agent slot without restarting it. The parking window lives on this
  same dedicated socket and never contains service panes.
- **Pane ids are scoped and epoch-authenticated.** `%N` can be reused when the
  dedicated server restarts, so it is never accepted alone. `getPaneIdentity`
  must also prove the project owner session encoded alongside the nonce in
  `@issue-flow-owner`, the exact main/parking window and the durable token stored
  with the AgentSession. `#{session_name}` alone is not ownership: a grouped
  viewer can make tmux report its `if-view-*` alias for the shared pane. A pane in
  another project session, a service pane, or a reused id is foreign and must
  not be moved or killed.
- **Grouped viewers are aliases, not pane owners.** `list-panes -a` repeats the
  same `%N` once per linked viewer session; ownership inventory excludes
  `if-view-*` aliases so reconciliation always observes the project owner.

## Names

Sessions are keyed by the Issue Flow **project id**, not by a hash of the path:
the id comes from the git remote, so it survives moving the directory and
matches across two clones. The upstream hashes the path because it has no other
identity available.

`:` and `.` are tmux target separators, so `sanitizeTmuxNameSegment` removes
them — a name carrying either turns `session:window.pane` into something that
resolves somewhere else entirely.

## Never

- Never spawn tmux without `extendEnv: false` and the pinned locale.
- Never let a command reach the user's default socket.
- Never kill a window without first establishing that its panes are gone.
- Never implement tab selection by killing a pane or window. Only explicit,
  confirmed fork deletion may call the strict single-pane teardown.
- Never ask tmux one question per entity where one aggregated call answers them
  all.
