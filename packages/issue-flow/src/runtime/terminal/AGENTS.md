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
