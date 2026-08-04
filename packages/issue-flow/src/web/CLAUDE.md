# src/web

## Single-instance guard (`lock.ts`)

`ensureSingleWebServer()` (`lock.ts`) is the entry point every command should
call to get a web monitor — never `startWebServer()` (`server.ts`) directly.
`startWebServer` only knows how to bind a port; it has no idea whether another
issue-flow process already owns one. `ensureSingleWebServer` wraps it with
`~/.issue-flow/web.lock`:

- A lock is trusted only when **both** signals agree: `process.kill(pid, 0)`
  says the owning pid is alive, *and* `GET /api/health` on its `host:port`
  answers. Either signal failing alone means the lock is stale (dead process,
  or a process that's alive but never bound / already died past that point) —
  it is deleted, never left behind for the next command to trip over.
- The lock is claimed with `writeFile(..., { flag: 'wx' })` (exclusive
  create) **before** binding, not after: that's what makes two processes
  invoked at the same instant agree on a single winner without a second lock
  guarding the first one. The loser retries (bounded, with a short delay)
  instead of racing the winner for the port.
- A handle for a *reused* instance has no local `Server` (`WebServerHandle.server`
  is optional for exactly this reason) and its `close()` is a no-op — it must
  never tear down a server another process owns. A handle for a *newly bound*
  instance gets its `close()` wrapped to also delete the lock file, so the
  lock never outlives the server that owns it.

Any future entry point that starts the monitor (not just `run --web`) must go
through `ensureSingleWebServer`, or it silently reintroduces the double-bind
this module exists to prevent.
