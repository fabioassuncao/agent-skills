# src/ui

The terminal is a renderer of `SessionSnapshot`. It does not compute a
second, parallel view of the run.

`status-view.ts` is the pure projection: snapshot in, lines out, no I/O.
`pipeline-renderer.ts` is the single writer that paints those lines inside
the region `listr2` already owns. Anything printed with `console.log`
during a running pipeline corrupts that region — that was issue #17.

## Modes

| Mode | What the user sees |
|---|---|
| clean (default) | One line per phase, `N/M` stories, the active story, the current tool, elapsed / remaining / cost. No agent report. |
| `--verbose` | Everything clean shows, plus the full agent stream broken line by line, plus one subtask per story. |
| no TTY / `CI=1` | The `simple` renderer: one timestamped line per transition, no ANSI, no spinner. |

`issue-flow init` is not a run. Its product **is** the convention report, so
it always prints the full listing. Compact preflight is only the path `run`
takes when verbose is off.

## Icon grammar

`getIcons()` is the only table. `printInfo` uses `info` (`·`), never `start`
(`▶`) — that mark is reserved for the beginning of a phase or invocation.

| Icon | Meaning |
|---|---|
| `✓` / `[OK]` | completed |
| `✗` / `[FAIL]` | failed |
| `⏳` / `[...]` | running |
| `○` / `[ ]` | not started |
| `↻` / `[RETRY]` | retry |
| `⚠` / `[WARN]` | warning |
| `·` / `-` | information / metadata separator |

`NO_COLOR` or a non-TTY falls back to the ASCII column. Color and unicode
are the same detection (`useColor` / `useUnicode`).

## Activity is always published

`activity` events feed `currentActivity` on the snapshot. They are published
in every mode — not only `--verbose` — so the clean view and the dashboard
see the same tool. `FilePublisher` already throttles the disk write; the
ETag cost is accepted because a blank activity line is the worse outcome.

## Agent output

The agent's full report is not a terminal event. In clean mode it is
swallowed; a failure still prints an 8-line excerpt, already stripped of
markdown. `--verbose` emits the text line by line. The complete report
stays on `session.json` and the journal.

## stdout

Progress goes to `stdout`. `issue-flow run 42 > run.log 2>/dev/null` must
produce a complete, ordered log. Diagnostics that are not progress
(publisher warnings, shutdown) may stay on `stderr`.
