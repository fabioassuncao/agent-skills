# Issue Flow

A CLI that turns issues into pull requests autonomously. Orchestrates the full pipeline -- plan, implement, review, and deliver -- via [Claude Code](https://docs.anthropic.com/en/docs/claude-code) Headless mode. Issues can come from GitHub or from plain files in your repository (see [Issue Sources](#issue-sources-providers)).

## Quick Start

```bash
# Verify prerequisites
npx issue-flow init

# Run the full pipeline for issue #42
npx issue-flow run 42
```

## Requirements

- **Node.js** >= 22.0.0
- **Git** installed and available in PATH
- **Claude Code** (`npm install -g @anthropic-ai/claude-code`)
- **GitHub CLI** (`gh`) authenticated (`gh auth login`) -- required only for GitHub issues; a run on [local issues](#issue-sources-providers) does not need it

Run `npx issue-flow init` to verify all prerequisites (`npx issue-flow init --local` when the issue lives in the repository).

## Installation

```bash
# Run directly via npx (no install needed)
npx issue-flow run 42

# Or install globally
npm install -g issue-flow
issue-flow run 42
```

## Pipeline Flow

```mermaid
flowchart LR
    subgraph "issue-flow run 42"
        A["init"] --> B["prd"]
        B --> C["plan"]
        C --> D["execute"]
        D --> E["review"]
        E --> F{PASS?}
        F -- Yes --> G["pr"]
        F -- No --> H{"Retries\n< max?"}
        H -- Yes --> D
        H -- No --> I["Stop"]
        G --> J{"--pr-review?"}
        J -- Yes --> K["pr-review\n(optional)"]
        J -- No --> L["Done"]
        K --> L
    end
```

The default order is **init -> prd -> plan -> execute -> review -> pr**, with **pr-review** appended only when explicitly requested (see [`pr-review`](#pr-review----review-a-pull-request)). Without `--pr-review`, the behavior is identical to previous versions.

Each phase can also be run independently: `issue-flow prd 42`, `issue-flow plan 42`, etc. The `analyze` command is available standalone for deeper issue analysis when needed, and `issue-flow pr-review [pr]` works as a standalone assisted code review, with or without an associated issue. The `generate` command creates issues separately: `issue-flow generate --prompt '...'`.

## Commands

Every artifact the pipeline reads or writes lives in the issue directory of the [global storage](#global-storage):

```
~/.issue-flow/projects/<project-id>/issues/42/
```

Throughout this document that path is abbreviated to `~/.issue-flow/…/issues/42/`. Nothing is written to `<projectRoot>/issues/` any more: an existing legacy directory is copied into the global storage the first time a command touches the project, and is then left untouched -- see [Migrating from `issues/`](#migrating-from-issues).

### `run` -- Full pipeline (end-to-end)

```bash
# Run the complete pipeline for an issue
npx issue-flow run 42

# Resume from a specific phase
npx issue-flow run 42 --from execute

# Run on the current branch (no branch creation, no PR)
npx issue-flow run 42 --no-branch

# Watch the run live in the browser (see "Web Monitoring" below)
npx issue-flow run 42 --web

# Review the created Pull Request as a final phase
npx issue-flow run 42 --pr-review

# Continue User Story numbering from the last used in this project
npx issue-flow run 42 --continue

# Force User Story numbering to start at a specific number
npx issue-flow run 42 --start-us 27
```

Executes all phases in order: **init** -> **prd** -> **plan** -> **execute** -> **review** -> **pr**, plus the optional **pr-review**. Automatically resumes from the last incomplete phase if pipeline state exists. On review failure, runs correction cycles (re-execute + re-review) up to `maxCorrectionCycles`.

| Flag | Description |
|------|-------------|
| `--mode <mode>` | Execution mode: `auto` (default) or `manual` |
| `--from <phase>` | Resume from a specific phase |
| `--no-branch` | Run on the current branch without creating a new branch or PR |
| `--pr-review` | Review the created Pull Request after the `pr` phase (see [`pr-review`](#pr-review----review-a-pull-request)) |
| `--continue` | Continue User Story numbering from the last one used in this project (see [User Story numbering continuity](#user-story-numbering-continuity)) |
| `--start-us <n>` | Force User Story numbering to start at `n`, ignoring history |
| `--web` | Enable real-time web monitoring (see [Web Monitoring](#web-monitoring)) |
| `-v, --verbose` | Show Claude progress output in real time |

`--pr-review` is resolved like `--no-branch`: **flag > persisted value (`prReview.enabled` in `tasks.json`) > default (off)**. Opting in once persists `prReview.enabled` as soon as a `tasks.json` exists (including mid-pipeline resumes such as `--from pr --pr-review`), so a later run keeps the phase without repeating the flag. Combining `--pr-review` with `--no-branch` fails immediately with exit code `1` -- with no PR there is nothing to review. When the review comes back as `REQUEST_CHANGES`, the run prints the report path, **leaves the issue open** (locally and on the remote), does **not** mark `issueStatus: completed`, and still exits `0`.

It also accepts the [issue source flags](#flags) (`--local`, `--github`, `--prefer-local`, `--prefer-github`, `--ask`). The origin is resolved **once**, at the start, and the same issue content is handed to every phase.

### `init` -- Check prerequisites

```bash
npx issue-flow init
npx issue-flow init --local
```

Verifies that `claude`, `gh` (authenticated), and `git` (inside a repo) are available. Reports pass/fail for each with install hints.

`claude` and `git` are always blocking. `gh` is blocking only when the issue origin is GitHub: with `--local` (or `issues.preferredProvider: "local"` in `.issue-flow.json`) a missing or unauthenticated `gh` is reported as a warning and the environment still passes.

### `generate` -- Create a new issue

```bash
# Uses issues.defaultGenerateTarget (github by default)
npx issue-flow generate --prompt "Add dark mode support to the settings page"

# Explicit destination
npx issue-flow generate --prompt "..." --github
npx issue-flow generate --prompt "..." --local
npx issue-flow generate --prompt "..." --both
```

Analyzes the project and drafts the issue via Claude headless; the draft is then persisted by the selected provider(s).

| Flag | Destination |
|------|-------------|
| `--github` | GitHub only (current behavior) |
| `--local` | `issue.md` + `metadata.json` in `~/.issue-flow/…/issues/<N>/` only, no network access |
| `--both` | GitHub **and** a local mirror that reuses the GitHub number and records `remote.ref` / `remote.syncedContentHash` |

The flags are mutually exclusive. With `--both`, the remote issue is created first because it owns the number: a failure there leaves nothing on disk, and a failure writing the mirror is reported with the URL that already exists.

### `analyze` -- Analyze an issue (standalone)

```bash
npx issue-flow analyze 42
```

Fetches issue data, analyzes the codebase, and produces a structured analysis saved to `~/.issue-flow/…/issues/42/analysis.md`. This is a standalone command not part of the default `run` pipeline -- use it when you need a deeper pre-analysis before generating the PRD.

### `prd` -- Generate a PRD

```bash
npx issue-flow prd 42
```

Generates a Product Requirements Document from the issue analysis (`analysis.md` in the same directory, when the standalone `analyze` command produced one). Saves to `~/.issue-flow/…/issues/42/prd.md`.

### `plan` -- Convert PRD to task plan

```bash
npx issue-flow plan 42

# Continue from the last User Story number used in this project
npx issue-flow plan 42 --continue

# Force numbering to start at a specific number, ignoring history
npx issue-flow plan 42 --start-us 27
```

Converts the PRD into a structured `~/.issue-flow/…/issues/42/tasks.json` with ordered user stories, acceptance criteria, and pipeline state.

| Flag | Description |
|------|-------------|
| `--continue` | Continue User Story numbering from the last one used in this project |
| `--start-us <n>` | Force User Story numbering to start at `n`, ignoring history |

`--continue` and `--start-us` are mutually exclusive -- passing both fails immediately with a clear error and exit code `1`. See [User Story numbering continuity](#user-story-numbering-continuity) below.

#### User Story numbering continuity

`US-NNN` numbering no longer restarts at `US-001` on every `plan` run. Each execution resolves the next number through a cascade, and the decision is always printed -- never silent:

1. **Automatic recovery** (default, no flag needed): the highest `US-NNN` number already used anywhere in the project is recovered by scanning every `~/.issue-flow/…/issues/*/tasks.json` for the project, regardless of which issue produced it. The scan is tolerant of ids that do not follow the `US-NNN` format -- an id like `story-5` or `add-auth` is parsed leniently (or skipped, never thrown on) rather than failing the whole scan.
2. **No history found** (the project's first `plan` run ever): numbering starts at `US-001`.
3. **Explicit override**: `--continue` names the automatic recovery explicitly (same number as the default, only the log message differs), and `--start-us <n>` forces a specific starting number, ignoring history entirely -- useful after a manual backlog reorganization.

Every decision is printed to the terminal, for example:

```
Continuing User Story numbering from US-016 — last used was US-015 (issue #32).
Starting User Story numbering at US-001 (no previous history found for this project).
User Story numbering forced to US-027 via --start-us.
```

The decision is also persisted in the project's `metadata.json` (`userStoryNumbering`, see [Global Storage](#global-storage)) for audit, though the *next* decision is always resolved by re-scanning `tasks.json` files from scratch -- the persisted record is never read back to decide anything.

The resolved number is passed to the `plan` prompt as strong context, instructing Claude to continue numbering from there instead of restarting at `US-001`; there is no programmatic renumbering pass after generation in this release.

### `execute` -- Run the story execution loop

```bash
npx issue-flow execute --issue 42
npx issue-flow execute --issue 42 --max-iterations 15
npx issue-flow execute --issue 42 --retry-forever
```

Runs the iterative agent loop. Each iteration is a fresh Claude instance that picks the next pending story, implements it, runs quality checks, and commits.

| Flag | Description |
|------|-------------|
| `--issue N` | Issue number -- reads artifacts from `~/.issue-flow/…/issues/N/` |
| `--max-iterations N` | Stop after N iterations (default: unlimited) |
| `--retry-limit N` | Retry transient Claude failures up to N consecutive times (default: 10) |
| `--retry-forever` | Retry transient Claude failures indefinitely |
| `--web` | Enable real-time web monitoring (see [Web Monitoring](#web-monitoring)) |

### `review` -- Validate the implementation

```bash
npx issue-flow review 42
```

Verifies acceptance criteria, runs tests, and checks for regressions. Outputs `PASS` or `FAIL` with findings.

### `pr` -- Create a pull request

```bash
npx issue-flow pr 42
```

Creates a well-structured PR referencing the issue, with summary and test plan. When the issue has no remote counterpart (a local issue), the `Closes #N` reference is omitted and the PR body points at the local `issue.md` instead.

### `pr-review` -- Review a Pull Request

```bash
# Review a specific Pull Request
npx issue-flow pr-review 184

# Discover the Pull Request from the current session/branch
npx issue-flow pr-review

# Associate the review with an issue (persists state in the issue's tasks.json)
npx issue-flow pr-review 184 --issue 42

# Rewrite round 2 instead of appending a new one
npx issue-flow pr-review 184 --round 2
```

Reviews the Pull Request **as a whole** -- description, issue/PRD/implementation alignment, the full diff, code quality, architecture, complexity, duplication, adherence to project conventions, regressions, risks, test coverage, documentation, commit messages, and simplification opportunities. It complements the `review` phase, which is a conformance gate against the acceptance criteria of `tasks.json`.

The phase is **intended to be read-only**: Write/Edit are not in the tool allow-list, and the prompt forbids edits, commits and `gh pr review|comment|merge`. Bash stays available so the agent can run `gh`/`git` inspection commands — the restriction is policy plus allow-list, not a sandbox that can block every write. The report is persisted locally by the CLI, not by the agent.

| Flag | Description |
|------|-------------|
| `[pr]` | Pull Request number (discovered from the session when omitted) |
| `--issue <n>` | Issue the Pull Request belongs to -- enables state persistence in `~/.issue-flow/…/issues/<n>/tasks.json` |
| `--round <n>` | Rewrite a specific review round instead of appending a new one |
| `--yes` | Skip the confirmation of the discovered Pull Request |
| `--fail-on <level>` | Verdict that fails the command: `request-changes` (default), `suggestions`, `none` |

The [issue source flags](#flags) do not apply: the command never fetches the issue content, so reviewing a PR with no associated issue is a supported case, not a failure.

#### Pull Request discovery

With no argument, the PR is resolved in this deterministic order:

1. The explicit argument (`184`, `#184` or a PR URL)
2. `pullRequest` in `~/.issue-flow/…/issues/<N>/tasks.json`, written by the `pr` phase (when `--issue` is set)
3. `pullRequests[]` of the active in-memory session publisher (populated during `run --web` by `publishGitState` — not by reading `session.json` from disk)
4. `gh pr list --head <current branch>` -- the most recent PR (highest number)
5. Failure with an actionable message

The plan is preferred over the session so a stale or higher-numbered PR listed for the same branch cannot override the Pull Request this pipeline just opened. The command **never reviews a guessed PR**: when no source answers, it fails with exit code `1` instructing `issue-flow pr-review <number>`. When the PR comes from sources 2-4 in an interactive terminal, its number, title and branch are shown for a `(Y/n)` confirmation. The prompt is skipped in non-TTY environments, with `CI` set, with `--yes`, and when the phase runs from `run --pr-review` -- the discovered number is logged instead, so an automated run never hangs.

#### Artifacts

Reports are versionable and rounds are additive -- writing round N+1 never overwrites an earlier report nor drops entries from `index.json`:

```
~/.issue-flow/…/issues/42/pr-review/   # …/issues/pr-184/pr-review/ when there is no associated issue
  pr-184-round-1.md
  pr-184-round-2.md
  index.json
```

With no `--issue`, the Pull Request number becomes the issue identifier of the directory (`pr-184`): the global storage accepts non-numeric identifiers, so a review with no associated issue still gets a first-class directory of its own.

The Markdown report always carries the same eight sections: executive summary, strengths, issues found, suggested improvements, architectural observations, risks identified, required before merge, and final recommendation. `index.json` is the structured counterpart, so integrations do not have to reparse Markdown:

```json
{
  "schemaVersion": 1,
  "pullRequest": { "number": 184, "title": "feat: …", "url": "…", "headBranch": "issue/42-dark-mode" },
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

`severity` is one of `blocker`, `high`, `medium`, `low`. `recommendation` is `null` when the agent output could not be parsed -- a malformed verdict is never coerced into `APPROVE`; the raw output is preserved in the report and the command exits `1`. The `title`, `url` and `headBranch` of `pullRequest` are `null` when `gh` could not supply them; the number is always known.

#### Exit codes

| Code | Meaning |
|------|---------|
| `0` | `APPROVE` or `APPROVE_WITH_SUGGESTIONS` |
| `2` | `REQUEST_CHANGES` |
| `1` | Execution failure: headless run, `gh`, PR not found, invalid options, or an unparseable verdict |

`--fail-on suggestions` also returns `2` for `APPROVE_WITH_SUGGESTIONS`; `--fail-on none` always returns `0` for any verdict. Code `1` is never suppressed by `--fail-on` -- it means the review did not happen.

#### Configuration (`.issue-flow.json`)

Where reports are published is configuration, not code. Precedence is **CLI > environment variable > `.issue-flow.json` > default**:

| Environment variable | `.issue-flow.json` key | Values | Default |
|----------------------|------------------------|--------|---------|
| `ISSUE_FLOW_PR_REVIEW_PUBLISHER` | `prReview.publisher` | `local` | `local` |

```json
{
  "prReview": {
    "publisher": "local"
  }
}
```

`local` writes the `.md` report and `index.json` under `~/.issue-flow/…/issues/<N>/pr-review/`. Publishing back to GitHub is not implemented in v1 -- the publisher port exists so that adding it is a configuration change. An unknown value degrades to `local` with a warning instead of throwing.

### `web` -- Manage the monitoring server

```bash
# Stop the single monitoring server, if one is running
npx issue-flow web stop

# Internal: run the monitor in the foreground. Spawned detached by --web --
# there is normally no reason to invoke this yourself.
npx issue-flow web serve --port 3737 --host 127.0.0.1 --refresh 5
```

`web stop` is the explicit counterpart to `--web`'s automatic start (see [Web Monitoring → Single instance](#single-instance-detached-from-the-pipeline)): it signals the detached server referenced by [`~/.issue-flow/web.lock`](#issue-flowweblock) to shut down and waits for the lock file to be removed, or reports that no monitor is running. `web serve` is what `--web` spawns behind the scenes the first time on a machine; running it by hand only matters for debugging the monitor itself, independent of any pipeline run.

## Issue Sources (Providers)

The demand reaches the pipeline through an **issue provider**, so every phase works the same way regardless of where the issue lives:

| Provider | Origin | Requires |
|----------|--------|----------|
| `github` (default) | GitHub issues, read through `gh` | `gh` installed and authenticated |
| `local` | `issue.md` + `metadata.json` in `~/.issue-flow/…/issues/<N>/` | nothing beyond git -- works offline, in a repo with no remote, or on a demand that is not public yet |

The issue content is fetched **in the CLI** and injected into every prompt (`analyze`, `prd`, `plan`, `review`, `pr`). The agent never runs `gh issue view`, so all phases see byte-identical content and a local issue is not a special case for them.

> Running with no flags and no `.issue-flow.json` is indistinguishable from previous versions: GitHub is the preferred provider and the behavior is unchanged.

### Resolution and conflicts

`run` resolves the origin **once** and propagates the decision to every phase; standalone phase commands resolve on their own. Content is compared through `contentHash` -- a SHA-256 of the normalized title and body -- so the two copies are equal when the text is equal, regardless of formatting of line endings.

| Situation | Behavior |
|-----------|----------|
| Only the local copy exists | uses the local one |
| Only the GitHub issue exists | uses the remote one (unchanged flow) |
| Both, identical `contentHash` | reports the equivalence and continues with the preferred provider, no prompt |
| Both, different `contentHash` | reports the divergence (title, size, `updatedAt`, hash of each side) and applies `conflictPolicy` |
| Neither | fails with exit code 1, listing what each origin answered |

With `conflictPolicy: "ask"` **and** an interactive terminal, the versions are listed and you choose: `[1] Local  [2] GitHub  [3] Cancel` (cancelling exits non-zero). In CI or any non-TTY environment the prompt is never shown -- the preferred provider is used and a warning is printed, so an automated run can never hang. `prefer-local` and `prefer-github` never prompt.

### Flags

Available on `run`, `init`, `analyze`, `prd`, `plan`, `review` and `pr`:

| Flag | Effect |
|------|--------|
| `--local` | Prefer the local provider |
| `--github` | Prefer the GitHub provider (default) |
| `--prefer-local` | On divergence, use the local version without asking |
| `--prefer-github` | On divergence, use the GitHub version without asking |
| `--ask` | On divergence, ask which version to use (interactive terminals only) |

`--local` and `--github` are mutually exclusive, and so are `--prefer-local`, `--prefer-github` and `--ask`; passing more than one of a group fails with a clear message. Preferring an origin does not exclude the other: both are still queried, which is what makes divergence detectable.

### Configuration (`.issue-flow.json`)

The same project config file used by web monitoring carries an `issues` key. Precedence is **CLI flag > `.issue-flow.json` > default**:

```json
{
  "issues": {
    "defaultGenerateTarget": "github",
    "preferredProvider": "github",
    "conflictPolicy": "ask",
    "requireConfirmation": true
  }
}
```

| Key | Values | Default | Meaning |
|-----|--------|---------|---------|
| `defaultGenerateTarget` | `github` \| `local` \| `both` | `github` | Where `generate` creates the issue when no destination flag is given |
| `preferredProvider` | `github` \| `local` | `github` | Which origin wins when both have the issue |
| `conflictPolicy` | `ask` \| `prefer-local` \| `prefer-github` | `ask` | What to do on divergence |
| `requireConfirmation` | boolean | `true` | Reserved for confirmation prompts; validated but not consumed yet |

A missing file, invalid JSON or an invalid `issues` key falls back to the defaults with a warning -- it never throws. Every default reproduces the previous behavior.

### Local issue format

```
~/.issue-flow/projects/<project-id>/issues/42/
  issue.md        # H1 (first non-empty line) is the title, everything after it is the body
  metadata.json   # validated against the issue metadata schema
```

```json
{
  "schemaVersion": 1,
  "id": "42",
  "number": 42,
  "source": "local",
  "title": "Add dark mode support",
  "labels": ["enhancement"],
  "state": "open",
  "createdAt": "2026-08-03T12:00:00Z",
  "updatedAt": "2026-08-03T12:00:00Z",
  "contentHash": "sha256:…",
  "remote": {
    "provider": "github",
    "ref": "https://github.com/owner/repo/issues/42",
    "syncedAt": "2026-08-03T12:00:00Z",
    "syncedContentHash": "sha256:…"
  }
}
```

- `remote` is optional and written only by `generate --both`; all four of its fields go together.
- `contentHash` is **recalculated from `issue.md` on every read**, so editing the file by hand immediately shows up as a divergence against the GitHub copy instead of being silently ignored.
- `metadata.json` may be absent: when only `issue.md` exists, minimal metadata is derived (id, H1 title, `state: "open"`, file timestamps). An invalid `metadata.json` is a hard error naming the path and the offending field.
- Identifiers for new local issues are allocated above the highest number found among the project's issue directories in the global storage -- which includes anything migrated out of a legacy `issues/` tree, so a number already used before the migration is never reissued -- and, when `gh` is reachable, above the highest GitHub issue/PR number too, so a local issue never collides with a future remote one.

## Web Monitoring

`run` and `execute` support an optional (off by default) real-time monitoring mode: a local HTTP server serves a self-contained web UI showing live progress -- current phase and activity, user stories, commits, pull requests, logs, errors, and time estimates. The page is read-only, works offline (no CDN, no external resources), and polls the server at a configurable interval.

At the top of the page, two cards give the full context of the run without leaving the browser: **"Resumo da issue"** (issue number, title, full description, labels, and open/closed state -- with a neutral "Não definida" placeholder for priority, since the `Issue` domain has no such field) and **"Repositório"** (current branch, short HEAD commit, repository name, and the project's working directory). The **"User stories"** card shows, per story, a status badge (`backlog` / `in_progress` / `in_review` / `done`), its existing pass/fail indicator and duration, and, when declared, the story IDs it depends on. All three cards degrade gracefully to neutral placeholders (`—`, "Sem título", "Sem descrição") whenever the underlying `session.json` predates these fields or a value simply isn't available (no remote configured, no commits yet, etc.) -- nothing about the pre-existing sections (progress, current phase, next steps, commits, PRs, logs) changes.

### Views: "Execução" and "Kanban"

Below the header and the alerts, the panel is split into two tabs. **"Execução"** is the vertical panel described above, unchanged. **"Kanban"** is a second reading of the same data: every user story laid out in four columns -- **Backlog**, **Em andamento**, **Em revisão**, **Concluído** -- grouped by the story's `status`, each column showing its own story count. A story whose `status` is absent (older `session.json`) or unrecognized falls into Backlog rather than disappearing, and every column renders even when it is empty, so an empty plan still shows the board instead of a blank page.

Each card carries the story id, its title, a short excerpt of the description (clamped to three lines -- the full text stays in the DOM), a status badge, and the same `✓`/`○` completion indicator the "User stories" card uses. Clicking a card -- or focusing it and pressing Enter -- opens a **side drawer** with the story's full title, status, description, acceptance criteria, declared dependencies, and its duration and completion time when known. A section for the story's update history is rendered only if a future `session.json` publishes one; today no such field exists, so the section is simply absent. The drawer closes on the overlay, the close button, or `Esc`, and returns focus to the card that opened it.

Switching tabs never interrupts polling: both views are re-rendered on every refresh, so the Kanban is already current the moment it is opened, and an open drawer stays open across refreshes, updating in place (it closes on its own if the story disappears from the plan). The drawer issues **no** additional network requests -- everything it shows already came with the snapshot.

Like the rest of the panel, both views are strictly read-only: `snapshot.readOnly` stays `true`, `capabilities` stays empty, and the interface exposes no control that edits, deletes, reorders, or changes the status of anything.

```bash
# Enable with defaults (http://127.0.0.1:3737)
npx issue-flow run 42 --web

# Custom port and polling interval
npx issue-flow run 42 --web --port 8080 --refresh 10

# Stop the monitor explicitly (see "Single instance" below)
npx issue-flow web stop
```

### Single instance, detached from the pipeline

There is at most **one** monitoring server per machine, and it outlives any single `run`/`execute` invocation:

- The first `--web` invocation on a machine spawns the server as its own **detached background process** (`child_process.spawn(..., { detached: true })`) instead of binding inline -- the pipeline process that triggered it can exit normally (including a plain, non-`--web` `Ctrl-C`) without taking the monitor down with it. Ownership is tracked in [`~/.issue-flow/web.lock`](#issue-flowweblock).
- Every subsequent `--web` invocation, from the same project or a different one, detects the live instance (`pid` alive + `GET /api/health` answers) and **reuses it** instead of starting a second one -- no port conflicts, no silently-degraded second monitor.
- The server is single-instance, not single-session: it watches the whole `~/.issue-flow` tree and reflects **every** active run, from every project, at once (see [Multiple sessions](#multiple-sessions) below). Opening the same `http://host:port` URL while a second, unrelated `run --web` starts elsewhere shows both.
- Stop it explicitly with:

  ```bash
  npx issue-flow web stop
  ```

  This sends the process a graceful shutdown signal and waits for `web.lock` to be removed; with no monitor running, it says so and exits `0`. There is no other way to stop it short of killing the `pid` from `web.lock` directly -- closing every browser tab or every `run --web` invocation on purpose does **not** stop it, by design, since it may still be serving other sessions.

If the global storage tree itself is unavailable (e.g. no resolvable home directory and no `ISSUE_FLOW_HOME` override), monitoring falls back to the pre-single-instance behavior instead of being lost entirely: the server binds **inline**, in the pipeline's own process, serving only that run's snapshot from memory, with no lock file and no detached process. A warning is printed when this happens. This legacy mode has the same single-run scope monitoring always had before -- it exists purely so a broken global storage tree degrades gracefully rather than silently disabling `--web`.

### Multiple sessions

Because the server is decoupled from any one run, it cannot rely on that run's in-memory state -- instead it polls `~/.issue-flow/projects/*/issues/*/session.json` on disk (the same file each run already writes) and keeps every well-formed, recently-updated one as an **active session**. A session stops being reported shortly after its process stops updating that file.

`GET /api/sessions` lists every active session:

```json
[
  {
    "sessionId": "3f9e2b7a-…",
    "issueNumber": 42,
    "status": "running",
    "startedAt": "2026-08-04T16:00:00Z",
    "updatedAt": "2026-08-04T16:05:00Z",
    "statusUrl": "/api/status?session=3f9e2b7a-…"
  }
]
```

`GET /api/status?session=<id>` returns that session's full snapshot (the same shape documented under [`session.json`](#sessionjson) below). Without `?session=`, `/api/status` keeps the pre-multi-session behavior when it is unambiguous: with **exactly one** active session it answers that one directly; with **zero** or **more than one**, it answers `404`/`409` respectively instead of guessing, with the `409` body listing every active `sessionId` so a client can disambiguate.

Monitoring never affects the pipeline: publishing failures are swallowed with a single warning, a busy port (`EADDRINUSE`) just skips the server, and killing the server or closing the browser mid-run has no effect on the execution. With `--web` off, the terminal output and behavior are byte-for-byte identical to previous versions.

### Configuration

Each setting resolves with the precedence **CLI flag > environment variable > `.issue-flow.json` > default**:

| CLI flag | Environment variable | `.issue-flow.json` key | Default |
|----------|----------------------|------------------------|---------|
| `--web` / `--serve` | `ISSUE_FLOW_WEB` | `web.enabled` | `false` |
| `--port <n>` | `ISSUE_FLOW_WEB_PORT` | `web.port` | `3737` |
| `--host <h>` | `ISSUE_FLOW_WEB_HOST` | `web.host` | `127.0.0.1` |
| `--refresh <s>` | `ISSUE_FLOW_WEB_REFRESH` | `web.refreshSeconds` | `5` |
| `--web-log-limit <n>` | `ISSUE_FLOW_WEB_LOG_LIMIT` | `web.logLimit` | `200` |
| `--web-no-logs` | -- | `web.includeLogs` | logs included |

`.issue-flow.json` lives at the project root and is entirely optional -- a missing file or invalid content falls back to the defaults with a warning:

```json
{
  "web": {
    "enabled": true,
    "port": 3737,
    "host": "127.0.0.1",
    "refreshSeconds": 5,
    "logLimit": 200,
    "includeLogs": true
  }
}
```

The server exposes `GET /` (the UI), `GET /api/status[?session=<id>]` (the JSON snapshot, also at `/status.json`), `GET /api/sessions`, and `GET /api/health`.

### Remote access via Tailscale

The server binds to `127.0.0.1` by default (local access only). To watch a run from another device -- e.g. your phone, over [Tailscale](https://tailscale.com) -- bind to your machine's Tailscale IP (`100.x.y.z`):

```bash
npx issue-flow run 42 --web --host 100.101.102.103
# then open http://100.101.102.103:3737 from any device in your tailnet
```

Binding to `0.0.0.0` also works but exposes the server to your entire local network -- the CLI prints an explicit warning when you do. The interface is strictly read-only (no control endpoints), but prefer the Tailscale IP over `0.0.0.0` when possible.

### `session.json`

When monitoring is enabled, the same snapshot served over HTTP is also persisted to `~/.issue-flow/…/issues/N/session.json` (atomic writes, throttled to ~1s, final state flushed at the end of the run). Abridged format:

```json
{
  "schemaVersion": 1,
  "sessionId": "…",
  "readOnly": true,
  "issue": {
    "number": 42,
    "url": "https://github.com/owner/repo/issues/42",
    "title": "Dark mode",
    "description": "The full issue body, untruncated…",
    "labels": ["enhancement", "ui"],
    "state": "open"
  },
  "status": "running",
  "startedAt": "2026-08-03T16:00:00Z",
  "elapsedSeconds": 754,
  "estimatedRemainingSeconds": 420,
  "progress": { "percent": 45, "phasesCompleted": 3, "phasesTotal": 6, "storiesCompleted": 4, "storiesTotal": 10 },
  "currentPhase": "execute",
  "currentActivity": { "story": "US-005", "tool": "Bash", "detail": "npm test", "since": "…" },
  "phases": [
    {
      "name": "execute", "status": "completed", "durationSeconds": 754, "error": null,
      "inputTokens": 812, "outputTokens": 43120, "cacheReadTokens": 1284000,
      "cacheCreationTokens": 96400, "costUsd": 3.4187
    }
  ],
  "stories": [
    {
      "id": "US-001", "title": "…", "priority": 1, "passes": true, "completedAt": "…",
      "status": "done", "dependencies": [],
      "description": "…", "acceptanceCriteria": ["…"],
      "durationSeconds": 188, "inputTokens": 203, "outputTokens": 10780,
      "cacheReadTokens": 321000, "cacheCreationTokens": 24100, "costUsd": 0.8547
    }
  ],
  "metrics": {
    "totalInputTokens": 1104, "totalOutputTokens": 51890,
    "totalCacheReadTokens": 1502300, "totalCacheCreationTokens": 118900,
    "totalCostUsd": 4.1052
  },
  "execution": { "iteration": 5, "retries": 0, "correctionCycle": 0, "maxCorrectionCycles": 3 },
  "git": { "branch": "issue/42-dark-mode", "baseBranch": "main", "commits": [{ "hash": "abc1234", "subject": "feat: …" }] },
  "repository": {
    "name": "owner/repo",
    "remoteUrl": "git@github.com:owner/repo.git",
    "branch": "issue/42-dark-mode",
    "headCommit": "abc1234",
    "root": "/Users/me/code/repo"
  },
  "pullRequests": [{ "number": 43, "url": "…", "title": "…" }],
  "logs": [{ "at": "…", "level": "info", "message": "…" }],
  "errors": [],
  "warnings": [],
  "lastError": null,
  "nextSteps": ["review", "pr"],
  "environment": { "node": "v22.0.0", "platform": "darwin" }
}
```

`session.json` is a runtime artifact, rewritten from scratch on every run. It lives outside the working tree, so it never shows up in `git status` -- see [The legacy `issues/` directory](#the-legacy-issues-directory) if your project used to commit it.

`schemaVersion` stays `1`: every field described below is additive, and a `session.json` written by an earlier version still parses -- absent sections are filled with their neutral defaults (`null`, `[]`) rather than rejected.

### `issue` and `repository`

Both sections are published in the same window as `session:start`, so the **first** poll of `/api/status` already carries them -- there is no disk or `git` I/O per HTTP request.

| Field | Source | Notes |
|-------|--------|-------|
| `issue.number`, `issue.url` | The resolved issue | `url` is the remote reference; `null` for a local-only issue with no remote |
| `issue.title` | The resolved issue | `null` when unknown |
| `issue.description` | The issue body | Published **in full, never truncated** -- the consumer decides how to fold it |
| `issue.labels` | The issue | `[]` when the issue has none |
| `issue.state` | The provider | `open` / `closed` for the built-in providers; typed as `string \| null` so other providers can report their own |
| `repository.name` | `origin` remote | `owner/repo`; `null` without a remote |
| `repository.remoteUrl` | `origin` remote | As configured, minus any embedded `http(s)` credentials (`user:token@`) |
| `repository.branch` | Current checkout | Same value as `git.branch` |
| `repository.headCommit` | `git rev-parse --short HEAD` | `null` in a repository with no commits yet |
| `repository.root` | Project root | Absolute path the pipeline runs from |

There is no textual **priority** on the issue: the domain has no such attribute, and Issue Flow does not invent one. Consumers that want a priority derive it from `labels`.

Every `repository` field is collected independently and failure-tolerant -- no remote configured, no commits yet or a missing `git` binary each show up as `null` instead of failing the publication. `repository.name` inherits the lowercasing of the remote-URL normalizer, a known limitation: a repository named `Owner/Repo` is reported as `owner/repo`.

`repository.remoteUrl` is served unauthenticated by `/api/status` and persisted to `session.json`, so it is never the raw output of `git remote get-url origin`: an `http`/`https` remote's userinfo (`user:token@host/...`, the shape CI commonly uses to embed a PAT) is stripped before publication. SSH remotes are left untouched -- both `ssh://user@host/path` and the scp-like `user@host:path` shorthand require that user segment to connect at all (it is almost always the fixed `git` service account, never a secret), so removing it would just break the remote for no security benefit.

### Story `status`

Each entry of `stories[]` carries a board-style `status` (`backlog` | `in_progress` | `in_review` | `done`) and the `dependencies` declared in the plan, so a Kanban-style view does not have to reimplement the heuristic. The status is **recomputed on every reduction**, in this order:

1. `passes === true` → `done`
2. the current status is `in_review` → stays `in_review`
3. `currentActivity.story` is this story's id → `in_progress`
4. otherwise → `backlog`

Two consequences are worth stating explicitly:

- **`in_review` is never derived automatically.** It only ever enters through an explicit `status` in `tasks.json`, and once set it sticks until `passes` flips to `true`.
- **`passes` still wins.** A story declaring `status: "done"` with `passes: false` is reported as `backlog` (or `in_progress`): rule 1 governs, and `passes` remains the single source of truth for what the pipeline executes.

Each entry also carries the plan's `description` and `acceptanceCriteria`, so the panel's story drawer can show them without reading `tasks.json`. Both are copied straight from the plan on every `stories:update`. Like every other addition, they are tolerant on input: a `session.json` written before they existed parses with `""` and `[]`, never `undefined`.

### Tokens and cost

Every phase reports what it spent on the `claude` CLI, and the same numbers show up in three places: the `Tokens:` line of the terminal summary, the web panel (per phase, per story, and the issue total), and `session.json`. `schemaVersion` stays `1` -- the fields below are additive, and a `session.json` written by an earlier version still loads.

| Field | Where | Meaning |
|-------|-------|---------|
| `inputTokens` | `phases[]`, `stories[]` | Non-cached prompt tokens |
| `outputTokens` | `phases[]`, `stories[]` | Tokens generated by the model |
| `cacheReadTokens` | `phases[]`, `stories[]` | Prompt tokens served from the prompt cache |
| `cacheCreationTokens` | `phases[]`, `stories[]` | Prompt tokens written into the cache |
| `costUsd` | `phases[]`, `stories[]` | Cost in USD, as reported by the CLI |
| `durationSeconds` | `stories[]` | Wall-clock seconds attributed to the story |
| `metrics.total*` | root | The same five measures summed over the whole issue |

All of them are `number | null`, and `null` means **not reported** -- never zero. A phase that ran without the CLI ever returning usage data keeps its fields at `null`, and no surface renders a segment for a `null` value.

**Reading the numbers.** `inputTokens` alone badly understates what a run consumed: Issue Flow sends a large, mostly stable prompt on every invocation, so the bulk of the context is billed as cache reads (`cacheReadTokens`, cheap) or cache writes (`cacheCreationTokens`, slightly more expensive than plain input), and only the small varying tail lands in `inputTokens`. It is normal for `cacheReadTokens` to be two or three orders of magnitude larger than `inputTokens`. Use `costUsd` for "what did this cost", and the token fields to understand *why* it cost that.

Two limitations are worth knowing:

- **Per-story attribution is an approximation.** The CLI reports usage per invocation, not per story, and one iteration of the execute loop can flip more than one story to `passes: true`. When it does, that iteration's tokens, cost and duration are split **evenly** among the stories that completed in it (tokens rounded to integers) -- so a cheap story finishing alongside an expensive one gets the same share. When an iteration completes no story, nothing is attributed to any story and the numbers stay in the `execute` phase total only. Phase totals and `metrics.total*` never double-count the split: they come from the iteration itself, never from summing `stories[]`. Because each story's share is rounded independently, **summing the token fields across `stories[]` for one iteration can differ by a few tokens from that iteration's real total** -- do not treat `sum(stories[].inputTokens)` as authoritative; the `execute` phase total and `metrics.total*` are.
- **USD cost only appears when the CLI provides it.** `costUsd` and `metrics.totalCostUsd` are passed through from the `claude` CLI's own accounting (`total_cost_usd`). If your CLI version, model or plan does not report it, token counts still show up and every cost field stays `null` -- Issue Flow never estimates a price from token counts.

## Pipeline State & File Structure

Each issue's state is tracked in a directory of its own inside the [global storage](#global-storage), keyed by the project id and the issue identifier:

```
~/.issue-flow/projects/<project-id>/issues/42/
  issue.md       # Issue statement (local issues only -- title in the H1, body below)
  metadata.json  # Issue metadata (local issues only -- see Local issue format)
  prd.md         # Product requirements
  tasks.json     # Task plan with pipeline state and user stories
  progress.txt   # Execution log
  analysis.md    # Issue analysis (optional, from standalone analyze command)
  session.json   # Live session snapshot (only with web monitoring enabled)
  .last-branch   # Last branch the execution loop worked on
  archive/       # Artifacts superseded by a later iteration
  pr-review/     # PR review reports and index (only when the pr-review phase ran)
```

`issue.md` and `metadata.json` only exist for issues created or mirrored locally; a GitHub-only run never writes them. Every path above is resolved by a single function (`getIssuePaths`), so no command can invent a layout of its own -- a test fails the build if any file outside `src/storage/` builds an issue path by hand.

Nothing here is inside your repository, so a run leaves your working tree untouched: no artifact to ignore, no artifact to commit, and no diff noise from `session.json`. The trade-off is that the artifacts are machine-local -- see below.

The `pipeline` field tracks which phases have completed, enabling resume from any point:

```json
{
  "pipeline": {
    "prdCompleted": true,
    "jsonCompleted": true,
    "executionCompleted": false,
    "reviewCompleted": false,
    "prCreated": false
  }
}
```

### Story status and dependencies in `tasks.json`

A user story may declare two extra fields. Both are **optional**, and absent means *not informed* -- a plan written without them keeps loading unchanged, and a round-trip through the pipeline never materialises them with an artificial value:

```json
{
  "userStories": [
    {
      "id": "US-002",
      "title": "…",
      "priority": 2,
      "passes": false,
      "status": "in_review",
      "dependencies": ["US-001"]
    }
  ]
}
```

| Field | Values | Meaning |
|-------|--------|---------|
| `status` | `backlog` \| `in_progress` \| `in_review` \| `done` | Board-style status, purely **observational** |
| `dependencies` | `string[]` | Ids of other stories in the same plan |

`passes` remains the source of truth for execution: no phase reads `status` to decide what to run next, and a `status` of `done` on a story with `passes: false` does not make the execute loop skip it. What `status` does is seed the [snapshot's derived status](#story-status) -- the only way to get `in_review` onto the board, since the derivation never produces it on its own.

`dependencies` is validated **by shape only** (an array of strings). Issue Flow does not check that the referenced ids exist, and does not detect cycles.

### Per-story metrics in `tasks.json`

The execute loop also writes what each user story cost back into `tasks.json`, so the data outlives the session and does not depend on web monitoring being on. All six fields are **optional** and only appear once the story has completed at least one iteration:

```json
{
  "userStories": [
    {
      "id": "US-001",
      "title": "…",
      "priority": 1,
      "passes": true,
      "notes": "",
      "inputTokens": 203,
      "outputTokens": 10780,
      "cacheReadTokens": 321000,
      "cacheCreationTokens": 24100,
      "costUsd": 0.8547,
      "durationSeconds": 188
    }
  ]
}
```

They carry the same meaning as their [`session.json` counterparts](#tokens-and-cost), including both limitations: the values are the story's **even share** of the iteration that completed it, and `costUsd` is absent whenever the `claude` CLI did not report a price. Values accumulate across iterations, so a story that took two passes to finish shows the sum of both.

A `tasks.json` written before this feature keeps loading unchanged -- missing fields stay missing rather than being filled with zeros, which is what keeps "not reported" distinguishable from "cost nothing".

### Pull Request and review state

The `pr` and `pr-review` phases add three optional fields. All of them are **absent** until the corresponding phase runs, so a `tasks.json` written by an earlier version keeps loading unchanged:

```json
{
  "pipeline": {
    "prCreated": true,
    "prReviewCompleted": true
  },
  "pullRequest": {
    "number": 184,
    "url": "https://github.com/owner/repo/pull/184",
    "headBranch": "issue/42-dark-mode",
    "createdAt": "2026-08-03T16:00:00Z"
  },
  "prReview": {
    "enabled": true,
    "pullRequestNumber": 184,
    "rounds": 2,
    "lastRecommendation": "APPROVE_WITH_SUGGESTIONS",
    "lastReviewedAt": "2026-08-03T16:30:00Z"
  }
}
```

| Field | Written by | Meaning |
|-------|-----------|---------|
| `pipeline.prReviewCompleted` | `pr-review` | `true` only on `APPROVE` / `APPROVE_WITH_SUGGESTIONS`; stays `false` on `REQUEST_CHANGES` |
| `pullRequest` | `pr` | The created PR, so later phases do not have to query GitHub again |
| `prReview.enabled` | `run --pr-review` | Persisted opt-in; the standalone command never turns it on |
| `prReview.rounds` | `pr-review` | Number of review rounds recorded under the issue's `pr-review/` directory |
| `prReview.lastRecommendation` | `pr-review` | `APPROVE` \| `APPROVE_WITH_SUGGESTIONS` \| `REQUEST_CHANGES` |

### The legacy `issues/` directory

Earlier releases wrote all of the above to `<projectRoot>/issues/N/`. That directory is now **legacy and read-only**: the first command that touches the project copies it into the global storage and never writes, renames or deletes anything inside it again (see [Migrating from `issues/`](#migrating-from-issues)). It is preserved on purpose -- rolling back to an earlier version of Issue Flow finds its data exactly where it left it.

Two consequences are worth knowing:

- **Artifacts are no longer shareable through git.** If your project used to commit `issues/` to review `prd.md` or `tasks.json`, those files are now under `~/.issue-flow` on the machine that ran the pipeline. The committed copies stay valid as a historical record, but they stop being updated.
- **Local issues are machine-local too.** With [local issues](#local-issue-format), `issue.md` and `metadata.json` are the demand itself rather than build output, and they now live outside the repository. A clone on another machine does not see them; `--both` (a GitHub issue plus a local mirror) is the way to keep the demand shared.

The root `.gitignore` of this repository keeps its `/issues` entry: it now guards the legacy directory of anyone running the pipeline from a checkout, so a migrated-from tree is never committed by accident.

## Global Storage

Issue Flow keeps every artifact in a machine-wide storage layer rooted at `~/.issue-flow`. It keeps each run's state out of your working tree and lets preferences be set once for all projects.

Every phase (`analyze`, `prd`, `plan`, `execute`, `review`, `pr`, `pr-review`, `run`) and the [local issue provider](#issue-sources-providers) resolve their paths here, through a single resolver that also triggers the [migration](#migrating-from-issues) of a legacy `issues/` tree on first use. The one part still on the way is the config file: the [precedence table](#precedence) below is implemented and tested, but `loadWebConfig()` does not read the global layer yet.

### Directory tree

```
~/.issue-flow/
  config.json                          # Machine-wide preferences (optional, see below)
  web.lock                             # PID + port of the active web monitor, if any (see below)
  projects/
    issue-flow-4b21c0e9f7a3/           # One directory per project: <slug>-<hash12>
      metadata.json                    # Project identity and timestamps
      issues/
        42/                            # One directory per issue identifier
          issue.md                     # Issue statement (local issues only)
          metadata.json                # Issue metadata (local issues only)
          prd.md                       # Product requirements
          tasks.json                   # Task plan with pipeline state and user stories
          progress.txt                 # Execution log
          analysis.md                  # Issue analysis
          session.json                 # Live session snapshot (web monitoring)
          .last-branch                 # Last branch used for this issue
          archive/                     # Superseded artifacts
          pr-review/                   # PR review reports and index
```

Issue identifiers are not necessarily numeric -- `auth-refactor` and `pr-184` are valid directory names, exactly as in the local provider. Everything is resolved by `getIssuePaths(projectId, issueNumber)`; no call site joins these names by hand.

`metadata.json` at the project level records the identity of the project:

```json
{
  "schemaVersion": 1,
  "projectId": "issue-flow-4b21c0e9f7a3",
  "root": "/Users/me/Projects/issue-flow",
  "remoteUrl": "github.com/fabioassuncao/issue-flow",
  "createdAt": "2026-08-04T02:00:00Z",
  "updatedAt": "2026-08-04T02:00:00Z",
  "lastAttemptAt": null,
  "userStoryNumbering": {
    "nextNumber": 16,
    "source": "history",
    "issueNumber": "42",
    "decidedAt": "2026-08-04T02:00:00Z",
    "detail": "US-015 (issue #32)"
  }
}
```

`root` is the last known local checkout and is informative only -- identity lives in `projectId`. `remoteUrl` is `null` for a project with no `origin` remote. Unknown keys are ignored on read, so a file written by a newer release stays readable by an older one.

`userStoryNumbering` records the most recent `plan` numbering decision (see [User Story numbering continuity](#user-story-numbering-continuity)), for audit only -- it is absent until the first `plan` run through the numbering resolver and is never read back to decide a *later* numbering, which always re-scans `tasks.json`. `source` is one of `history` (recovered automatically, or via `--continue`), `start-us` (forced via `--start-us <n>`), or `none` (no history found, starting at `US-001`).

### Project id

Each project gets a deterministic id in the form `<slug>-<hash12>`:

| Part | Derivation |
|------|-----------|
| `slug` | Repository name, lowercased and reduced to `[a-z0-9-]`, runs of separators collapsed, truncated to 32 characters (`project` when nothing survives). Cosmetic only -- it makes the directory recognizable. |
| `hash12` | First 12 hex characters of the SHA-256 of the seed. This is what carries the identity. |

The seed is canonical rather than local:

| Condition | Seed | Slug from |
|-----------|------|-----------|
| `git remote get-url origin` resolves | `remote:<host>/<org>/<repo>` | Last segment of the remote path |
| No `origin` remote | `path:<absolute project root>` | `basename` of the project root |

The remote is normalized before hashing -- protocol, embedded credentials, SSH user, port, `.git` suffix and trailing slashes are stripped, and host plus path are lowercased. So `https://github.com/org/repo.git`, `git@github.com:org/repo.git` and `ssh://git@github.com:22/org/repo` all seed to `github.com/org/repo` and produce the **same id on every machine**: two clones of the same repository share their history, and moving or renaming the local folder is harmless. (One consequence of lowercasing the path: on a case-sensitive self-hosted server, `org/Repo` and `org/repo` collapse to the same id.)

The `remote:` / `path:` prefix is part of the hashed seed, so a project identified by path can never collide with one identified by remote.

**Known limitation of the path fallback.** For a repository with no `origin` remote, the absolute path *is* the identity. Moving or renaming that folder yields a different id, and the previous history is left behind under the old one -- nothing is deleted, but the new directory starts empty. Configuring a remote before adopting the global storage avoids this entirely.

### `ISSUE_FLOW_HOME`

`ISSUE_FLOW_HOME` relocates the whole tree:

```bash
ISSUE_FLOW_HOME=/tmp/issue-flow-ci npx issue-flow run 42
```

It is the single seam through which the root is resolved: set it and *every* path above moves with it. A relative value is resolved against the current working directory. Use it to isolate CI runs, sandboxes and test suites from the real `$HOME` -- Issue Flow's own tests point it at a temporary directory for exactly this reason. When it is unset, the root is `~/.issue-flow`.

### `~/.issue-flow/config.json`

Preferences that apply to every project, all keys optional:

```json
{
  "schemaVersion": 1,
  "storageDir": "/mnt/data/issue-flow",
  "web": {
    "port": 3737,
    "host": "127.0.0.1",
    "refreshSeconds": 5,
    "logLimit": 200
  },
  "retry": {
    "retryLimit": 10,
    "retryForever": false,
    "backoffBaseSeconds": 30,
    "backoffMaxSeconds": 900
  },
  "commit": {
    "signoff": false,
    "conventional": true
  }
}
```

| Key | Meaning |
|-----|---------|
| `schemaVersion` | Format version of the file |
| `storageDir` | Alternative directory holding `projects/` |
| `web` | Machine-wide web monitoring defaults. Deliberately a subset of the `web` key of `.issue-flow.json`: `enabled` and `includeLogs` stay a per-project decision |
| `retry` | Retry and backoff preferences, mirroring the engine defaults |
| `commit` | Commit preferences (`signoff`, `conventional`) |

The file is read by `loadGlobalConfig()`, which **never throws**. A missing file is silent -- it is the common case. Invalid JSON, a non-object root, an unreadable path or an invalid key each degrade to "no global preference" with a warning, and validation happens key by key: a typo under `retry` costs you `retry` only, never your `web` settings. Unknown keys are dropped without a warning, which is what keeps a file written by a newer release readable.

### `~/.issue-flow/web.lock`

Marks the single web monitoring server active on this machine. `pid` is the **detached `issue-flow web serve` process**, not the `run`/`execute` invocation that triggered it:

```json
{
  "pid": 41213,
  "port": 3737,
  "host": "127.0.0.1",
  "startedAt": "2026-08-04T02:00:00Z"
}
```

Before starting a monitor, `run --web` reads this file, checks that `pid` is a live process and that `GET /api/health` answers on `host:port`. When both hold, the existing instance is reused and no new server spawns. When either fails (dead `pid`, or a live one that does not answer), the lock is treated as stale, removed, and a freshly spawned instance claims it instead -- written with an exclusive create (`wx`) so two invocations racing to become the owner still agree on exactly one winner. The file is removed when the server closes, whether that is `issue-flow web stop` or the process exiting on its own.

### Precedence

Settings resolve from the highest-priority source that provides them:

| Priority | Source | Example |
|----------|--------|---------|
| 1 (highest) | CLI flag | `--port 4000` |
| 2 | Environment variable | `ISSUE_FLOW_WEB_PORT=4000` |
| 3 | `.issue-flow.json` in the project root | `{ "web": { "port": 4000 } }` |
| 4 | `~/.issue-flow/config.json` | `{ "web": { "port": 4000 } }` |
| 5 (lowest) | Built-in default | `3737` |

The merge is per key and shallow: a layer only participates with the keys it actually carries, so a global `config.json` that sets `web.host` but not `web.port` leaves a project-level `web.port` untouched. Nested objects (`web`, `retry`) are replaced whole rather than field by field.

As noted above, this is the documented and implemented precedence (`mergeConfigLayers()` in `src/config.ts`), but the global config file is not yet plugged into the commands: today `loadWebConfig()` still resolves **CLI flag > environment variable > `.issue-flow.json` > default**, as described under [Web Monitoring → Configuration](#configuration). This is about `config.json` only -- the storage tree itself is fully wired up.

### Migrating from `issues/`

Migration is **automatic**: the first command that resolves a path for a project copies an existing `<projectRoot>/issues/` tree into the global storage before reading anything. There is no command to run and no flag to pass -- upgrading and running `issue-flow run 42` is all it takes.

It is **non-destructive by construction**: `<projectRoot>/issues/` is never modified, renamed or removed -- there is no removal option, not even opt-in. Migration is a copy that refuses to overwrite, which also makes it idempotent (running it twice copies nothing the second time) and resumable after a partial failure. Subdirectories (`archive/`, `pr-review/`) and dotfiles (`.last-branch`) come across intact.

When files are actually copied, the CLI prints the source directory, the destination directory and how many files moved across, plus a reminder that the legacy directory was left untouched. A run that copies nothing prints nothing, so the notice appears once and does not turn into per-command noise.

An existing global directory always wins: once artifacts live there, that is the source of truth, and a legacy directory left behind is simply preserved. The check also runs **per issue**, not only per project: an issue that appears under `<projectRoot>/issues/` after the project was migrated is picked up the first time it is resolved.

**Known scenario -- collaborators on different versions.** In a repository where `issues/` is committed and part of the team is still on an older release, state can be split for a while: the older version keeps writing into `<projectRoot>/issues/N/`, while an upgraded machine reads its own copy under `~/.issue-flow`. Nothing is lost or corrupted: the legacy tree stays intact and readable for the older version, and an issue the older version *creates* is pulled in by the per-issue check the first time an upgraded machine resolves it. What does not cross over is an *update* to an issue that has already been migrated -- once a global copy exists it wins, and a newer `tasks.json` committed by the older version is not merged into it. Upgrading the whole team, or moving the demand to GitHub issues, is what closes the gap.

## Development

```bash
cd packages/issue-flow

# Install dependencies
npm install

# Build
npm run build

# Type check
npm run typecheck

# Run tests
npm test

# End-to-end smoke tests for the issue providers (GitHub-only, local-only, both)
npm run smoke

# Watch mode
npm run dev
```

`npm run smoke` builds the CLI and drives it inside throwaway git repositories against deterministic stand-ins for `claude` and `gh` -- no network, no tokens. Pass `--keep` to inspect the generated workspaces.

For the full development setup and local testing guide, see [CONTRIBUTING.md](packages/issue-flow/CONTRIBUTING.md).

### Releases

Releases are published manually to npm by a maintainer. The official procedure —
changelog, version bump, tag, `npm publish`, and GitHub Release — is documented in
[CONTRIBUTING.md → Release process](packages/issue-flow/CONTRIBUTING.md#release-process).
Version history is in [CHANGELOG.md](CHANGELOG.md).

## Skills & Agents (Traditional Usage)

Issue Flow also ships as a set of **Claude Code skills** and a **sub-agent orchestrator** (`resolve-issue`) for interactive use. Skills can be installed in Claude Code or any tool that supports [Agent Skills](https://agentskills.io), and the sub-agent provides the full orchestrated pipeline with execution modes, auto-correction loop, and pipeline resumption.

```bash
# Install all skills via skills.sh
npx skills add fabioassuncao/issue-flow

# Install a specific skill
npx skills add fabioassuncao/issue-flow --skill generate-issue
```

For full documentation on skills, the sub-agent, installation via `npx skills add`, and headless/CI usage, see **[Skills & Sub-Agent Architecture](docs/skills-and-agents.md)**.

## License

[MIT](LICENSE)
