# src/ui

The terminal is a renderer of `SessionSnapshot`. It does not compute a
second, parallel view of the run.

`status-view.ts` is the pure projection: snapshot in, lines out, no I/O.
`pipeline-renderer.ts` is the single writer that paints those lines inside
the region `listr2` already owns. Anything printed with `console.log`
during a running pipeline corrupts that region — that was issue #17.

`formatIssueHeadline` names the version — `Issue Flow v0.16.0 · #42 · …` — and
takes it from `snapshot.environment.cliVersion`, never from the manifest. This
module reads no manifest and does no I/O, and a replayed session must keep
naming the build that produced it. A snapshot from before the field existed
degrades to the bare name.

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

The status renderer keeps its existing ASCII fallback: `NO_COLOR` or a non-TTY
selects that column through `useColor` / `useUnicode`. Clack prompts are a
separate contract: `NO_COLOR` removes SGR styling but does not disable Unicode
glyphs when the terminal supports them. Do not alter `TERM` to couple those
decisions.

## Interactive prompts

`prompts.ts` is the shared Clack adapter and the only interactivity predicate.
Pass stdin, stdout and CI state into `isInteractive`; a prompt requires TTYs on
both ends and no active CI value. Prompt cancellation (including EOF, Esc,
Ctrl+C and abort) is data, never a default answer.

The `listr2` renderer remains the terminal's single writer while its rendering
region is active. Stop or leave that region before opening a Clack prompt; never
print a prompt alongside a running task renderer.

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

`printSubsystem()` is the foreground service extension of this same writer,
not a second logger. It adds the timestamp/subsystem prefix and calls
`redactSecrets()` before stdout. Long-running `serve` output is lifecycle only
(`run:open`, status/phase transition, `run:close`), never snapshot or
conversation firehose; detached `--web` continues with ignored stdio.
