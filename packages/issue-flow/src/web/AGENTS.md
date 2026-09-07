# Monitoring server rules

This module owns the HTTP API, Server-Sent Events, terminal WebSocket,
single-instance coordination, project routing, and the bridge from SQLite to
the dashboard.

## Server lifecycle

- `web serve` is the only process that binds the long-lived monitor.
- `ensureWebMonitor` may reuse or start that process; pipeline commands never
  bind an in-process monitor.
- `web.lock` contains the current process, address, start time, and required
  instance identity. Reuse requires a matching health response.
- Binding, monitoring, and cleanup failures must not change a pipeline result.
- The standalone server keeps its socket referenced; reusable handles and
  cleanup remain idempotent.

## State source

- `SessionDirectoryHandle` backed by SQLite is the only session source.
- HTTP handlers do not read runtime JSON projections.
- `/api/sessions`, `/api/status`, `/api/events`, and `/api/agent-events` must
  agree on session identity and project scope.
- `/api/stream` publishes the same payloads returned by the corresponding GET
  routes. Keep subscriptions bounded and release them on disconnect.

## Routing

- Root routes are hub-wide. Project routes use the prefix resolved by
  `router.ts` and `projects/manager.ts`.
- Reserved prefixes are `api`, `ws`, `assets`, and `health`.
- All project-scoped mutations resolve the served project before touching its
  storage or worktrees.
- Unknown API routes return JSON 404s; unknown static assets return 404 without
  path traversal.

## Mutation safety

- Mutation routes are available only on loopback bindings.
- Terminal access additionally requires the per-server token.
- Worktree, agent-session, agent-registry, integration, and conversation routes
  use their domain gateways; `server.ts` only dispatches and serializes.
- Conversation routes attach to a current worktree, read provider-native
  history, send input through the active provider, and interrupt only an active
  turn.
- A route that lacks its backing capability returns an explicit unavailable
  response and is not advertised by `/api/health`.

## Dashboard assets

- `/` serves the built dashboard. An unbuilt checkout serves the small build
  instruction page and keeps `status.json` available.
- Only expected text assets are served from the build directory.
- Every response carries no-cache and security headers.

## Validation

Changes require server and contract tests, web tests, typecheck, and a browser
smoke test against a real `web serve` process. Terminal changes also require
the WebSocket and PTY tests; conversation changes require both Claude and Codex
gateway coverage.
