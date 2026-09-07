# src/web

## Two layers on top of the single-instance lock (`lock.ts`)

- **`ensureSingleWebServer()`** binds (or reuses) a server **in the calling
  process**. It is the low-level primitive: only the `web serve` command
  (`commands/web.ts`, the standalone process that ends up owning the lock)
  and this module's own tests should call it directly.
- **`ensureWebMonitor()`** (US-002) is what `run`/`execute` call. It never
  binds locally: it reuses an active instance exactly like
  `ensureSingleWebServer`, and when none exists it spawns
  `<node> <cli> web serve --port … --host … [--refresh …]` **detached**
  (`{ detached: true, stdio: 'ignore' }`, `.unref()`ed) so the server outlives
  the pipeline process, then polls the lock file (bounded) until the spawned
  instance claims it. It returns a *reused* handle either way — the calling
  process never owns a local `Server` to close, which is also why `run.ts`'s
  `finally` no longer calls `.close()` on what this returns.
- Any future entry point that starts the monitor must go through
  `ensureWebMonitor` (or, if it *is* the standalone server process itself,
  `ensureSingleWebServer`) — a third way to bind reintroduces the double-bind
  this module exists to prevent.

### `~/.issue-flow/web.lock`

- A lock is trusted only when **both** signals agree: `process.kill(pid, 0)`
  says the owning pid is alive, *and* `GET /api/health` on its `host:port`
  answers. Either signal failing alone means the lock is stale (dead process,
  or a process that's alive but never bound / already died past that point) —
  it is deleted, never left behind for the next command to trip over.
- The lock is claimed with `writeFile(..., { flag: 'wx' })` (exclusive
  create) **after** a successful bind, not before: claiming it while still
  holding an unbound (or ephemeral, port `0`) address would make the lock
  briefly answer no health probe at all, and a concurrent invocation would
  misread that gap as "stale" and delete a perfectly good lock out from under
  its owner. Binding first also means two invocations racing for the same
  *fixed* port never both reach the claim step — the OS itself lets only one
  `listen()` succeed. The `wx` claim then exists for the remaining race: two
  invocations that *both* manage to bind (only possible with an ephemeral
  port) still agree on exactly one winner. The loser closes the server it
  just opened and defers to whichever lock exists.
- A handle for a *reused* instance has no local `Server` (`WebServerHandle.server`
  is optional for exactly this reason) and its `close()` is a no-op — it must
  never tear down a server another process owns. A handle for a *newly bound*
  instance gets its `close()` wrapped to also delete the lock file, so the
  lock never outlives the server that owns it.
- `instanceId` is optional for old locks and mandatory on newly written ones.
  It must match `/api/health` before a new server is trusted. `--restart-web`
  serializes replacement through the short-lived sibling `web.restart.lock`.
  A missing `web.lock` may be recovered from the configured listener only when
  both health and the process command line prove it is `issue-flow web serve`.
- Reusing a monitor names its version, taken from `/api/health` — the reused
  process is the one serving the UI, so its version is the truthful one. A
  version different from `getPackageVersion()` is warned about and nothing more:
  the run still proceeds against the older monitor.

## Multi-session discovery (`session-directory.ts`, US-003)

The standalone `web serve` process is decoupled from any one pipeline
invocation, so it cannot hold a `SessionPublisher` in memory for "the" run
being monitored — there may be zero, one or several running at once, each in
its own process. `watchSessionDirectory()` instead reads the indexed `runs`,
`snapshots` and `events` rows in `issue-flow.db` and keeps a `sessionId →
ActiveSession` map. `SqliteSessionPublisher` writes the reduced snapshot and
its ordered event in one transaction, then refreshes a quiet running session's
database heartbeat every 10s; the 90s stale window tolerates three missed
beats plus scheduler delays. `session.json` and JSONL remain compatibility
projections only — the detached monitor must never traverse them.

### What triggers a read

The write itself does. `fs.watch` on the **storage root** (not on the database
file) wakes the scan within `WATCH_DEBOUNCE_MS`, which is the cross-process
notification this design has available: the writer is a different process, and
its SQLite commit is the only event both sides already agree on. The debounce
collapses the several filesystem events one logical commit produces (WAL, and
the database file on checkpoint) into a single query.

The watch is on the directory because a WAL checkpoint **deletes and recreates**
`issue-flow.db-wal`: a watch bound to that inode would stop firing exactly once,
silently, and the monitor would degrade to interval-only for the rest of its
life without any error to notice. For the same reason the watcher's `error`
handler drops the watcher instead of keeping a dead one, and the interval
re-establishes it — which is also how a monitor started before the storage root
existed recovers.

`DEFAULT_POLL_INTERVAL_MS` survives as the **safety net**, not the delivery
path: the `json` compatibility driver has no single file to watch, and
`fs.watch`'s `recursive` option is only reliable on macOS and Windows, so the
tree is never traversed that way.

### Change notification

`subscribe()` reports `{ added, updated, removed, revision }` after each scan.
A session is *updated* only when its serialized snapshot differs from the
previous one — the 10-second heartbeat bumps the row's `updatedAt` without
changing content, and reporting that as a change would wake every connected
viewer ten times a minute for nothing.

Listeners are isolated: one that throws is swallowed, because a subscriber may
never be able to take the monitor down. That is the same resilience contract the
rest of this module has towards the pipeline.

## `server.ts`: one `SessionSource`, two backends

Session routes (`/api/status`, `/api/sessions`, `/api/events`) are written against a small
`SessionSource` interface (`list()` / `get(sessionId)` / `events(sessionId)`), never against a
publisher or the session directory directly:

- `directorySessionSource()` wraps a `SessionDirectoryHandle` — the normal
  case, passed as `WebServerOptions.sessions` by `web serve`.
- `publisherSessionSource()` wraps a single `SessionPublisher` — the legacy
  single-session path (`WebServerOptions.publisher`), used only by the
  US-006 fallback (global storage unavailable) and by tests.

`GET /api/status` accepts `?session=<id>`; without it, it falls back to the
single active session when there is exactly one (pre-multi-session
behavior), and answers `404`/`409` when there are zero/several — genuinely
ambiguous without an id. `GET /api/sessions` always lists every entry
`SessionSource.list()` returns, `[]` when there are none.

`GET /api/config` returns the configuration captured in the requested snapshot,
the live routing preference and the installed-harness model catalog;
`GET /api/diagnostics` filters the machine-wide JSONL log by session.

Write authority is split by capability. `POST /api/config/{agent,routing}`
delegates to preference writers; `worktrees:mutate` delegates every worktree
action through `agents/session/worktree-control.ts`; `agents:write` delegates
custom-agent CRUD through `config/custom-agents.ts`; `linear:write` and
`settings:write` delegate project integration toggles through
`config/project-settings.ts`. All are
advertised/enabled only for loopback bindings. `agents:read` may be remote, but
`GET /api/agents` then redacts `startCommand` and `resumeCommand`. Remote
monitoring must never expose mutation or a custom command template.

Agent-tab mutation is a separate `worktrees:tabs` capability and delegates to
the locked `agents/session/tabs.ts` domain: create/select/delete never assemble
tmux commands in the HTTP handler. Terminal recovery is separately announced as
`terminal:refresh`; its route is strictly reattach-or-resume and never a generic
restart. Both capabilities are loopback-only. Route parameters called `tabId`
are Issue Flow `AgentSession.id` values, never provider conversation ids.

The terminal upgrade is project-aware too. Unlike ordinary HTTP requests, a
WebSocket upgrade does not pass through the project router, so the terminal
handler must accept both `/ws/terminal` and `/<project>/ws/terminal`, resolve the
prefix itself and scope a prefixed socket to that `ProjectRuntime`. Never fall
back from a valid project prefix to a session belonging to another project.

Service health is projected from the durable worktree binding with the same
effective environment used to launch it: persisted startup values first, then
the allocated service ports (which win on collision). Expanding a service URL
with only the port map loses variables such as `${HOST}` and produces a broken
link even when the process itself is healthy.

`GET /api/linear/issues` is a remote-capable read under `linear:read`, but its
payload and failures pass through the Linear credential redactor. Posting a
conversation, changing Linear auto-create and changing GitHub auto-remove are
loopback writes. The Linear client owns its API key in a closure and its signed
upload validation; the HTTP handler must never accept an upload URL or key from
the browser.

`GET /api/project/auto-name` reads `config/auto-name.ts`, which resolves the
same constants/prompt that `web/worktrees-api.ts` passes to the canonical
`conventions/git/auto-name.ts`. Do not add a web-only generator.

`GET /api/events?session=<id>` reads the ordered SQLite event stream. The
publisher-backed legacy source returns an empty history because it has no
durable database session.

### `/api/stream`: the push transport

`SessionSource` carries a `subscribe()` of its own, so `/api/stream` is written
against the same abstraction as every other route. The directory backend
forwards `watchSessionDirectory`'s notifications; the legacy publisher backend
has no notification to forward, so it compares `publisher.version()` on a
`PUBLISHER_TICK_MS` timer — an in-memory counter read, started on the first
subscriber and stopped with the last.

Server-Sent Events rather than WebSocket: this channel carries reduced JSON in
one direction, so it needs no framing, no upgrade handshake, no dependency, and
it reconnects on its own. The bidirectional terminal transport has different
requirements (backpressure, incremental replay) and is a separate channel —
conflating them would force both to carry the union of their constraints.

`sessionListPayload()` is shared by `GET /api/sessions` and the `sessions`
frame on purpose: the pushed frame must be interchangeable with the fetched one,
so a client that loses the stream falls back to polling without a second code
path. `doClose()` ends the open streams explicitly before
`closeAllConnections()`, which would otherwise drop the sockets without running
their cleanup and leak one subscription per viewer.

ETags are content-hashed (`sha1` of the serialized snapshot) rather than
counter-based: a directory-backed session has no in-process publisher to hand
out a monotonic `version()`, and a hash works uniformly for both backends.

`WebServerOptions.unref` controls whether the bound socket keeps the process
alive: `true` (default) for a server bound inline in a pipeline process,
`false` for the standalone `web serve` process, which has nothing else to do
— staying alive for as long as the server is bound *is* the job.

## Several projects on one server (`projects-api.ts`, `router.ts`)

The server is a **consumer** of the project registry
(`storage/projects/registry.ts`), never its owner: the CLI writes the same table
with no server running, and this process reads it. `ProjectManager`
(`runtime/project-manager.ts`) owns the in-memory set — one `ProjectRuntime` per
project, addressed by a prefix derived from the directory name and never stored.

**The prefix is resolved per request** (`resolveProjectRoute`), not by
republishing a route map. `Bun.serve().reload()` — what the upstream used —
does not exist in `node:http`, and resolving at request time removes the whole
class of reload races. Three properties fall out of it and must stay:

- an **unprefixed** path behaves exactly as it always did, so a single-project
  user never has to know a prefix exists;
- an **unknown** first segment falls through to the hub route table, so a typo
  answers the hub's own 404 rather than a confusing "project not found";
- a **reserved** segment (`api`, `ws`, `assets`, `health`) is never treated as a
  project, so no project can shadow a hub route however it was registered.

`SessionSource` gained `projectOf(sessionId)` for this — sessions were always
keyed by project in SQLite, the HTTP surface simply had no way to ask.

`projects-api.ts` returns `{ status, body }` instead of writing to a
`ServerResponse`, so the whole surface is testable without a socket. Its four
`POST /api/projects` paths are the upstream's, **in the upstream's order**, and
each exists for a case the others get wrong: already served → answer now; setup
in flight → tell the client to poll, never start a second one; already
configured → serve it directly; nothing configured → start the scaffold
asynchronously and report the phases on `GET /api/project-inits`. A server with
no project surface (the monitor the pipeline binds inline) answers an empty list
rather than 404, so one dashboard build serves both.

Both mutating routes require a loopback binding, exactly like the configuration
writes: adding a project reaches the filesystem (ADR-10).

When per-project sockets exist (the terminal transport, phase 8), `removeProject`
must close them **before** the project leaves the map — a note in the code marks
the spot.

## `commands/web.ts`: `web serve` / `web stop`

`issue-flow serve` (`commands/serve.ts`) is the canonical name; `web serve` is
an alias delegating to the same body, because a third way to bind is exactly
what this module exists to prevent. Its boot order matters: **bind first**, so
the dashboard answers while the projects load; then the curated projects,
skipping (never aborting on) any that fail to materialize; then the current
repository, ephemerally.

`runWebServe()` is the body of `issue-flow web serve` — the detached entry
point `ensureWebMonitor()` spawns. It is silent by design (`info`/`warn`
passed as no-ops to `ensureSingleWebServer`): this process is spawned with
`stdio: 'ignore'`, so anything printed here goes nowhere, and the caller
(`ensureWebMonitor`, running in the *parent* process) is the one that tells
the user the server is up. When it discovers another instance already won
the race, it closes its own session-directory watcher and returns
immediately instead of idling as a redundant detached process.

`runWebStop()` sends `SIGTERM` to the lock's `pid` and polls (bounded) for
the lock file to disappear — the actual graceful shutdown (closing the
server, removing the lock, re-raising the signal for the default termination
behavior) is `server.ts`'s existing signal handler, unchanged by US-002.
