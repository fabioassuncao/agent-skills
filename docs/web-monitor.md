# CLI web monitoring

[CLI guide](cli.md) · [Project overview](../README.md)

`run` and `execute` accept `--web`: a local HTTP server serves a self-contained,
dashboard showing live progress — current phase and activity, user
stories, resilience state, commits, pull requests, logs, tokens, cost and time
estimates. It is off by default, works offline (no CDN, no external resource),
and receives updates **pushed** by the server over
[`GET /api/stream`](#push-updates); the configurable interval is the fallback
used only while that stream is down.

```bash
issue-flow run 42 --web                            # http://localhost:3737
issue-flow run 42 --web --port 8080 --refresh 10
issue-flow run 42 --web --host 127.0.0.1           # this machine only
issue-flow run 42 --restart-web                    # restart, then monitor
issue-flow web stop                                # stop the monitor explicitly
```

Monitoring never affects the pipeline: publishing failures are swallowed with a
single warning, a busy port (`EADDRINUSE`) just skips the server, and killing the
server or closing the browser mid-run has no effect on the execution. With
`--web` off, the terminal output and behaviour are byte-for-byte identical.

## One panel, one server

| Panel | Source | Built by | Served at |
|-------|--------|----------|-----------|
| The dashboard | `packages/issue-flow/web/src/` | `npm run build:web` (Vite) → `web/dist/` | `/` |

There used to be two during the frontend migration. ADR-18 kept the previous
panel (`web/public/`, three static files) mounted at `/legacy/` as the rollback
path until the three checklists of §50.7 were green; they went green in phase 8D
and the three files were removed with the route (§50.8). Its measured decisions
did not go with it — they live in `packages/issue-flow/web/AGENTS.md`, in the
present tense, describing the panel that exists.

`status.json` survives that removal deliberately: it is the only fallback that
needs no JavaScript, it is a route of its own, and the panel's `<noscript>`
points at it.

**The panel carries the whole execution surface** — the executions dashboard,
the execution header, the alert card, the tabs with their blocks, the Kanban,
the journal and the details drawer — plus the sessions, worktrees, terminal,
services and PR/CI the WebMux absorption brought.

The new panel asks `GET /api/health` before it renders anything and offers only
the surfaces the answer announces. That is what lets one build serve both a
monitor a pipeline run bound inline — which serves executions and nothing else —
and a standalone `issue-flow serve` with projects, worktrees and terminals: the
first one says so, instead of showing empty lists that read as a failure. A
capability is never inferred from a version number, because the assets on screen
can be newer than the process serving them.

The server reads `web/dist/` at startup: `/` is the panel's `index.html` and
`/assets/<file>` are its hashed bundles. A source checkout that never ran
`npm run build:web` gets a page saying exactly that, with a link to
`status.json` — not a 404, and no second panel.

### Unified navigation (§50.5)

One model, not a "WebMux area" and an "Issue Flow area". The sidebar has two
groups — **Execuções** and **Sessões** — and the main panel shows whichever is
selected:

```text
Task selected                         Free session selected
├── Visão geral (phases + progress)   ├── Terminal
├── Stories (list + Kanban)           ├── Chat
├── Sessões e worktrees               └── Worktree e serviços
├── Terminal · Chat
├── Verificação · Review
└── Saída · Histórico
```

A Task **contains** its sessions, worktrees, terminal, services and PR/CI; it
does not point at another area. A free session is the same screen without the
workflow tabs, rendered by the same components. What decides between them is one
question — is there an execution snapshot behind this selection? — which is what
makes promotion free: linking a free session to an issue (`issue-flow session
link`, or `POST /api/sessions/:id/link`) gives it a run, and the workflow tabs
appear in place.

Inside one selected worktree, the terminal may have a **Root** tab and numbered
**Fork** tabs. Each is a real `AgentSession` sharing that worktree; the browser
does not own or synthesize their identity. Creating a fork uses the root
provider conversation, selecting one moves its already-running pane into view,
and closing is offered only for forks after confirmation. The bar keeps the
ARIA keyboard pattern (arrow keys, Home/End and roving `tabindex`) and remains
reachable when the active pane is orphaned so **Retomar sessão** can run the
non-destructive refresh. Safe fork creation is limited to Claude/Codex sessions
on host-runtime worktrees.

## The dashboard

With two or more active sessions, the panel opens on the executions dashboard —
one card per run, from every project on this machine, and each project's **free
sessions** beside its runs (§49.4). The dashboard header is **Trabalho ativo**,
not the product name:

![Executions dashboard: one card per active run](screenshots/painel-execucoes.png)

Clicking a card opens that session's detail view. A *"Todas as execuções"*
control returns to the dashboard even when only one run exists; with exactly one
active session the panel opens straight into the detail view.

## The detail view

The header is the status line of the run: issue number and title, branch,
monitor version, status badge and elapsed time. The product name lives in the
document `<title>` only.

![Execution detail: current state, context, progress and output](screenshots/painel-execucao.png)

Below the header and the alerts, the panel is split into three tabs.

**"Execução"** is four blocks, in reading order:

1. **Estado agora** — progress, current activity, resilience and the next-steps line
2. **Contexto** — issue (state, labels, description), repository and effective harness configuration. On wide viewports this sits as a side column
3. **Andamento** — phases and user stories
4. **Saída** — commits, pull requests and recent logs

The issue number and title appear once, in the header; Contexto does not repeat
them. There is no priority field: the domain has none, and the panel does not
invent one. Labels stay visible.

Resilience lives inside **Estado agora**. A provider migration shows up there:

![Current-state block of a run that failed over after a rate limit](screenshots/painel-resiliencia.png)

**"Kanban"** is a second reading of the same data — every user story in four columns
(**Backlog**, **Em andamento**, **Em revisão**, **Concluído**), grouped by the
story's [`status`](storage.md#story-status), each column showing its own count.
The tab name is the heading; the panel does not repeat it.

![Kanban tab: user stories grouped by status](screenshots/painel-kanban.png)

A story whose `status` is absent (an older `session.json`) or unrecognized falls
into Backlog rather than disappearing, and every column renders even when empty.
Clicking a Kanban card, story row or phase — or focusing it and pressing Enter —
opens the same **side drawer**. It shows status and timing, effective
harness/model, token/cache/cost telemetry per invocation, stage transitions,
retries/fallbacks/corrections, and expandable process output and correlated
global diagnostics. Story-specific content (description, acceptance criteria
and dependencies) remains in that same component. The drawer closes
on the overlay, the close button or `Esc`, and returns focus to the card that
opened it. It issues **no** additional network requests: everything it shows
already came with the snapshot.

**"Histórico"** reads the append-only [journal](resilience.md#the-event-journal)
and lists the run's pipeline, retry, failure and failover events, with
pipeline/resilience filters. When journaling is disabled or the files do not
exist, it renders an empty state.

Switching tabs never interrupts the update loop: both views are re-rendered on
every refresh, so the Kanban is already current the moment it is opened, and an
open drawer stays open across refreshes, updating in place.

## Themes

The panel ships the two base palettes, the system mode and five named WebMux
palettes. The **"Tema"** select sits next to **"Atualizar"** in the dashboard
and detail headers, mirrored, so changing it in one immediately reflects in the
other. It has eight choices:

| State | What it does |
|-------|--------------|
| **Sistema** (default) | Follows the operating system, live: switching the OS theme repaints the panel with no reload |
| **Claro** | Forces the light theme, whatever the OS says |
| **Escuro** | Forces the dark theme, whatever the OS says |
| **GitHub Dark** | Forces the named dark palette ported from WebMux |
| **Dracula** | Forces the named dark palette ported from WebMux |
| **Nord** | Forces the named dark palette ported from WebMux |
| **Solarized Dark** | Forces the named dark palette ported from WebMux |
| **One Dark** | Forces the named dark palette ported from WebMux |

The choice is stored in `localStorage` under `issue-flow:theme`, so it is **per
browser** (per origin, in fact), not per session, per project or per machine:
another browser — or the same browser on another device watching the same
monitor over the network — keeps its own preference. There is no CLI flag, no
environment variable and no `.issue-flow.json` key for it; it is a client-side
display setting and never reaches the server.

The stored theme is applied by a tiny inline script in the `<head>`, before the
stylesheet loads, so a reload with a forced theme never flashes the opposite
palette. With `localStorage` unavailable (a private window with storage
blocked, a hardened profile) the panel still loads and the select still switches
the theme for that tab — the choice just does not survive the reload.

Every explicit theme declares its own `color-scheme`, so `<select>`,
`<progress>` and the scrollbars follow the **effective** theme rather than the
OS one. Named themes never observe later OS changes. The palette is a complete
set of role-based CSS custom properties in `tokens.css`; Tailwind and xterm
consume the computed tokens instead of keeping their own color maps.

The browser measurement page recalculates 19 text/state/focus/accent pairs per
explicit palette. All five restored WebMux palettes pass their minimums in real
Chromium: 95/95 pairs, with the full vectors recorded in
[the absorption trace](absorption-trace.md#reversão-das-cinco-paletas-webmux-pedido-do-dono-2026-09-06).
Nothing is loaded from the network, so the panel remains offline-capable.

## Capability-gated writes

`snapshot.readOnly` stays `true`: the interface never edits, deletes, reorders
or changes the status of the active run. Other resources have independent
capabilities. On a loopback binding, health may advertise
`config:agent:write`, `config:routing:write`, `worktrees:mutate`,
`worktrees:tabs`, `terminal:refresh`, `agents:write`, `linear:write` and
`settings:write`; each control is rendered only for the promise it needs.
`agents:read` is safe remotely, but its response redacts custom-agent commands.
`linear:read` is also available remotely, but all payload/error strings pass
through the Linear credential redactor. Remote bindings advertise none of the
write capabilities and expose no mutation controls. Tab mutation and terminal
refresh are separate promises: a monitor that can reattach a terminal does not
therefore claim it may fork or stop an agent.

## Project integrations

The one `SettingsDialog` owns non-secret Linear auto-create and GitHub
auto-remove toggles; it does not duplicate integration settings in a second
panel. `GET /api/project/auto-name` reports the provider-neutral naming policy
that explicit worktree creation already consumes. The browser never generates
a competing branch name.

With `LINEAR_API_KEY` present, the sidebar lists assigned Linear tickets and
worktree rows/header show a badge when a branch matches one. The detail dialog
and “Enviar ao Linear” flow can attach the canonical versioned Claude/Codex
conversation export to an existing ticket or a new ticket in a selected team.
The credential remains environment-only. Tests use injected Linear HTTP
doubles; there is no live-account acceptance claim.

`issue-flow serve` also owns a serialized 60-second maintenance cadence for
every served project. Linear pickup considers assigned, unstarted tickets with
the `issue-flow` label and delegates creation to the managed lifecycle. GitHub
GC is separately gated by `autoRemoveOnMerge` and removes nothing on partial PR
state, a dirty/busy/changed worktree, or a merged-head mismatch. A failure in
one integration does not skip the other.

“Abrir no Cursor” needs no server mutation. The local/SSH host stored under
`issue-flow:ssh-host` is combined with the worktree path into `cursor://file…`
or `cursor://vscode-remote/ssh-remote+…`; this existing consumer was audited and
kept.

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

When run in the foreground, `issue-flow serve` prints the local URL and, for a
non-loopback bind, every deduplicated external IPv4 URL using the port that was
actually bound. It also reports the projects loaded and the real state/cadence
of session-directory push/fallback, PR/CI monitoring, reconciliation and
worktree GC. Ongoing output is intentionally sparse: `run:open`, status/phase
changes and `run:close`. Snapshot churn and agent conversation content are not
logged, and all subsystem lines pass through the canonical secret redactor.
The detached process started by `--web` retains `stdio: 'ignore'`.

### Explicit restart and stale UI assets

`--restart-web` is an ephemeral action flag accepted by `run` and `execute`. It
implies `--web`, gracefully stops the previous verified monitor, and starts a
new detached process through the entry point of the CLI handling the command.
Without it, the normal reuse behaviour above is unchanged.

The distinction matters after upgrading Issue Flow: the panel files are not
copied through a separate deployment step. The server reads them once at startup
and retains them in memory, together with its status ETag cache. A process started by an older package therefore keeps serving that
older UI even if the package files on disk are later replaced. Restarting the
process invalidates those process-local caches. There is no web build cache on
disk, service worker or HTTP browser cache to delete; responses use
`Cache-Control: no-store`, and `--restart-web` deliberately does not remove npm
cache, `dist`, session files or browser `localStorage`.

If `~/.issue-flow` was deleted while the detached monitor was alive, the
process becomes an orphan with no `web.lock`. Issue Flow probes the configured
port and restores the lock only after both the health endpoint and the listener
command line prove that it is `issue-flow web serve`. An ambiguous owner is
never killed. Restart operations are serialized, and failures remain non-fatal
to the pipeline.

New monitor versions expose an instance id; an already-open current dashboard
detects the replacement and reloads itself. A tab loaded from a release that
predates instance ids needs one manual reload. `--restart-web` uses the package
version currently executing; to request an npm update as well, use for example
`npx issue-flow@latest run 42 --restart-web`.

### Which version is on screen

Two processes are involved and they can be on different releases: the CLI
running the pipeline, and the detached monitor serving the dashboard. Both are
named, so the difference is visible rather than inferred.

| Surface | Shows | Source |
|---|---|---|
| Terminal headline | `Issue Flow v0.16.0 · #42 · …` | `session.json` → `environment.cliVersion` |
| `run` / `execute` first line | `Issue Flow v0.16.0 · starting pipeline for issue #42 …` | the running package |
| Panel header (version chip) | `v0.16.0` | `GET /api/health` → `version` |
| Configuration card | both, side by side | the snapshot and `/api/health` |
| `--version` | the running package | the manifest |

The terminal reads the version from the snapshot, not from the manifest, so a
resumed or replayed session keeps naming the build that produced it. The chip in
the panel header names the **monitor**, because the monitor is what served the
page you are looking at.

When the two differ, both surfaces say so: the CLI warns while reusing an
existing monitor, naming both versions and pointing at `--restart-web`, and the
configuration card renders the same warning in the panel. Neither one enforces
anything — the run proceeds against the older monitor.

If the global storage tree itself is unavailable (no resolvable home directory
and no `ISSUE_FLOW_HOME`), monitoring falls back to the pre-single-instance
behaviour instead of being lost: the server binds **inline**, in the pipeline's
own process, serving only that run's snapshot from memory, with no lock file and
no detached process. A warning is printed when this happens.

## Multiple sessions

Because the server is decoupled from any one run, it cannot rely on that run's
in-memory state. It reads indexed `runs`, `snapshots` and `events` rows from the
global SQLite database and keeps every recently-heartbeated one as an **active
session**. While a run is live, a 10-second database heartbeat keeps it visible
without changing the snapshot content or its ETag; after **90 seconds** without
a heartbeat, the session is no longer reported.

The read is triggered by a **watch on the storage root**, not by the interval:
the pipeline process writes the snapshot and its ordered event in one SQLite
transaction, and that write is what wakes the monitor, within
milliseconds. The 3-second interval is still there, as the safety net for what
a filesystem watch cannot see — the `json` compatibility driver, a database that
did not exist yet when the monitor started, a platform where the watch stops
firing.

The watch is bound to the **directory**, not to `issue-flow.db-wal`: a WAL
checkpoint deletes and recreates that file, and a watch bound to its inode would
stop firing exactly once, silently. Non-recursive directory watching is also the
one `fs.watch` mode every supported platform implements — `recursive` is only
reliable on macOS and Windows, which is why the storage tree is never traversed
that way.

## Push updates

`GET /api/stream` is a [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events)
channel. It opens with a `hello` frame and the current session list, then emits
a frame whenever session state actually changes — a heartbeat that does not
change snapshot content produces nothing.

| Frame | Payload |
|-------|---------|
| `hello` | `{ instanceId, version, session, heartbeatSeconds }` |
| `sessions` | Exactly what `GET /api/sessions` would return |
| `status` | The full snapshot of the session passed as `?session=<id>` |
| `gone` | `{ sessionId }` — that session is no longer active |

Pass `?session=<id>` to also receive `status` and `gone` for one session;
without it the stream carries the dashboard list only. A comment frame every 15
seconds keeps intermediaries from reaping an idle connection.

`GET /api/health` advertises `stream:sessions` in `capabilities`. A monitor
without it is an older instance the current CLI reused (see the single-instance
lock above), and a client must keep its interval in that case — the served
assets can be newer than the process serving them.

The dashboard uses the stream as a **wake-up signal**, not as a second rendering
path: a frame triggers the same refresh routine the interval would have, so
there is one implementation of "apply the current state to the screen" rather
than two that drift.

## Human takeover

A run is taken over the moment somebody **types into its terminal**. There is no
confirmation, no mode to switch and no state machine: the keystroke is the
signal. It is the mechanism absorbed from WebMux, and its whole appeal is that
it has no ceremony.

While a run is held:

- the [inactivity watchdog](resilience.md#while-a-person-is-in-control) does not
  kill the agent — the silence is a person reading, not a stall;
- the pipeline does not advance to the next phase;
- the snapshot carries `agent.humanHold` with when it started and why, and the
  dashboard cards carry the same field — the card says **em controle humano**,
  because a held run looks idle and is not.

Control comes back only when it is asked for, with
[`issue-flow resume`](commands.md#resume--continue-an-interrupted-pipeline).
Nothing infers that a person is finished — a run that resumed itself because the
terminal went quiet would be the failure the hold exists to prevent, with extra
steps.

The hold lives in the database rather than in memory for two reasons: it is
*intent*, which is what SQLite is the authority over, and it has to cross a
process boundary, because the person types in the monitor while the watchdog
runs in the pipeline.

### When nobody comes

A takeover is somebody arriving. The opposite case — the agent asked a question
and **nobody answered** — is a different condition, and it escalates.

Five minutes after an `awaiting-input` that nothing has answered, the run
reports an escalation: a `warn` log line (which reaches the snapshot's
`warnings`, the panel's alert card and `session.json`), a diagnostic in
`~/.issue-flow/logs`, and `agent.awaitingInputEscalatedAt` in the snapshot. The
panel renders it as its own alert — *"Ninguém respondeu ao agente"* — distinct
from the *"aguardando você"* badge, which only says the agent asked.

Two things about it are deliberate:

- **It is not the human hold.** `heldForMs` measures how long somebody has been
  *in control*; this measures how long **nobody** has come. Folding the two
  together would fire an alarm in the middle of a legitimate takeover, so an
  escalation is suppressed while a hold exists — and starting a hold clears one,
  because a takeover *is* somebody coming.
- **The decision is the pipeline's, never the dashboard's.** A headless run with
  no interface open is exactly the one that most needs to be told, so the policy
  lives in `src/core/awaiting-input.ts` and runs on the invocation chokepoint
  (ADR-03). The panel displays the field; it never computes it.

## HTTP API

| Route | Returns |
|-------|---------|
| `GET /` | The dashboard (Svelte panel) |
| `GET /api/health` | Liveness, PID, version and instance identity used by ownership/restart probes |
| `GET /api/sessions` | Every active session, with the summary fields the dashboard cards need |
| `GET /api/status?session=<id>` | That session's full [snapshot](storage.md#sessionjson). Also served at `/status.json` |
| `GET /api/events?session=<id>` | Journal entries for that session |
| `GET /api/config?session=<id>` | Captured effective configuration, resolved routing settings and the harness catalog with readiness (`installed`, `authentication`, `state`, models) |
| `GET /api/diagnostics?session=<id>` | Correlated records from the global diagnostic log |
| `POST /api/config/agent` | Save a global provider/model preference for future runs; loopback only |
| `POST /api/config/routing` | Save global routing mode/profile/policy for future runs; loopback only |
| `GET /api/agent-events?session=<id>` | Lifecycle history the agent's own [hooks](agents.md#lifecycle-hooks) reported for that run |
| `GET /api/stream[?session=<id>]` | [Server-Sent Events](#push-updates): state changes pushed as they happen |
| `GET /api/projects` | Every known project: the ones this server is serving first, then the ones the registry knows and nothing is running for |
| `POST /api/projects` | Add a project by `{ "path": "…" }`; loopback only |
| `DELETE /api/projects/:prefix` | Stop serving a project and demote it to `discovered`; loopback only |
| `GET /api/project-inits` | Phases of the setups currently in flight |
| `GET /api/worktrees` | Managed worktree projections with their current AgentSession/tabs, services and pull requests; `sessions` capability |
| `POST /api/worktrees` | Create one or more managed worktrees and open their agent sessions; loopback + `worktrees:mutate` |
| `POST /api/worktrees/:name/open` | Open an agent session in a managed worktree; loopback + `worktrees:mutate` |
| `POST /api/worktrees/:name/close` | Stop live sessions without removing the worktree; loopback + `worktrees:mutate` |
| `DELETE /api/worktrees/:name` | Stop occupants, then remove the managed worktree and branch; loopback + `worktrees:mutate` |
| `POST /api/worktrees/:name/merge` | Stop occupants, merge through the canonical rollback-safe path, then remove; loopback + `worktrees:mutate` |
| `PUT /api/worktrees/:name/archive` | Persist archive/unarchive state; loopback + `worktrees:mutate` |
| `PUT /api/worktrees/:name/label` | Persist or clear the label; loopback + `worktrees:mutate` |
| `PUT /api/worktrees/:name/profile` | Validate/persist a profile and restart a live session with its stored permission; loopback + `worktrees:mutate` |
| `POST /api/worktrees/:name/send` | Deliver a turn to the live agent session; loopback + `worktrees:mutate` |
| `POST /api/worktrees/:name/tabs` | Fork the root Claude/Codex conversation into a selected `AgentSession` tab; loopback + `worktrees:tabs` |
| `POST /api/worktrees/:name/tabs/:tabId/select` | Select an authenticated existing/resumed tab without restarting it; loopback + `worktrees:tabs` |
| `DELETE /api/worktrees/:name/tabs/:tabId` | Stop and close one fork; the root is protected; loopback + `worktrees:tabs` |
| `POST /api/worktrees/:name/agent-terminal/refresh` | Reattach the active pane, or resume its exact conversation when absent; loopback + `terminal:refresh` |
| `GET /api/worktrees/:name/diff` | UTF-8-safe bounded worktree diff |
| `GET /api/branches`, `GET /api/base-branches` | Branch choices for the create/open UI |
| `POST /api/pull-main` | Pull the configured main checkout without a force mode; loopback + `worktrees:mutate` |
| `GET /api/config/project` | Minimal profile/agent configuration for worktree dialogs |
| `GET /api/agents` | Built-in and custom agent summaries; `agents:read`; command templates are redacted remotely |
| `POST /api/agents/validate` | Parse and validate a custom-agent definition without persisting it; `agents:read` |
| `POST /api/agents`, `PUT /api/agents/:id`, `DELETE /api/agents/:id` | Create/update/delete project custom agents; loopback + `agents:write` |
| `GET /api/linear/issues` | Assigned active Linear tickets, or an explicit disabled/missing-key availability; `linear:read` |
| `PUT /api/linear/auto-create` | Persist the project auto-create toggle; loopback + `linear:write`; rejects an environment-pinned value |
| `POST /api/worktrees/:name/linear` | Attach the canonical conversation export to an existing/new Linear ticket; loopback + `linear:write` |
| `PUT /api/github/auto-remove-on-merge` | Persist safe merged-worktree GC policy; loopback + `settings:write`; rejects an environment-pinned value |
| `GET /api/project/auto-name` | Resolved provider-neutral auto-name policy and canonical constants |
| `GET /api/agent-sessions[?free=1&all=1]` | Agent sessions (§49.3); `all=1` is the consolidated view across every served project |
| `POST /api/sessions` | Open a session — `issueRef` present binds it to that issue's run, absent makes it free; loopback only |
| `POST /api/sessions/:id/{input,interrupt,link}` | Send a turn, interrupt, or promote a free session to a run; loopback only |
| `DELETE /api/sessions/:id` | Stop a session; the worktree survives unless `?removeWorktree=1` |
| `POST /api/worktrees/:name/sync-prs` | Force one pull-request sync now, outside the activity gate; `pr:ci` capability |
| `GET /api/ci-logs/:runId` | Failed steps of a GitHub Actions run; `pr:ci` capability |
| `GET /api/terminal/token` | Credential the panel presents on the terminal WebSocket handshake; loopback only |
| `WS /ws/terminal?token=…&session=…` and `WS /<project>/ws/terminal?token=…&session=…` | The terminal transport (`src/web/terminal-ws.ts`); refuses a missing token or a foreign `Origin`, and the prefixed form resolves the session only inside that project |

The snapshot's `agent` section carries what the agent's own
[lifecycle hooks](agents.md#lifecycle-hooks) reported — `lifecycle`
(`busy` / `awaiting-input` / `null`), `since`, `phase` and `awaitingInputCount`.
The dashboard shows an explicit badge while an agent is blocked on a human,
because that is the one state in which the run has stopped progressing until
someone acts. It is never inferred from output.

`GET /api/sessions` exists so the client does not need N× `/api/status` fetches
just to paint the list. `issueDescription` is a short whitespace-collapsed
preview, not the full body:

```json
[
  {
    "sessionId": "3f9e2b7a-…",
    "projectId": "app-9f2c1d4e5b6a",
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

The configuration card renders the captured value, not a new resolution done by
the browser, so a run keeps explaining exactly which layers determined it.
Changing a provider/model writes only the global user preference and only when
the monitor is bound to loopback; it never mutates an active run. On a LAN or
Tailscale binding the route is absent from `/api/health.capabilities` and returns
`403`.

ETags are content-hashed (`sha1` of the serialized snapshot) rather than
counter-based, so they work uniformly for both the directory-backed and the
in-memory session sources.

## Sessions without an issue

An **execution** is a run of the workflow over a Task. A **session** is an agent
alive in a worktree — with or without an execution behind it. They are different
things, and the API says so with two different routes.

`GET /api/sessions` is, and stays, the execution list the dashboard cards are
built from. The agent sessions live at `GET /api/agent-sessions`, where each row
carries `free: true` when `runId`, `phase` and `storyId` are all empty:

```json
[
  {
    "id": "9f3c…",
    "free": true,
    "runId": null,
    "phase": null,
    "storyId": null,
    "branch": "session/poking-at-the-parser-1a2b3c4d",
    "label": "poking at the parser",
    "provider": "codex",
    "status": "running",
    "paneTarget": "if-app-9f2c1d4e5b6a:if-session-poking-at-the-parser-1a2b3c4d.0"
  }
]
```

`POST /api/sessions` opens one. The body is
`{ agent?, branch?, label?, prompt?, model?, permission?, issueRef? }`, and
`issueRef` is the whole of the difference between the two modes: present, the
session belongs to that issue's run; absent, it belongs to nobody. An `issueRef`
whose issue has no run yet is refused with `409` rather than quietly downgraded —
opening a session must never be what starts a pipeline.

The response carries what a client needs to attach without a second round trip:

```json
{
  "session": { "id": "9f3c…", "free": true, "…": "…" },
  "branch": "session/poking-at-the-parser-1a2b3c4d",
  "worktreePath": "/Users/me/code/worktrees/session/poking-at-the-parser-1a2b3c4d",
  "paneTarget": "if-app-…:if-session-….0",
  "launchMode": "fresh",
  "layout": { "mode": "fresh", "…": "…" },
  "terminal": { "path": "/ws/terminal", "branch": "session/poking-at-the-parser-1a2b3c4d" }
}
```

Every one of these routes is a write that reaches the machine — opening a
session starts a process, and typing into one is a remote shell — so they follow
the rule the configuration and project writes already follow: **loopback
bindings only**. On a LAN or Tailscale binding they answer `403`, and
`session:open` is absent from `/api/health.capabilities`, so the dashboard never
offers a button that would be refused.

A session with no run has no verification, and the API invents none: there is no
verdict field to default, and the absence of `runId` is the whole signal.

## Several projects on one dashboard

`issue-flow serve` reloads every [curated project](storage.md#projects--the-project-registry)
and serves them together, on one port. A project appears whether or not anything
is executing in it — which is the point: before the registry, a project only
existed once it had run at least once.

`GET /api/projects` answers what the selector needs:

```json
{
  "projects": [
    {
      "id": "api-3f11f0a72d54",
      "prefix": "api-2",
      "name": "api",
      "root": "/Users/me/code/api",
      "source": "registered",
      "active": false,
      "served": true,
      "addedAt": "2026-09-06T12:05:27.609Z",
      "lastSeenAt": "2026-09-06T12:05:27.609Z"
    }
  ]
}
```

`prefix` is the URL segment that project's routes answer under, resolved **per
request**: `GET /api-2/api/sessions` lists only that project's sessions, and every
unprefixed route keeps behaving exactly as before. The prefix is derived from the
directory name, never stored, and can never be `api`, `ws`, `assets` or `health` —
those are the hub's own routes. `served: false` means the registry knows the
project but this process is not serving it.

Adding a repository that has no convention files does not hold the request open:
`POST /api/projects` answers `202` with `{ "initializing": true }` and the phases
(`creating_config` → `analyzing` → `ready` | `failed`) become observable on
`GET /api/project-inits`. Terminal entries linger for a minute so a poller that
arrives late still sees the outcome. Like the configuration writes, both mutating
routes are refused with `403` on any binding that is not loopback.

The dashboard shows "Trabalho ativo": one block per project with its running
executions, including the projects with none. The selector next to the refresh
control filters to a single project and remembers the choice in that browser
only — the registry is the authority on which projects exist, never on which one
someone is looking at.

## Configuration

Each setting resolves with the precedence **CLI flag > environment variable >
`.issue-flow.json` > default**:

| CLI flag | Environment variable | `.issue-flow.json` key | Default |
|----------|----------------------|------------------------|---------|
| `--web` / `--serve` | `ISSUE_FLOW_WEB` | `web.enabled` | `false` |
| `--restart-web` | — | — | one-shot action; implies `--web` |
| `--port <n>` | `ISSUE_FLOW_WEB_PORT` | `web.port` | `3737` |
| `--host <h>` | `ISSUE_FLOW_WEB_HOST` | `web.host` | `0.0.0.0` |
| `--refresh <s>` | `ISSUE_FLOW_WEB_REFRESH` | `web.refreshSeconds` | `5` (fallback interval only — updates arrive by push) |
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

Execution state is always read-only. Global agent preferences are writable only
on loopback; on a remote binding the entire interface is read-only. Prefer the
Tailscale IP over `0.0.0.0` when remote monitoring is needed.

## Rebuilding the screenshots

The images above were produced from real pipeline snapshots and events in a
throwaway `ISSUE_FLOW_HOME`, then captured through the real server with
Playwright. To reproduce them, point `ISSUE_FLOW_HOME` at a scratch directory,
run any pipeline with `--web`, and screenshot `http://localhost:3737`.
