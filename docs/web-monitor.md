# Web monitoring

`run` and `execute` accept `--web`: a local HTTP server serves a self-contained,
**read-only** dashboard showing live progress — current phase and activity, user
stories, resilience state, commits, pull requests, logs, tokens, cost and time
estimates. It is off by default, works offline (no CDN, no external resource),
and polls the server at a configurable interval.

```bash
issue-flow run 42 --web                            # http://localhost:3737
issue-flow run 42 --web --port 8080 --refresh 10
issue-flow run 42 --web --host 127.0.0.1           # this machine only
issue-flow web stop                                # stop the monitor explicitly
```

Monitoring never affects the pipeline: publishing failures are swallowed with a
single warning, a busy port (`EADDRINUSE`) just skips the server, and killing the
server or closing the browser mid-run has no effect on the execution. With
`--web` off, the terminal output and behaviour are byte-for-byte identical.

## The dashboard

With two or more active sessions, the panel opens on the executions dashboard —
one card per run, from every project on this machine:

![Executions dashboard: one card per active run](screenshots/painel-execucoes.png)

Clicking a card opens that session's detail view. A *"Todas as execuções"*
control returns to the dashboard even when only one run exists; with exactly one
active session the panel opens straight into the detail view.

## The detail view

![Execution detail: issue summary, repository, progress, current activity, resilience, phases, stories, commits and logs](screenshots/painel-execucao.png)

