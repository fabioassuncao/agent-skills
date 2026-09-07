# Web monitor

The monitor is a single machine-wide server that displays all registered Issue
Flow projects. Start it with:

```bash
issue-flow serve
```

`issue-flow run --web` and `issue-flow execute --web` reuse the healthy server
or start a detached one. The server uses `~/.issue-flow/web.lock` for ownership
and health verification.

## Dashboard

The dashboard shows projects, active sessions, execution history, worktrees,
agent tabs, services, Pull Requests, CI status and settings. It receives session
updates through `/api/stream` and can fall back to ordinary reads.

For Claude Code and Codex sessions, the worktree conversation surface reads
history and sends or interrupts turns through these loopback-only routes:

- `GET /api/agents/worktrees/:name/attach`
- `GET /api/agents/worktrees/:name/history`
- `POST /api/agents/worktrees/:name/messages`
- `POST /api/agents/worktrees/:name/interrupt`

Conversation updates are polled after mutations. Claude history comes from its
transcript gateway; Codex uses the app-server gateway.

## Safety boundary

Read-only status endpoints may be exposed on a configured network interface.
Worktree, agent, conversation, integration and preference mutations are served
only when the monitor is bound to loopback. Terminal WebSockets require the
short-lived credential returned by the loopback API.

`GET /api/health` reports the exact capability set offered by that server. The
dashboard hides operations whose capabilities are absent.
