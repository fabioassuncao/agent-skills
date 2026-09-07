# src/runtime/terminal

Getting text into an agent that is running as a TUI, and its output back out.

## `input.ts`: why a tmux buffer and not `send-keys`

`send-keys -l` delivers a long text **character by character**. A TUI with
autocomplete, slash commands or paste detection reacts halfway through: it opens
a menu on `/`, it submits on an embedded newline, it debounces and drops. Loading
the text into a tmux buffer and pasting it delivers the whole block as one paste
event the TUI already knows how to handle.

§2.4 of the absorption plan calls this the best isolated artefact in the whole
upstream, and it is.

## Invariants

- **`-r` and `-p` are both required.** `-r` keeps newlines as newlines instead
  of turning them into submissions; `-p` marks it as a paste so the TUI treats
  it as one. Dropping either turns a multi-line prompt into several accidental
  submissions.
- **`-d` deletes the buffer.** A prompt left in tmux's paste buffers can be
  produced again by the user's own `prefix ]`, in a pane that may not be theirs.
- **NUL bytes are stripped.** A tmux buffer cannot carry one, and a prompt
  assembled from file content occasionally has one.
- **The first prompt does not come through here at all.** It travels in the
  agent's own argv, after `--` (ADR-04, `src/agents/tty.ts`), which has no
  delivery race to lose. This module is for the turns after that one.
- **Raw keys go as hex, not as names.** A modern TUI expects CSI u encodings
  tmux has no name for; translating them into names loses the distinctions the
  encoding exists to make.

## Never

- Never deliver a prompt with `send-keys -l`.
- Never leave a buffer behind.
- Never assume a paste is processed synchronously: `submitDelayMs` exists
  because some TUIs finish a bracketed paste on a later tick, and submitting in
  the same one lands before the text does.

## `attach.ts`: why a grouped session per viewer

`tmux new-session -t <owner>` creates a session that **shares the owner's
windows** while keeping its own client, active window and size. That is what
makes several viewers possible at once: one person resizing their browser does
not reflow everybody else's terminal.

Every line of `buildAttachCommand` is load-bearing, and the test compares it
literally for that reason:

- `window-size latest` is set on the **owner**, so the window follows the most
  recently active client instead of shrinking to the smallest one. Without it a
  phone squeezes every other viewer's terminal.
- The **unzoom is defensive and not optional**: zoom state is *shared* across
  grouped sessions, so a viewer who left a pane zoomed leaves the next one
  looking at a single pane with no way to know why.
- `stty` runs before the attach, so the first frame is already the right shape
  and the terminal does not reflow the moment it connects.
- Detaching kills the **viewer's** grouped session only. The project's windows —
  and the agent inside them — are untouched, which is the whole point.
- Agent tabs add one more identity constraint: attach may receive the active
  AgentSession's stable `%N` pane id. The grouped viewer still shares the same
  owner session and dedicated socket; changing tabs changes the selected pane,
  never the owner/viewer relationship or the process.
- A caller-supplied `sessionId` is accepted only when it belongs to the current
  worktree binding (exact `worktreeId`) and its root/fork tab projection. A
  branch name reused for a new checkout must not make an old AgentSession
  attachable again.
- The websocket boundary attaches only the binding's **active** tab and proves
  its full physical owner tuple immediately before spawning the viewer:
  `{paneId, project owner tag, main/parking window, paneToken}`. A missing pane,
  an unknown tmux answer or a reused `%N` is a refusal, never a fallback to a
  branch-matching row.

Resizing goes through `tmux resize-window`, not through the pty: the pty here
runs a tmux *client*, and only tmux can change the size of the window it draws.

## `pty.ts`: an optional native dependency that may be present and unusable

`node-pty` is in `optionalDependencies` and is used when it works. It is probed
with a **real spawn**, not a `require`, because the failure this exists for is a
module that imports fine and then throws at `fork` — which is exactly what it
does on the machine this was ported on (`posix_spawnp failed`). The `script` /
`python3` wrapper is not a formality; it is the path that works.

macOS uses `python3` unconditionally rather than probing, because its `script`
has a different, incompatible interface.

## The one exception to `run()`

`src/utils/AGENTS.md` says `run()` is the only shell path, and it is — for
commands whose *output* this project reads. `pty.ts` is the exception, and it
has to be: what it needs is a **pseudo-terminal**, and `run()` (execa with
pipes) gives a pipe. An agent TUI behind a pipe does not draw, does not report a
size and does not answer a keypress.

So `pty.ts` spawns directly, and everything that is not the pty itself — every
tmux command it issues around the attach — still goes through `run()` and keeps
the allowlist and the retry policy with it.

## `scrollback.ts`: numbered bytes

The ring is the upstream's (1 MB). The **offsets are not**: §15 adds them so a
reconnecting client can ask for the difference instead of receiving the whole
buffer. A browser reconnects on `visibilitychange`, `focus` and `online`, so
switching tabs twice costs two megabytes and two full repaints without them.

Eviction drops **whole chunks**. Splitting one risks cutting a multi-byte
character or an escape sequence in half, and a terminal handed half an escape
sequence renders garbage from there on. Offsets stay monotonic across eviction,
so an offset is never reused and "I have up to N" is never ambiguous.
