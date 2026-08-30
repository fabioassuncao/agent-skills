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
its own process. `watchSessionDirectory()` instead **polls** every
`~/.issue-flow/projects/<project>/issues/<n>/session.json` on disk (the same
file `FilePublisher` already writes) on a configurable interval (default
`DEFAULT_POLL_INTERVAL_MS`), validates each one against `sessionSnapshotSchema`,
and keeps a `sessionId → ActiveSession` map. A file that fails validation
(corrupted, mid-write, incompatible schema) is skipped, never crashes the
scan; a session whose file has gone `DEFAULT_STALE_AFTER_MS` without an
update is dropped from the map on the next scan. `FilePublisher` keeps that
mtime alive with a 10s `utimes` heartbeat which does not rewrite content or
invalidate the content-derived ETag; the 90s stale window tolerates three
missed beats plus scheduler and filesystem delays.

Polling rather than `fs.watch` is deliberate: `fs.watch`'s `recursive` option
is only reliably supported on macOS and Windows, while the `~/.issue-flow`
tree is small and local — a cheap poll behaves identically on every platform,
which is what matters here more than sub-second latency.

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
`GET /api/diagnostics` filters the machine-wide JSONL log by session. The only
write routes, `POST /api/config/agent` and `POST /api/config/routing`, delegate
to the canonical preference writers and are advertised/enabled only for
loopback bindings. Remote monitoring must never expose configuration mutation.

`GET /api/events?session=<id>` reads the rotated journal first and the current
generation second. Missing files and partial/malformed lines are empty/skipped,
never request failures; the publisher-backed legacy source returns an empty
history because it has no durable journal path.

ETags are content-hashed (`sha1` of the serialized snapshot) rather than
counter-based: a directory-backed session has no in-process publisher to hand
out a monotonic `version()`, and a hash works uniformly for both backends.

`WebServerOptions.unref` controls whether the bound socket keeps the process
alive: `true` (default) for a server bound inline in a pipeline process,
`false` for the standalone `web serve` process, which has nothing else to do
— staying alive for as long as the server is bound *is* the job.

## `commands/web.ts`: `web serve` / `web stop`

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
