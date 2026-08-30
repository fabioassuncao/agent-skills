# Command reference

Every command of the `issue-flow` CLI, with the flags it really accepts. Run
`issue-flow <command> --help` for the same list from the binary you have
installed.

- [Global flags](#global-flags)
- [Pipeline](#pipeline) — `run`, `resume`, and the individual phases
- [Operating a run](#operating-a-run) — `status`, `ps`, `runs`, `logs`, `usage`, `pause`, `cancel`
- [Issues](#issues) — `generate`
- [Inspection](#inspection) — `init`, `agent`, `policy`, `conventions`, `routing`, `bench`
- [Web monitor](#web-monitor) — `web serve`, `web stop`
- [Exit codes](#exit-codes)

Artifacts live in the [global storage](storage.md), never in your working tree:

```
~/.issue-flow/projects/<project-id>/issues/42/
```

Below, that path is abbreviated to `~/.issue-flow/…/issues/42/`.

## Global flags

Accepted by every command (a few are meaningless on read-only commands, but
they parse):

| Flag | Description |
|------|-------------|
| `-v, --verbose` | Stream the agent output in real time, one line per story, and the full preflight report. The default is a one-screen clean view |
| `-t, --timeout <seconds>` | Per-invocation headless timeout. `0` removes it. Default **900** (15 min) for every single-invocation phase; `execute` is bounded by its iteration budget instead |
| `--inactivity-timeout <seconds>` | Kill the agent after this long with no output at all. `0` disables the watchdog. See [resilience](resilience.md#the-inactivity-watchdog) |
| `--agent <provider>` | Run every phase on `claude`, `codex`, `cursor` or `antigravity` |
| `--agent-model <model>` | Override the model for every phase |
| `--agent-phase <phase>=<provider>[:<model>]` | Override one phase. Repeatable |
| `--verify-level <L0\|L1\|L2\|L3\|L5>` | Acceptance-contract level. See [verification](verification.md) |
| `--no-cross-verify` | Keep L2 off even when a configured trigger would fire |
| `--no-escalation` | Keep `routing.escalation.enabled` off (it is off by default) |
| `--max-cost <usd>` | Per-issue cost ceiling, enforced by Issue Flow |
| `--max-duration <seconds>` | Per-issue duration ceiling |

Commands that resolve an issue (`run`, `resume`, `init`, `analyze`, `prd`,
`plan`, `review`, `pr`) also accept the [issue source flags](issues.md#flags):
`--local`, `--github`, `--prefer-local`, `--prefer-github`, `--ask`.

Running `issue-flow` with no arguments prints `ps` when this machine has live
runs, and the help text otherwise.

## Pipeline

### `run` — the full pipeline

```bash
issue-flow run 42                     # prd → plan → execute → review → pr
issue-flow run 42 --from execute      # start at a given phase
issue-flow run 42 --no-branch         # current branch, no branch creation, no PR
issue-flow run 42 --web               # watch it live in the browser
issue-flow run 42 --pr-review         # add a whole-PR review after `pr`
issue-flow run 42 --continuous        # unattended profile
issue-flow run 42,43,50               # several issues (also: `run 42 43 50`)
issue-flow run 42 --background        # detach and return the terminal
```

`run` first executes the `init` prerequisite gate, then **prd → plan → execute
→ review → pr**, plus the optional **pr-review**. It resumes automatically from
the first incomplete phase when pipeline state already exists. A failing
`review` triggers correction cycles (re-execute + re-review) up to
`maxCorrectionCycles` (default `3`, stored in `tasks.json`).

`analyze` is **not** part of `run` — it is a standalone deep-analysis command.

| Flag | Description |
|------|-------------|
| `--mode <auto\|manual>` | Recorded in the run header and blocks `--background`. It does **not** stop the CLI pipeline after the artifacts — that behaviour belongs to the [`resolve-issue` sub-agent](skills-and-agents.md#execution-modes) |
| `--from <phase>` | Start at a specific phase instead of the first incomplete one |
| `--no-branch` | Run on the current branch: no branch is created and no PR is opened. Persisted in `tasks.json`; the persisted value wins on resume |
| `--pr-review` | Review the created Pull Request after `pr`. Resolved as **flag > `prReview.enabled` in `tasks.json` > off**, and persisted once opted in. Combining it with `--no-branch` fails with exit code `1` |
| `-y, --yes` | Run the whole discovered hierarchy without asking. On a container issue this means `--cascade` |
| `--cascade` | Run the children of a container (Epic, or any issue with sub-issues) without implementing the umbrella |
| `--only` | Run just the issues you named, without their hierarchy. Cannot be combined with `--yes` |
| `--retry-limit <n>` | Retry transient agent failures in `execute` up to N consecutive times (default 10) |
| `--retry-forever` | Retry transient agent failures in `execute` indefinitely |
| `--on-issue-failure <stop\|skip\|block>` | In a queue, what a failing issue does to the rest. `stop` (default) ends the run, `skip` sets it aside and comes back at the end, `block` sets it aside for a human |
| `--continuous` / `--resilient` | The unattended profile — see [resilience](resilience.md#the-continuous-profile) |
| `--no-failover` | Never migrate a phase to another provider |
| `--auto-decompose` | Act on a [decomposition report](resilience.md#when-an-issue-is-too-large) instead of only writing it |
| `--continue` | Continue User Story numbering from the last used in this project |
| `--start-us <n>` | Force User Story numbering to start at `n`, ignoring history. In a queue it applies to the first issue only |
| `-d, --background` | Detach after the confirmation, print the pid and `run.log`, and return the terminal. Refused with `--mode manual`, in CI and outside a TTY |
| `--web`, `--serve`, `--port`, `--host`, `--refresh`, `--web-log-limit`, `--web-no-logs` | [Web monitoring](web-monitor.md) |

When the review comes back as `REQUEST_CHANGES`, the run prints the report path,
**leaves the issue open** locally and on the remote, does not set
`issueStatus: completed`, and still exits `0`.

Multiple issues, hierarchies, queue ordering and the single shared branch are
documented in [Issue sources → hierarchies](issues.md#hierarchies-and-queues).

### `resume` — continue an interrupted pipeline

```bash
issue-flow resume          # the most recently attempted unfinished issue
issue-flow resume 42       # a specific issue
issue-flow resume --all    # every unfinished issue of this project, in order
```

Resumption always worked implicitly by re-running `run`. `resume` makes every
step explicit, in this order:

1. **Ownership.** A live owner of `run.lock` refuses the resume, naming its pid,
   host and last heartbeat. A dead one is taken over and reported.
2. **The plans.** `execution-plan.json` when the project has a queue,
   `tasks.json` otherwise.
3. **The journal.** The last `phase:start` with no `phase:end` in
   `events.jsonl` is what was running when the process died — the one fact the
   snapshot does not keep. Only available when the
   [journal](resilience.md#the-event-journal) is enabled.
4. **The repository preflight.** A rebase, merge or cherry-pick in progress, an
   unresolved conflict, a detached HEAD, or a branch that is not the plan's,
   stops the resume with the command that gets out of it. **Nothing is repaired
   automatically.** A dirty tree is allowed only when the resume continues the
   very phase that was interrupted.
5. **The phase**, stated out loud before anything runs.

| Flag | Description |
|------|-------------|
| `--all` | Resume every unfinished issue of the project |
| `--mode <auto\|manual>` | Same semantics as on `run` |

`run`'s own automatic resume is unchanged.

### Individual phases

Each phase is also a command of its own. They read and write the same artifacts
`run` does, so they compose freely.

| Command | Reads | Writes |
|---------|-------|--------|
| `analyze <issue>` | the issue | `analysis.md` — standalone, not part of `run` |
| `prd <issue>` | the issue, `analysis.md` when present | `prd.md` |
| `plan <issue>` | `prd.md` | `tasks.json` |
| `execute` | `tasks.json` | commits, `progress.txt`, story metrics |
| `review <issue>` | `tasks.json`, the branch | `PASS`/`FAIL` plus findings in `tasks.json` |
| `pr <issue>` | the branch, `tasks.json` | the Pull Request, `pullRequest` in `tasks.json` |
| `pr-review [pr]` | the Pull Request | `pr-review/pr-<n>-round-<k>.md` and `index.json` |

#### `plan` — User Story numbering

```bash
issue-flow plan 42
issue-flow plan 42 --continue      # continue from the last number used
issue-flow plan 42 --start-us 27   # force a starting number, ignoring history
```

`US-NNN` numbering does not restart at `US-001` on every `plan`. The next number
is resolved through a cascade, and the decision is always printed:

1. **Automatic recovery** (default): the highest `US-NNN` already used anywhere
   in the project, recovered by scanning every `tasks.json` of the project. Ids
   that do not follow the format (`story-5`, `add-auth`) are parsed leniently or
   skipped — never thrown on.
2. **No history** (the project's first `plan`): numbering starts at `US-001`.
3. **Explicit override**: `--continue` names the automatic recovery explicitly;
   `--start-us <n>` ignores history entirely.

```
Continuing User Story numbering from US-016 — last used was US-015 (issue #32).
Starting User Story numbering at US-001 (no previous history found for this project).
User Story numbering forced to US-027 via --start-us.
```

`--continue` and `--start-us` are mutually exclusive and passing both fails with
exit code `1`. The decision is recorded in the project's `metadata.json`
(`userStoryNumbering`) for audit, but the *next* decision always re-scans
`tasks.json` from scratch — the record is never read back.

The resolved number is passed to the `plan` prompt as strong context. There is
no programmatic renumbering pass after generation.

#### `execute` — the story loop

```bash
issue-flow execute --issue 42
issue-flow execute --issue 42 --max-iterations 15
issue-flow execute --issue 42 --retry-forever
```

Each iteration is a fresh agent instance that picks the highest-priority story
with `passes: false`, implements it, runs quality checks and commits.

| Flag | Description |
|------|-------------|
| `--issue <n>` | Issue number — reads artifacts from `~/.issue-flow/…/issues/n/` |
| `--max-iterations <n>` | Stop after N iterations. Also accepted as a positional argument |
| `--retry-limit <n>` / `--retry-forever` | Transient-failure budget |
| `--web` and the other web flags | [Web monitoring](web-monitor.md) |

#### `pr` — the Pull Request

Creates a PR referencing the issue, with a summary and a test plan. When the
issue has no remote counterpart, the `Closes #N` line is omitted and the body
points at the local `issue.md` instead.

Inside a [queue](issues.md#hierarchies-and-queues) the phase runs **once**, after
the last issue, producing a **single** Pull Request whose body also carries an
*Issues implemented* section in execution order, one `Closes #N` per issue with a
GitHub counterpart, and a *Pending* section for the issues that were discovered
but not executed. The PR reference is recorded in the queue's
`execution-plan.json` and replicated into every issue's `tasks.json`, so
`issue-flow pr-review --issue <any issue of the queue>` finds it.

#### `pr-review` — reviewing a Pull Request as a whole

```bash
issue-flow pr-review 184            # a specific PR
issue-flow pr-review                # discover it from the session/branch
issue-flow pr-review 184 --issue 42 # persist state in the issue's tasks.json
issue-flow pr-review 184 --round 2  # rewrite round 2 instead of appending
```

Reviews description, issue/PRD/implementation alignment, the whole diff, code
quality, architecture, complexity, duplication, adherence to repository
conventions, regressions, risks, test coverage, documentation and commit
messages. It complements `review`, which is a conformance gate against the
acceptance criteria in `tasks.json`.

The phase is **intended to be read-only**: Write/Edit are not in the tool
allow-list and the prompt forbids edits, commits and
`gh pr review|comment|merge`. Bash stays available so the agent can run
`gh`/`git` inspection commands — the restriction is policy plus allow-list, not
a sandbox. The report is persisted by the CLI, not by the agent.

The issue source flags do not apply: the command never fetches the issue
content, so reviewing a PR with no associated issue is a supported case.

| Flag | Description |
|------|-------------|
| `[pr]` | Pull Request number, `#184`, or a PR URL |
| `--issue <n>` | The issue the PR belongs to — enables state persistence in its `tasks.json` |
| `--round <n>` | Rewrite a specific round instead of appending a new one |
| `--yes` | Skip the confirmation of a discovered PR |
| `--fail-on <request-changes\|suggestions\|none>` | Which verdict fails the command. Default `request-changes` |

**Discovery order**, when no PR number is given:

1. the explicit argument;
2. `pullRequest` in the issue's `tasks.json`, written by `pr` (with `--issue`);
3. `pullRequests[]` of the active in-memory session publisher (populated during
   `run --web`, not read from `session.json`);
4. `gh pr list --head <current branch>`, highest number;
5. failure with an actionable message.

The plan is preferred over the session so a stale or higher-numbered PR for the
same branch cannot override the one this pipeline just opened. The command never
reviews a guessed PR. For sources 2–4 in an interactive terminal it asks for a
`(Y/n)` confirmation; the prompt is skipped outside a TTY, with `CI` set, with
`--yes`, and when the phase runs from `run --pr-review`.

**Artifacts.** Rounds are additive — writing round N+1 never overwrites an
earlier report nor drops entries from `index.json`:

```
~/.issue-flow/…/issues/42/pr-review/    # …/issues/pr-184/pr-review/ with no --issue
  pr-184-round-1.md
  pr-184-round-2.md
  index.json
```

With no `--issue`, the Pull Request number becomes the issue identifier of the
directory (`pr-184`): the global storage accepts non-numeric identifiers, so a
review with no associated issue still gets a first-class directory.

The Markdown report always carries the same eight sections: executive summary,
strengths, issues found, suggested improvements, architectural observations,
risks identified, required before merge, final recommendation. `index.json` is
the structured counterpart:

```json
{
  "schemaVersion": 1,
  "pullRequest": { "number": 184, "title": "feat: …", "url": "…", "headBranch": "feat/42-dark-mode" },
  "rounds": [
    {
      "round": 1,
      "at": "2026-08-03T16:00:00Z",
      "recommendation": "APPROVE_WITH_SUGGESTIONS",
      "headSha": "abc1234…",
      "reportPath": "pr-184-round-1.md",
      "findings": [{ "severity": "high", "file": "src/api/handler.ts", "line": 42, "title": "…" }]
    }
  ]
}
```

`severity` is `blocker`, `high`, `medium` or `low`. `recommendation` is `null`
when the agent output could not be parsed — a malformed verdict is never coerced
into `APPROVE`; the raw output is preserved and the command exits `1`. The
`title`, `url` and `headBranch` of `pullRequest` are `null` when `gh` could not
supply them; the number is always known.

Where reports are published is configured by
[`prReview.publisher`](configuration.md#prreview).

## Operating a run

These commands read state that already exists — `run.lock`, `tasks.json`,
`session.json`, `execution-plan.json` and `events.jsonl` — and none of them
touches the pipeline.

```bash
issue-flow ps                     # every live run on this machine
issue-flow status                 # what is running, in which phase, since when
issue-flow status 42 --json       # the same, as JSON
issue-flow runs                   # history: how each issue ended, and why
issue-flow logs 42 --kind retry   # the journal, filtered
issue-flow logs --follow          # …and kept open as it grows
issue-flow usage 42 --by harness  # cost and tokens per invocation
issue-flow pause                  # ask the run to stop, with a checkpoint
issue-flow cancel 42              # stop it, and mark it so `resume` reports it
```

| Command | What it answers | Own flags |
|---------|-----------------|-----------|
| `status [issue]` | Who owns the run (pid, host, last heartbeat), which phase and attempt each issue is on, how long since the last activity, and where a queue stands | `--json` |
| `ps` | Every `issue-flow` run active on this machine | `--json`, `--watch` |
| `runs` | One line per issue: status, duration and the first line of the failure | — |
| `logs [issue]` | The append-only journal, in order and filtered. Needs the [journal](resilience.md#the-event-journal) enabled | `--issue`, `--follow`, `--tail <n>` (default 50), `--kind <a,b>` |
| `usage [issue]` | Reader over `tasks.json.executions`. Never stores an aggregate; absence of telemetry prints a message instead of crashing | `--issue`, `--since <date>`, `--by <harness\|provider\|model\|purpose\|status>`, `--json` |
| `pause` | Sends `SIGTERM` to the owner, which writes a checkpoint, stops the agent with a grace period and closes its journal before exiting | — |
| `cancel [issue]` | The same stop, plus marking the issue so a later `resume` reports it instead of silently continuing | — |

`pause` and `cancel` deliberately do nothing beyond signalling: the owning
process already knows how to stop well, and a second implementation of that from
outside would be a worse one. Neither ever signals a **stale** owner.

## Issues

### `generate` — draft and create an issue

```bash
issue-flow generate --prompt "Add dark mode support to the settings page"
issue-flow generate --prompt "..." --github
issue-flow generate --prompt "..." --local
issue-flow generate --prompt "..." --both
```

Analyzes the project and drafts the issue through the agent; the draft is then
persisted by the selected provider(s). With no destination flag, the
`issues.defaultGenerateTarget` configuration decides (`github` by default).

| Flag | Destination |
|------|-------------|
| `--github` | GitHub only |
| `--local` | `issue.md` + `metadata.json` under `~/.issue-flow/…/issues/<n>/`, no network |
| `--both` | GitHub **and** a local mirror reusing the GitHub number, recording `remote.ref` and `remote.syncedContentHash` |

The flags are mutually exclusive. With `--both` the remote issue is created
first because it owns the number: a failure there leaves nothing on disk, and a
failure writing the mirror is reported with the URL that already exists.

The repository's [policy](conventions.md) applies: the applicable Issue Template
is followed, an Issue Type is picked when the plan exposes them, and only labels
that really exist are used — **labels are never created** unless
`policy.issues.allowLabelCreation` is `true`.

## Inspection

### `init` — prerequisites and repository conventions

```bash
issue-flow init                 # prerequisites + missing conventions. Writes nothing
issue-flow init --apply         # create the missing files
issue-flow init --json          # the plan, for tooling and for the init-repository skill
issue-flow init --scope apps/api
issue-flow init --check-only    # prerequisites only, as earlier releases did
```

Verifies `git` (inside a repo), the **selected** agent binary, and `gh`
(authenticated). `gh` is blocking only when the issue origin is GitHub: with
`--local`, or `issues.preferredProvider: "local"`, a missing or unauthenticated
`gh` is a warning and the environment still passes. When the resolved agent is
Codex, `codex --version` and `codex login status` are checked too.

It then reports the repository's conventions and what a baseline would add. That
half never changes the exit code — a repository missing a template is not a
broken environment — so a script that treats `init` as a prerequisite gate sees
exactly the pass/fail it always did. Each file gets one of three verdicts:

| Verdict | Meaning |
|---|---|
| `create` | Missing, and the repository has no equivalent |
| `keep` | Something equivalent already exists — left untouched |
| `review` | Present but inconsistent; reported, never rewritten |

**Nothing that exists is ever overwritten**, and running it twice writes nothing
the second time. With `--apply` it can create Issue Forms, the template chooser,
a Pull Request template, `AGENTS.md`, `CLAUDE.md`, `docs/conventions.md` and a
baseline `.github/labels.json`.

A first-run agent prompt appears only on a TTY, outside CI, and only when no
`agent` configuration exists; `--no-agent-prompt` skips it. Non-interactive runs
never ask and never write an agent preference.

> Full behaviour is in [Conventions](conventions.md). The same capability is
> available interactively through the
> [`init-repository`](../skills/init-repository/SKILL.md) skill, which calls this
> command rather than re-deriving the analysis.

### `agent` — resolved agent and model per phase

```bash
issue-flow agent                                  # provider/model per phase, with provenance
issue-flow agent --json                           # versioned JSON, the bridge for the skills
issue-flow agent use codex --model gpt-5.6 --global
issue-flow agent use claude --project
issue-flow agent use codex --phase execute --project
```

`use` writes an agent preference to `~/.issue-flow/config.json` (`--global`, the
default) or to `.issue-flow.json` (`--project`); `--phase` restricts it to one
phase. `--json` is a published contract (`schemaVersion` in the payload). See
[Agents](agents.md).

### `policy` — what the repository declares about itself

```bash
issue-flow policy                    # discovered conventions and where each came from
issue-flow policy --scope apps/api   # resolve for a subdirectory, in a monorepo
issue-flow policy --json             # versioned JSON — the bridge for the Agent Skills
```

Everything is best-effort: a repository that declares nothing resolves to an
empty policy with no error and no warning. A missing or unauthenticated `gh`, or
no network at all, degrades the same way — the `Sources` section then reports the
source as `[unavailable]`, so "declares nothing" is never confused with "we could
not find out". Every network call carries a timeout, and each kind of data costs
at most one `gh` invocation, cached once per process. See
[Conventions](conventions.md).

### `conventions` — the computed Git convention

```bash
issue-flow conventions branch --issue 42
issue-flow conventions commit --type feat --scope api --subject "add endpoint" --story US-010
issue-flow conventions pr-title --issue 42
```

Prints the deterministic branch name, Conventional Commit message and PR title
this repository's convention produces. Each subcommand accepts `--json`, and
`branch` / `pr-title` accept `--title <text>` for when the issue cannot be
resolved. `commit` also accepts `--issue`, `--breaking` and `--scope`. See
[Git conventions](git-conventions.md).

### `routing` — the shadow router

```bash
issue-flow routing              # the resolved routing configuration
issue-flow routing --json
issue-flow routing report       # agreement between the selected and the actual harness
issue-flow routing report --issue 42 --json
```

The router runs in `shadow` mode by default: it decides, records `selected` and
`actual` on the execution record, and changes nothing. See
[Verification and routing](verification.md#shadow-routing).

### `bench` — synthetic or real corpus

```bash
issue-flow bench                              # synthetic (default, free)
issue-flow bench --mode synthetic
issue-flow bench --mode real --yes            # paid campaign; --yes skips the prompt
issue-flow bench --mode real --task small --task medium --repeats 5
issue-flow bench --arm baseline --arm strict-mcp
issue-flow bench --mode real --campaign-max-cost 20 --out report.md --json
```

Two modes, never mixed. `synthetic` times orchestration only — the harness is a
mocked duration — and is what CI runs (`npm test -- src/benchmark/synthetic.test.ts`).
`real` materializes a disposable git fixture per repetition, runs the pipeline
and the acceptance contract, and is refused under `VITEST` unless
`ISSUE_FLOW_E2E_BENCH=1`. A real campaign spends money: without a TTY it
requires `--yes`.

`--task` is repeatable (`trivial`, `small`, `medium`, `analysis`); omitted means
the full corpus. `--arm` is a parameter of the experiment (default `baseline`).
`--campaign-max-cost` / `--campaign-max-duration` are campaign-wide ceilings,
distinct from the per-issue `--max-cost` / `--max-duration`. `--out` writes the
markdown report; `--json` also emits the campaign JSON. `--repo` is an
investigation escape and does not produce a publishable row. A campaign that
hits a ceiling exits `2` with a partial report.

See [`src/benchmark/AGENTS.md`](../packages/issue-flow/src/benchmark/AGENTS.md).

## Web monitor

```bash
issue-flow web stop     # stop the single monitoring server, if one is running
issue-flow web serve --port 3737 --host 127.0.0.1 --refresh 5
```

`web serve` is what `--web` spawns detached behind the scenes; running it by hand
only matters for debugging the monitor itself. See
[Web monitoring](web-monitor.md).

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success. Also a `pr-review` inside `run` that came back `REQUEST_CHANGES` — the issue stays open, the run itself did not fail |
| `1` | Execution failure: prerequisites not met, an invalid flag combination, a headless run that failed, `gh` unavailable, an unparseable verdict, an ambiguous multi-issue request with no scope flag |
| `2` | Standalone `pr-review` only: the verdict fails the `--fail-on` threshold (`REQUEST_CHANGES` by default) |

Code `1` is never suppressed by `--fail-on` — it means the review did not happen.