At the top, two cards give the full context of the run without leaving the
browser: **"Resumo da issue"** (number, title, full description, labels and
open/closed state — with a neutral "Não definida" placeholder for priority, since
the `Issue` domain has no such field) and **"Repositório"** (current branch,
short HEAD commit, repository name and the project's working directory).

Below the header and the alerts, the panel is split into three tabs.

**"Execução"** is the view above: progress, the *"Executando agora"* card, the
live resilience projection (current attempt, provider/model, last failure kind,
cooldown and last real agent activity), the phase list with per-phase tokens and
cost, user stories, commits, pull requests and recent logs.

The resilience card is where a provider migration shows up:

![Detail view of a run that failed over from Claude to Codex](screenshots/painel-resiliencia.png)

**"Kanban"** is a second reading of the same data — every story in four columns
(**Backlog**, **Em andamento**, **Em revisão**, **Concluído**), grouped by the
story's [`status`](storage.md#story-status), each column showing its own count:

![Kanban tab: user stories grouped by status](screenshots/painel-kanban.png)

A story whose `status` is absent (an older `session.json`) or unrecognized falls
into Backlog rather than disappearing, and every column renders even when empty.
Clicking a card — or focusing it and pressing Enter — opens a **side drawer**
with the story's full title, status, description, acceptance criteria, declared
dependencies, and its duration and completion time when known. The drawer closes
on the overlay, the close button or `Esc`, and returns focus to the card that
opened it. It issues **no** additional network requests: everything it shows
already came with the snapshot.

**"Histórico"** reads the append-only [journal](resilience.md#the-event-journal)
and lists the run's pipeline, retry, failure and failover events, with
pipeline/resilience filters. When journaling is disabled or the files do not
exist, it renders an empty state.

Switching tabs never interrupts polling: both views are re-rendered on every
refresh, so the Kanban is already current the moment it is opened, and an open
drawer stays open across refreshes, updating in place.

## Read-only by contract

`snapshot.readOnly` stays `true`, `capabilities` stays empty, and the server
registers no write route. The interface exposes no control that edits, deletes,
reorders or changes the status of anything.

## Single instance, detached from the pipeline

There is at most **one** monitoring server per machine, and it outlives any
single `run`/`execute` invocation:

- The first `--web` invocation on a machine spawns the server as its own
  **detached background process** instead of binding inline — the pipeline
  process that triggered it can exit normally (including a plain `Ctrl-C`)
  without taking the monitor down. Ownership is tracked in
  [`~/.issue-flow/web.lock`](storage.md#issue-flowweblock).
- Every subsequent `--web` invocation, from the same project or a different one,
  detects the live instance (`pid` alive **and** `GET /api/health` answers) and
  **reuses it** — no port conflicts, no silently-degraded second monitor.
- The server is single-instance, not single-session: it watches the whole
  `~/.issue-flow` tree and reflects **every** active run, from every project, at
  once.
- `issue-flow web stop` sends a graceful shutdown signal and waits for
  `web.lock` to be removed; with no monitor running, it says so and exits `0`.
  There is no other way to stop it short of killing the pid — closing every
  browser tab or ending every `run --web` does **not** stop it, by design, since
  it may still be serving other sessions.

A stale lock (dead `pid`, or a live one that does not answer the health probe) is
removed and re-claimed. The claim uses an exclusive create (`wx`) **after** a
successful bind, so two invocations racing to become the owner still agree on
exactly one winner.

If the global storage tree itself is unavailable (no resolvable home directory
and no `ISSUE_FLOW_HOME`), monitoring falls back to the pre-single-instance
behaviour instead of being lost: the server binds **inline**, in the pipeline's
own process, serving only that run's snapshot from memory, with no lock file and
no detached process. A warning is printed when this happens.

## Multiple sessions

Because the server is decoupled from any one run, it cannot rely on that run's
in-memory state. It polls
`~/.issue-flow/projects/*/issues/*/session.json` on disk (the same file each run
already writes) every 3 seconds, validates each one, and keeps every well-formed,
recently-updated one as an **active session**. While a run is live, a 10-second
mtime-only heartbeat keeps it visible without changing the snapshot content or
its ETag; after **90 seconds** without a heartbeat, the session is no longer
reported.

Polling rather than `fs.watch` is deliberate: `fs.watch`'s `recursive` option is
only reliable on macOS and Windows, while the `~/.issue-flow` tree is small and
local.

## HTTP API

| Route | Returns |
|-------|---------|
| `GET /` | The dashboard |
| `GET /api/health` | Liveness, used by the single-instance probe |
| `GET /api/sessions` | Every active session, with the summary fields the dashboard cards need |
| `GET /api/status?session=<id>` | That session's full [snapshot](storage.md#sessionjson). Also served at `/status.json` |
| `GET /api/events?session=<id>` | Journal entries for that session |

`GET /api/sessions` exists so the client does not need N× `/api/status` fetches
just to paint the list. `issueDescription` is a short whitespace-collapsed
preview, not the full body:

```json
[
  {
    "sessionId": "3f9e2b7a-…",
    "issueNumber": 42,
    "issueTitle": "Add multi-project dashboard",
    "issueDescription": "Short preview of the issue body…",
    "repositoryName": "acme/app",
    "currentPhase": "execute",
    "progressPercent": 40,
    "elapsedSeconds": 320,
    "status": "running",
    "startedAt": "2026-08-04T16:00:00Z",
    "updatedAt": "2026-08-04T16:05:00Z",
    "attempt": 2,
    "provider": "codex",
    "lastFailureKind": "provider_down",
    "cooldownUntil": "2026-08-04T16:06:00Z",
    "lastActivityAt": "2026-08-04T16:05:58Z",
    "statusUrl": "/api/status?session=3f9e2b7a-…",
    "eventsUrl": "/api/events?session=3f9e2b7a-…"
  }
]
```

`GET /api/status` without `?session=` keeps the pre-multi-session behaviour when
it is unambiguous: with **exactly one** active session it answers that one; with
**zero** or **more than one**, it answers `404` / `409` instead of guessing — the
`409` body lists every active `sessionId` so a client can disambiguate.

`GET /api/events` reads the rotated journal (`events.1.jsonl`) before the current
generation, tolerating absent, partial or malformed lines, and returns `[]` when
journaling is disabled.

ETags are content-hashed (`sha1` of the serialized snapshot) rather than
counter-based, so they work uniformly for both the directory-backed and the
in-memory session sources.

## Configuration

Each setting resolves with the precedence **CLI flag > environment variable >
`.issue-flow.json` > default**:

| CLI flag | Environment variable | `.issue-flow.json` key | Default |
|----------|----------------------|------------------------|---------|
| `--web` / `--serve` | `ISSUE_FLOW_WEB` | `web.enabled` | `false` |
| `--port <n>` | `ISSUE_FLOW_WEB_PORT` | `web.port` | `3737` |
| `--host <h>` | `ISSUE_FLOW_WEB_HOST` | `web.host` | `0.0.0.0` |
| `--refresh <s>` | `ISSUE_FLOW_WEB_REFRESH` | `web.refreshSeconds` | `5` |
| `--web-log-limit <n>` | `ISSUE_FLOW_WEB_LOG_LIMIT` | `web.logLimit` | `200` |
| `--web-no-logs` | — | `web.includeLogs` | logs included |

The global `~/.issue-flow/config.json` also has a `web` key, but
`loadWebConfig()` does not read it yet — see
[configuration](configuration.md#the-precedence-ladder).

## Remote access

The server binds to **`0.0.0.0` by default**, so it is reachable from your local
network as soon as it starts. The CLI prints an explicit warning when it does.
Pass `--host 127.0.0.1` to restrict it to this machine.

To watch a run from another device — a phone, over
[Tailscale](https://tailscale.com) — bind to your machine's tailnet IP instead of
exposing the whole LAN:

```bash
issue-flow run 42 --web --host 100.101.102.103
# then open http://100.101.102.103:3737 from any device in your tailnet
```

The interface is strictly read-only, but prefer the Tailscale IP over `0.0.0.0`
when possible.

## Rebuilding the screenshots

The images above were produced by serving real `session.json` and `events.jsonl`
files — written through the pipeline's own publishers and reducer, not hand-made
fixtures — from a throwaway `ISSUE_FLOW_HOME`, then driving the real server with
Playwright. To reproduce them, point `ISSUE_FLOW_HOME` at a scratch directory,
run any pipeline with `--web`, and screenshot `http://localhost:3737`.
