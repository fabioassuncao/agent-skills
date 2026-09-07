# Storage and artifacts

[CLI guide](cli.md) · [Project overview](../README.md)

Issue Flow uses one artifact resolver for the CLI and the portable Agent Skills.
By default it stores operational artifacts outside the repository, under
`~/.issue-flow`. If `<workspace>/.issue-flow/issues/` already exists, that
directory explicitly selects workspace-local storage for both interfaces. An
ordinary run never creates this opt-in directory and never copies state between
the two stores.

Artifacts such as PRDs, task plans, progress and reviews are operational state
and must not be committed. Global storage is already outside Git. Workspace
storage maintains a scoped `.issue-flow/.gitignore` that ignores `issues/`,
queues, SQLite files, locks, provider/project metadata and backups while leaving
other `.issue-flow` content, such as prompt overrides, eligible for versioning.
The CLI alone owns sessions, locks, telemetry and orchestration; `tasks.json`
and the readable documents form the portable continuation boundary.

- [Directory tree](#directory-tree)
- [SQLite database](#sqlite-database)
- [One issue directory](#one-issue-directory)
- [Project id](#project-id)
- [`ISSUE_FLOW_HOME`](#issue_flow_home)
- [`tasks.json`](#tasksjson) — the task plan and the pipeline state
- [`session.json`](#sessionjson) — the live snapshot
- [Global diagnostic logs](#global-diagnostic-logs)
- [Tokens and cost](#tokens-and-cost)
- [Execution telemetry](#execution-telemetry)
- [Migrating from `issues/`](#migrating-from-issues)

## Directory tree

```
~/.issue-flow/
  config.json                    # Machine-wide preferences (optional)
  issue-flow.db                  # Structured-state SQLite database
  backups/
    issue-flow-<timestamp>.db    # Consistent snapshots made by `db backup`
  logs/
    issue-flow-2026-08-30.jsonl  # Structured, machine-wide diagnostics
  web.lock                       # PID + port of the active web monitor, if any
  web.restart.lock               # Short-lived serialization of an explicit restart
  projects/
    issue-flow-4b21c0e9f7a3/     # One directory per project: <slug>-<hash12>
      metadata.json              # Project identity and timestamps
      providers.json             # Legacy JSON fallback for SQLite agent health
      run.lock                   # Ownership of the run in progress
      issues/
        42/                      # One per issue identifier — see below
      queues/
        50/                      # One per multi-issue queue
          execution-plan.json    # Order, per-issue status, shared branch, PR
```

`queues/` only exists once a run really coordinates more than one issue.

The workspace-local variant has the same project-level shape without the
`projects/<project-id>/` segment:

```text
<workspace>/.issue-flow/
  .gitignore
  issue-flow.db
  metadata.json
  providers.json
  run.lock
  issues/<id>/
  queues/<id>/
  backups/
```

Existence of `<workspace>/.issue-flow/issues/` is the complete opt-in signal.
Removing or adding it changes the selected store on the next process; Issue Flow
does not merge, copy or choose per artifact. The same store remains active for
the whole process.

## SQLite database

`issue-flow.db` is the versioned relational foundation for structured state.
It is opened only through the storage database driver, with foreign keys,
five-second busy timeout and WAL enabled. On a detected network filesystem the
driver warns and uses the safer rollback journal (`DELETE`) mode instead.

Schema migrations are forward-only and transactional. Each applied version is
recorded in `schema_migrations` and mirrored in SQLite's `user_version`; a
database created by a newer Issue Flow fails before any write, rather than being
downgraded or modified. The `db check`, `db backup`, `db vacuum`, `db export`,
`db verify` and `db import` commands are documented in
[the command reference](commands.md#database-maintenance).

### `agent_events`

What an agent's own [lifecycle hooks](agents.md#lifecycle-hooks) reported: one
row per event, with `run_id`, `phase`, `type`, `lifecycle`, the raw payload and
when it happened.

It is written down rather than kept in memory for one reason: the most useful
event is `awaiting_input`, and the case worth being able to look up is precisely
the one where nothing was watching when it happened.

`run_id` carries **no foreign key**. The event arrives from a hook running in
the agent's own process, and the ordinary race — a hook firing before the run's
first snapshot has been committed — must not lose it. The outside world is the
authority on what exists; this table records what was reported.

### `worktrees`

What each managed worktree is bound to: branch, path, base branch, agent,
profile, runtime, the environment values it exports and the ports it owns.
`active_agent_session_id` identifies the tab currently occupying the visible
agent slot; `tab_sequence_counter` is monotonic, so deleting Fork 2 never makes
another conversation reuse that label.

git is the authority on whether a worktree **exists**; this table is the
authority on what it is **bound to**. A row whose directory git no longer lists
is reported as `orphaned` and left alone — never recreated because a row says it
should be there, never deleted because a directory is missing.

Keyed by `(project_id, branch)`: a worktree is the branch it carries, and moving
the directory does not make it a different one. `runtime.env` stays a file under
the worktree's own git directory, because `bash` and the lifecycle hooks read it
and neither can query a database.

### `agent_sessions`

The durable link between a model conversation and what it is being used for:
`run_id`, `phase`, `story_id`, `branch`, `worktree_id`, `provider`,
`conversation_id`, `status`, `pane_target`, `pane_token`,
`parent_session_id`, `tab_sequence` and `label`.

**`run_id`, `phase` and `story_id` are nullable, and that is the whole design.**
A session opened by a person — no issue, no plan, no workflow — is the *same*
row with those three columns empty. There is no second table and no second
execution model; a consumer that assumed they were present would break the one
mode that has nothing to put in them.

`label` is a caption, never an identity: nothing is looked up by it. It exists
because a free session has only a uuid and a generated branch to show a person,
while a workflow session is already named by its issue.

The conversation itself is never copied here and never parsed. The provider owns
it, on disk under `~/.claude` or `~/.codex`; this table holds its id so
`--resume` has something to point at. `status` is *reported* — by the agent's
hooks, or demoted to `orphaned` by reconciliation when tmux no longer has the
window. Nothing here deletes a row because a pane is gone.

An agent tab is another row in this table, not a row in a `tabs` table. The root
has `parent_session_id = NULL` and `tab_sequence = 0`; forks point to the root
and carry their monotonic sequence. The `tabId` exposed by HTTP and CLI is the
row's `id`, while `conversation_id` remains the provider's separate identity.
All tab materialization is scoped by the exact `worktree_id`, so reusing a
branch cannot adopt sessions from an older checkout incarnation.

`pane_target` is tmux's stable `%N` id, but it is never authority by itself:
`pane_token` is a durable random nonce mirrored in the pane's
`@issue-flow-owner` tag alongside the owning project session. Movement,
selection, teardown, reconciliation and websocket attach require that tuple to
match the expected main/parking window. This protects against pane-id reuse and
grouped viewer aliases.

Migration 22 adds these tab columns plus the worktree active pointer/counter.
It backfills a pre-v22 session only when its worktree incarnation is
unambiguous; ambiguous branch histories remain nullable instead of being
guessed. Creating a fork persists its session row and the active/counter
worktree fields in one transaction. Whole-worktree teardown likewise changes
every live sibling of the exact `worktree_id` to `stopped` atomically.

### `projects` — the project registry

The row that anchors every foreign key is also the **project registry**: the one
list the CLI, the server, the dashboard and the runtime read.

| Column | Meaning |
|---|---|
| `id` | The [project id](#project-id). The identity, stable across moving the checkout and identical in two clones |
| `root` | Where the repository currently is. A **locator**, updated when it moves — never the identity |
| `name` | Dashboard label. Cosmetic |
| `added_at` | When the project first entered the registry. Set once, never rewritten |
| `last_seen_at` | Last time it was opened or executed. Orders every list |
| `source` | `registered` · `discovered` · `ephemeral` |

`source` is what keeps direct mode intact:

| Situation | `source` | In the dashboard | Persisted |
|---|---|---|---|
| `issue-flow run` in a repository nobody registered | `discovered` | yes, ordered by recency | yes — the row already existed |
| `issue-flow project add` or the dashboard button | `registered` | yes, in the curated list | yes |
| `issue-flow serve` standing inside an unregistered repository | `ephemeral` | yes, for this server only | **no** |
| `issue-flow project rm` | back to `discovered` | recent | history preserved |

Promotion and demotion **never destroy history**: they change one column. Runs,
artifacts and telemetry hang off `id`, so `project rm` removes the project from
the curated list and nothing else. Deleting for real belongs to a separate,
explicitly destructive command.

`ephemeral` is never written. With a registry shared by every server on the
machine, persisting the directory a server happens to sit in would make *other*
servers start serving that repository after their next restart.

There is no `projects.json`. A second state file next to the database would need
its own consistency story for the same facts.

The URL prefix a project is served under (`/web`, `/web-2`) is **derived**, never
stored: it comes from the directory basename, with `-2`, `-3`… on collision and a
reserved list (`api`, `ws`, `assets`, `health`) so a project can never shadow a
hub route. Storing it would create a second identity competing with `id`.

## One issue directory

Everything a single issue accumulates. Nothing here is created before something
needs to write it, so a given run leaves most of these absent:

```
~/.issue-flow/projects/<project-id>/issues/42/
  issue.md          # Issue statement (local issues only)
  metadata.json     # Issue metadata (local issues only)
  analysis.md       # Issue analysis (standalone `analyze` only)
  prd.md            # Product requirements
  tasks.json        # Agent-facing projection of plan, pipeline state and stories
  progress.txt      # Execution log
  session.json      # Compatibility projection of the live session
  events.jsonl      # Compatibility projection of the ordered event history (opt-in)
  events.1.jsonl    # Optional previous generation when rotation is explicitly configured
  verify.json       # Readable projection of redacted SQLite verification evidence
  decomposition.md  # "This issue looks larger than one run" report
  run.log           # stdout/stderr of a `--background` run
  run.log.1         # Previous generation, after a rotation
  .last-branch      # Legacy fallback; branch history is stored in SQLite
  archive/          # Artifacts superseded by a later iteration
  pr-review/        # PR review reports and index
```

`issue.md` and `metadata.json` only exist for issues created or mirrored
locally; a GitHub-only run never writes them.

Issue identifiers are not necessarily numeric — `auth-refactor` and `pr-184` are
valid directory names. Every path above is resolved by a single function
(`getIssuePaths`), so no command can invent a layout of its own; a test fails the
build if any file outside `src/storage/` builds an issue path by hand.

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

`root` is the last known local checkout and is informative only — identity lives
in `projectId`. `remoteUrl` is `null` for a project with no `origin` remote.
`userStoryNumbering` records the most recent [`plan` numbering
decision](commands.md#plan--user-story-numbering) for audit only; it is never
read back to decide a later one. Unknown keys are ignored on read, so a file
written by a newer release stays readable by an older one.

## Project id

Each project gets a deterministic id of the form `<slug>-<hash12>`:

| Part | Derivation |
|------|-----------|
| `slug` | Repository name, lowercased and reduced to `[a-z0-9-]`, runs of separators collapsed, truncated to 32 characters (`project` when nothing survives). Cosmetic only |
| `hash12` | First 12 hex characters of the SHA-256 of the seed. This carries the identity |

The seed is canonical rather than local:

| Condition | Seed | Slug from |
|-----------|------|-----------|
| `git remote get-url origin` resolves | `remote:<host>/<org>/<repo>` | Last segment of the remote path |
| No `origin` remote | `path:<absolute project root>` | `basename` of the project root |

The remote is normalized before hashing — protocol, embedded credentials, SSH
user, port, `.git` suffix and trailing slashes are stripped, and host plus path
are lowercased. So `https://github.com/org/repo.git`,
`git@github.com:org/repo.git` and `ssh://git@github.com:22/org/repo` all seed to
`github.com/org/repo` and produce the **same id on every machine**: two clones of
the same repository share their history, and moving or renaming the local folder
is harmless. (One consequence of lowercasing the path: on a case-sensitive
self-hosted server, `org/Repo` and `org/repo` collapse to the same id.)

The `remote:` / `path:` prefix is part of the hashed seed, so a project
identified by path can never collide with one identified by remote.

> **Known limitation of the path fallback.** For a repository with no `origin`
> remote, the absolute path *is* the identity. Moving or renaming that folder
> yields a different id, and the previous history is left behind under the old
> one — nothing is deleted, but the new directory starts empty. Configuring a
> remote before adopting the global storage avoids this entirely.

## `ISSUE_FLOW_HOME`

```bash
ISSUE_FLOW_HOME=/tmp/issue-flow-ci npx issue-flow run 42
```

`ISSUE_FLOW_HOME` relocates the default global root. A relative value is resolved
against the current working directory. Use it to isolate CI runs, sandboxes and
test suites from the real `$HOME` — Issue Flow's own tests point it at a
temporary directory for exactly this reason. Unset, the root is
`~/.issue-flow`. An existing workspace `.issue-flow/issues/` remains the more
specific explicit store selection and therefore does not move with this value.

## `~/.issue-flow/web.lock`

Marks the single web monitoring server active on this machine. `pid` is the
**detached `issue-flow web serve` process**, not the `run`/`execute` invocation
that triggered it:

```json
{
  "pid": 41213,
  "port": 3737,
  "host": "127.0.0.1",
  "startedAt": "2026-08-04T02:00:00Z",
  "instanceId": "a3f66c15-9c4a-4acf-895e-c965f92127dc"
}
```

`instanceId` is additive: locks written before it existed remain readable.
`web.restart.lock` exists only while `--restart-web` or `web stop` owns the
maintenance window. A dead owner is treated as stale and the file is removed.

See [Web monitoring → single instance](web-monitor.md#single-instance-detached-from-the-pipeline).

## `tasks.json`

The task plan produced by `plan`, and the state every later phase reads and
writes.

### Pipeline state

```json
{
  "pipeline": {
    "prdCompleted": true,
    "jsonCompleted": true,
    "executionCompleted": false,
    "reviewCompleted": false,
    "prCreated": false,
    "prReviewCompleted": false
  }
}
```

`analyzeCompleted` is also accepted, for the standalone `analyze` command.

The top-level `lastReviewFindings` (`string | null`) holds actionable findings
from failed review or acceptance, with check output framed as diagnostic data.
Non-null overrides the "issue already
complete" check even when every story has `passes: true`, so a correction cycle's
re-execute step is guaranteed to run instead of exiting immediately.

The execute agent may update existing stories' `passes` and `notes`, acknowledge
resolved findings by clearing them, and record or clear `lastError`. SQLite
reingestion changes only those fields. Clearing findings and changing a blocker
compare against the pre-invocation state, so an agent cannot erase newer feedback.
Pipeline flags, telemetry, correction counters and closure authorization remain
CLI-owned. A newly recorded blocker prevents completion even if the agent emits
the completion marker. Resume retains the consumed correction-cycle budget.

### User stories

```json
{
  "userStories": [
    {
      "id": "US-002",
      "title": "…",
      "description": "…",
      "acceptanceCriteria": ["…"],
      "priority": 2,
      "passes": false,
      "notes": "",
      "status": "in_review",
      "dependencies": ["US-001"],
      "stage": "in_correction",
      "stageSince": "2026-08-03T16:12:04Z",
      "stageDetail": "Cycle 1/3"
    }
  ]
}
```

| Field | Values | Meaning |
|-------|--------|---------|
| `status` | `backlog` \| `in_progress` \| `in_review` \| `done` | Board-style status, purely **observational** |
| `dependencies` | `string[]` | Ids of other stories in the same plan |
| `stage`, `stageSince`, `stageDetail` | see [Story `stage`](#story-stage) | Execution-stage hint, purely **observational** |

All are **optional**, and absent means *not informed* — a plan written without
them keeps loading unchanged, and a round-trip never materialises them.

`passes` remains the source of truth for execution: no phase reads `status` (or
`stage`) to decide what to run next, and `status: "done"` on a story with
`passes: false` does not make the execute loop skip it. What `status` does is
seed the [snapshot's derived status](#story-status) — the only way to get
`in_review` onto the board.

`dependencies` declares prerequisites in the same task plan. Planning and execution
reject missing IDs, self-references, duplicate story IDs and cycles. Execution
selects the lowest numeric priority among unpassed stories whose dependencies
have all passed; ties retain document order. Omitted dependencies means none.
Existing valid plans require no migration. Previously invalid graphs must be
corrected before execution; the inspector reports violations without editing them.

`stage` mirrors the snapshot field of the same name, but nothing writes it back
onto `tasks.json` today and a `stage` declared in a plan is **not** carried into
the snapshot. It exists so a plan that carries it still parses — not as an input
knob.

### Per-story metrics

The execute loop writes what each story cost back into `tasks.json`, so the data
outlives the session and does not depend on web monitoring:

```json
{
  "id": "US-001",
  "passes": true,
  "inputTokens": 203,
  "outputTokens": 10780,
  "cacheReadTokens": 321000,
  "cacheCreationTokens": 24100,
  "costUsd": 0.8547,
  "durationSeconds": 188
}
```

All six are optional and only appear once the story has completed at least one
iteration. Values accumulate across iterations. A `tasks.json` written before
this feature keeps loading — missing fields stay missing rather than being
filled with zeros, which is what keeps "not reported" distinguishable from "cost
nothing". See [the limitations](#tokens-and-cost).

### Pull Request and review state

```json
{
  "pullRequest": {
    "number": 184,
    "url": "https://github.com/owner/repo/pull/184",
    "headBranch": "feat/42-dark-mode",
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
| `pullRequest` | `pr` | The created PR, so later phases do not query GitHub again |
| `prReview.enabled` | `run --pr-review` | Persisted opt-in; the standalone command never turns it on |
| `prReview.rounds` | `pr-review` | Rounds recorded under the issue's `pr-review/` directory |
| `prReview.lastRecommendation` | `pr-review` | `APPROVE` \| `APPROVE_WITH_SUGGESTIONS` \| `REQUEST_CHANGES` |

All three are **absent** until the corresponding phase runs.

## `session.json`

When web monitoring is enabled — or when a run is detached with `--background` —
the snapshot is also persisted here (atomic writes, throttled to ~1s, final state
flushed at the end of the run). It is a compatibility projection, rewritten from
scratch on every run. The detached monitor reads the canonical SQLite `runs`,
`snapshots` and `events` rows instead; those rows retain event order and a 10s
database heartbeat without traversing project files.

`schemaVersion` stays `1`: every field is additive, and a `session.json` written
by an earlier version still parses — absent sections are filled with their
neutral defaults (`null`, `[]`) rather than rejected.

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
  "progress": { "percent": 45, "phasesCompleted": 3, "phasesTotal": 5, "storiesCompleted": 4, "storiesTotal": 10 },
  "currentPhase": "execute",
  "currentActivity": { "story": "US-005", "tool": "Bash", "detail": "npm test", "since": "…" },
  "phases": [
    {
      "name": "execute", "status": "completed", "durationSeconds": 754, "error": null,
      "harnessExecutionMs": 541000, "orchestrationOverheadMs": 9000,
      "harnessStartupMs": 3600, "ttftMs": 2100, "attemptCount": 1, "retryDurationMs": null,
      "inputTokens": 812, "outputTokens": 43120, "cacheReadTokens": 1284000,
      "cacheCreationTokens": 96400, "costUsd": 3.4187
    }
  ],
  "stories": [
    {
      "id": "US-001", "title": "…", "priority": 1, "passes": true, "completedAt": "…",
      "status": "done", "dependencies": [],
      "stage": "in_review", "stageSince": "2026-08-03T16:12:04Z", "stageDetail": null,
      "history": [{ "at": "…", "stage": "executing", "detail": "Iteration 1" }],
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
  "resilience": {
    "attempt": 2, "provider": "codex", "model": "gpt-5.6",
    "lastFailureKind": "provider_down",
    "cooldownUntil": "2026-08-03T16:14:00Z",
    "lastActivityAt": "2026-08-03T16:13:08Z"
  },
  "verification": { "verdict": "passed", "level": "L1", "independence": "harness-only" },
  "git": {
    "branch": "feat/42-dark-mode", "baseBranch": "main",
    "branchCreated": true, "startCommit": "9ab3210",
    "commits": [{ "hash": "abc1234", "subject": "feat: …", "committedAt": "…", "storyId": "US-001" }]
  },
  "repository": {
    "name": "owner/repo",
    "remoteUrl": "git@github.com:owner/repo.git",
    "branch": "feat/42-dark-mode",
    "headCommit": "abc1234",
    "root": "/Users/me/code/repo"
  },
  "pullRequests": [{ "number": 43, "url": "…", "title": "…" }],
  "logs": [{ "at": "…", "level": "info", "message": "…" }],
  "processLogs": [{ "at": "…", "phase": "execute", "executionId": "…", "provider": "codex", "stream": "combined", "message": "…" }],
  "executions": [{ "id": "…", "purpose": "execute", "attempt": 1, "status": "completed" }],
  "configuration": {
    "precedence": ["default", "global", "project", "env", "cli", "step override"],
    "defaultProvider": { "value": "codex", "source": "project" },
    "defaultModel": { "value": "gpt-5.6", "source": "global" },
    "phases": [], "fallbacks": ["codex", "claude"], "overrides": []
  },
  "errors": [], "warnings": [], "lastError": null,
  "nextSteps": ["review", "pr"],
  "environment": {
    "node": "v22.0.0", "platform": "darwin", "agent": "claude", "model": null,
    "cliVersion": "0.16.0"
  }
}
```

`environment.cliVersion` is the version of the `issue-flow` package that produced
the run — additive like `agent` and `model`, so a snapshot written before it
existed parses as `null`. It is what the terminal headline and the dashboard
name, and it is **not** necessarily the version of the monitor serving that
dashboard; see [Web monitoring → version on screen](web-monitor.md#which-version-is-on-screen).

### `issue` and `repository`

Both sections are published in the same window as `session:start`, so the
**first** poll of `/api/status` already carries them — there is no disk or `git`
I/O per HTTP request.

| Field | Notes |
|-------|-------|
| `issue.url` | The remote reference; `null` for a local-only issue |
| `issue.description` | Published **in full, never truncated** — the consumer decides how to fold it |
| `issue.state` | `open` / `closed` for the built-in providers; typed as `string \| null` so other providers can report their own |
| `repository.name` | `owner/repo`; `null` without a remote |
| `repository.remoteUrl` | As configured, minus any embedded `http(s)` credentials |
| `repository.headCommit` | `null` in a repository with no commits yet |

There is no textual **priority** on the issue: the domain has no such attribute
and Issue Flow does not invent one. Consumers that want a priority derive it from
`labels`.

Every `repository` field is collected independently and failure-tolerant — no
remote, no commits yet or a missing `git` binary each show up as `null` instead
of failing the publication. Two known limitations: `repository.name` inherits the
lowercasing of the remote-URL normalizer (`Owner/Repo` is reported as
`owner/repo`), and `remoteUrl` has its `http(s)` userinfo (`user:token@host/...`,
the shape CI commonly uses to embed a PAT) stripped before publication. SSH
remotes are left untouched: both `ssh://user@host/path` and the scp-like
`user@host:path` shorthand need that user segment to connect at all.

### Story `status`

Each entry of `stories[]` carries a board-style `status`, **recomputed on every
reduction** in this order:

1. `passes === true` → `done`
2. the current status is `in_review` → stays `in_review`
3. `currentActivity.story` is this story's id → `in_progress`
4. otherwise → `backlog`

Two consequences are worth stating explicitly: **`in_review` is never derived
automatically** — it only ever enters through an explicit `status` in
`tasks.json`, and once set it sticks until `passes` flips to `true`; and
**`passes` still wins** — a story declaring `status: "done"` with `passes: false`
is reported as `backlog` or `in_progress`.

### Story `stage`

Where `status` is a four-value board summary, `stage` tracks the real pipeline
cycle a story goes through — `execute` → `review` → correction → done.
`stageSince` is the ISO timestamp of the event that produced it, and
`stageDetail` a short human string (currently only used by `in_correction`).

| `stage` | Set by | Meaning |
|---------|--------|---------|
| `pending` | `iteration:start` | Not the story `execute` is currently working on |
| `executing` | `iteration:start` | The eligible unpassed story selected by the CLI, after checking declared dependencies and priority |
| `awaiting_review` | `stories:update` | `passes` just flipped to `true`, but `review` has not started yet |
| `in_review` | `phase:start` (review) | The `review` phase is running. Every already-passing story moves here at once |
| `in_correction` | `correction:cycle` | An automatic correction cycle is in progress; `stageDetail` carries `"Cycle 1/3"`. Pipeline-wide, like `in_review` |
| `done` | `phase:end` (review, success) | The `review` phase finished successfully |
| `failed` | `phase:end` (failure) or `session:end` (run not completed) | The run stopped before the story finished |

`done` and `failed` are the only terminal stages, and a run that ends always
lands every story on one of them — without that, a failed run would leave the
panel showing a story as executing indefinitely.

Unlike `status`, `stage` is **not** recomputed from scratch: it is set directly
by the event that causes the transition, so `in_correction` survives an unrelated
`stories:update` in between.

## Tokens and cost

Every phase reports what it spent, and the same numbers appear in three places:
the `Tokens:` line of the terminal summary, the web panel (per phase, per story
and the issue total), and `session.json`.

| Field | Where | Meaning |
|-------|-------|---------|
| `inputTokens` | `phases[]`, `stories[]` | Non-cached prompt tokens |
| `outputTokens` | `phases[]`, `stories[]` | Tokens generated by the model |
| `cacheReadTokens` | `phases[]`, `stories[]` | Prompt tokens served from the prompt cache |
| `cacheCreationTokens` | `phases[]`, `stories[]` | Prompt tokens written into the cache |
| `costUsd` | `phases[]`, `stories[]` | Cost in USD, as reported by the CLI |
| `durationSeconds` | `stories[]` | Wall-clock seconds attributed to the story |
| `harnessExecutionMs` | `phases[]` | Sum of invocation walls for the phase |
| `orchestrationOverheadMs` | `phases[]` | Phase wall minus harness execution, when both are known |
| `harnessStartupMs` | `phases[]` | Wall clock minus the CLI's reported `duration_ms` |
| `ttftMs` | `phases[]` | Time to first output, when the harness reports it |
| `attemptCount` / `retryDurationMs` | `phases[]` | How many invocations, and how long the retries took |
| `metrics.total*` | root | The same five measures summed over the whole issue |

All are `number | null`, and `null` means **not reported** — never zero.

**Reading the numbers.** `inputTokens` alone badly understates what a run
consumed: Issue Flow sends a large, mostly stable prompt on every invocation, so
the bulk of the context is billed as cache reads (cheap) or cache writes, and
only the small varying tail lands in `inputTokens`. It is normal for
`cacheReadTokens` to be two or three orders of magnitude larger. Use `costUsd`
for "what did this cost", and the token fields to understand *why*.

On a homogeneous run the terminal `Tokens:` line is a single line. On a mixed run
the summary prints **one line per agent**: Codex and Antigravity report tokens
but not USD, and Cursor reports neither, so a mixed-run total showing only
Claude's dollars would be silently wrong.

Two limitations are worth knowing:

- **Per-story attribution is an approximation.** The CLI reports usage per
  invocation, not per story, and one iteration can flip more than one story to
  `passes: true`. When it does, that iteration's tokens, cost and duration are
  split **evenly** among the stories that completed in it. When an iteration
  completes no story, nothing is attributed to any story. Phase totals and
  `metrics.total*` come from the iteration itself, never from summing
  `stories[]` — and because each share is rounded independently, summing
  `stories[]` for one iteration can differ by a few tokens from that iteration's
  real total.
- **USD cost only appears when the CLI provides it.** `costUsd` is passed through
  from the harness's own accounting. Issue Flow never estimates a price from
  token counts unless `telemetry.pricing.estimate` is `true`, and an estimate is
  never labelled as a charge.

## Execution telemetry

Story metrics answer "what did this story cost". They do not say **who** produced
the number, on which attempt, or whether a failed try spent tokens too.
SQLite's `executions` table is the canonical record (and `tasks.json.executions`
is a compatibility projection) with one row per agent invocation:

```json
{
  "executions": [
    {
      "id": "…",
      "purpose": "prd",
      "attempt": 1,
      "trigger": "initial",
      "agent": {
        "harness": "claude-code",
        "provider": "anthropic",
        "model": { "requested": null, "resolved": null, "source": "unavailable" }
      },
      "status": "failed",
      "durationMs": 5580,
      "cliDurationMs": 1948,
      "harnessStartupMs": 3632,
      "ttftMs": 400,
      "numTurns": 1,
      "usage": { "inputTokens": 412, "source": "provider" },
      "cost": { "status": "reported", "amount": 0.31, "currency": "USD" }
    }
  ]
}
```

- A task is not a single execution. Retries and failovers stay in the file.
- `{ "status": "reported", "amount": 0 }` is a real zero. `{ "status": "unknown" }`
  is not.
- `usage: null` means the provider reported nothing — never artificial zeros.
- Time fields (`cliDurationMs`, `harnessStartupMs`, `ttftMs`, `numTurns`) are
  optional. Absent means the envelope did not report them.
- `trigger` is `initial`, `retry`, `fallback`, `correction` or `escalation`.
- Estimation is opt-in (`telemetry.pricing.estimate`). An estimate stores the
  rates it used and is never added to reported cost.
- Git artefacts (branch, commit, PR, changelog) never read this field: provider
  and model do not leak into them.
- A plan written before this field keeps loading; a round-trip does not
  materialize `executions: []`.

Read it with `issue-flow usage [--issue N] [--by harness]`. Disable writes with
`telemetry.enabled: false` or `ISSUE_FLOW_TELEMETRY=0`. SQLite history is not
silently truncated by `telemetry.maxExecutions`; retain or archive it through an
explicit database-maintenance policy instead.

The same invocation rows are projected into `session.json.executions` while a
session is live. `processLogs` is a bounded, redacted tail of harness output for
the drawer; it is not the durable diagnostic source.

## Global diagnostic logs

Every run also writes structured JSON Lines to
`~/.issue-flow/logs/issue-flow-YYYY-MM-DD.jsonl`, independently of the project
and of whether the web monitor is enabled. Records carry the available
correlation fields (`project`, `projectRoot`, `sessionId`, `executionId`, issue,
phase, story, harness and model), plus level, timestamp, message, context and an
exception stack when one exists.

The writer is best-effort and serialized: a logging failure cannot break the
pipeline. Files rotate at 10 MiB, keep five generations per day, and files older
than 30 days are removed. Authentication-like keys and values are redacted
recursively before persistence. These files are the machine-wide source for
post-mortem debugging; the dashboard only queries the correlated subset through
`GET /api/diagnostics?session=<id>`.

The synthetic baseline used to measure orchestration overhead is
`packages/issue-flow/src/benchmark/`; the published *before* table is
[`research/2026-08-30-harness-baseline.md`](research/2026-08-30-harness-baseline.md).

## Migrating from `issues/`

Earlier releases wrote all of the above to `<projectRoot>/issues/N/`. That
directory is now **legacy and read-only**.

Migration is **automatic**: the first command that resolves a path for a project
copies an existing `<projectRoot>/issues/` tree into the global storage before
reading anything. There is no command to run and no flag to pass.

That same first resolution imports the global project's structured JSON state
into SQLite. The importer records a SHA-256 hash for every source artifact, so
restarts resume without duplicating rows; it imports the project, plans and
stories, telemetry, queues, provider health, verification evidence and
pull-request references in one project transaction. Legacy journals are
potentially large and are imported only by an explicit
`issue-flow db import --with-events`. Live `session.json`
snapshots are intentionally discarded because they are transient projections.
JSON, JSONL,
Markdown, locks and logs remain the diagnostic/source artifacts during this
transition — none is renamed, rewritten or removed.

Before a schema upgrade of any existing database, Issue Flow takes a consistent
snapshot under `backups/` (five generations by default, configurable with
`storage.backupRetention`). Set `storage.driver` to `json` to keep the
compatibility driver active deliberately. If an import fails,
the database is preserved as `issue-flow.db.failed-<timestamp>` and the command
continues with the JSON storage. A failed `integrity_check` is similarly
isolated as `issue-flow.db.corrupt-<timestamp>` before rebuilding from the
preserved artifacts.

Execution, event and snapshot history is retained indefinitely by default.
Any cleanup must be declared explicitly through `storage.retention`; journal
rotation is likewise opt-in, so no historical event is silently discarded.
Positive execution, event and snapshot limits are applied in the same
transaction as the relevant write (and during import); `0` means unlimited.
Backup retention is applied whenever storage resolves an existing database;
`storage.retention.backups` takes precedence over `storage.backupRetention`.

It is **non-destructive by construction**: `<projectRoot>/issues/` is never
modified, renamed or removed — there is no removal option, not even opt-in.
Migration is a copy that refuses to overwrite, which also makes it idempotent and
resumable after a partial failure. Subdirectories (`archive/`, `pr-review/`) and
dotfiles (`.last-branch`) come across intact.

When files are actually copied, the CLI prints the source directory, the
destination and how many files moved, plus a reminder that the legacy directory
was left untouched. A run that copies nothing prints nothing.

Workspace storage, when explicitly selected by an existing
`.issue-flow/issues/`, wins as a whole and disables this legacy migration. In
global mode, an existing global destination wins. The legacy check also runs
**per issue**, not only per project: an issue that appears under
`<projectRoot>/issues/` after the project was migrated is picked up the first
time it is resolved.

The legacy `<projectRoot>/issues/` directory is never an active Skill store.
Both surfaces resolve the same new location. A Skill that updates a valid
`tasks.json` runs the bundled `reconcile` helper; the next CLI process also
detects the changed projection by SHA-256 and imports it into SQLite. CLI writes
materialize the same readable projection for a later Skill. Process sessions,
locks and telemetry remain CLI-only and are not transferred.

Two consequences are worth knowing:

- **Issue artifacts are no longer shareable through git.** If your project used to
  commit `issues/` to review `prd.md` or `tasks.json`, those files now live under
  `~/.issue-flow` on the machine that ran the pipeline. The committed copies stay
  valid as a historical record, but stop being updated.
- **Collaborators on different versions.** In a repository where `issues/` is
  committed and part of the team is still on an older release, state can be split
  for a while. Nothing is lost or corrupted: the legacy tree stays intact and
  readable for the older version, and an issue the older version *creates* is
  pulled in by the per-issue check. What does not cross over is an *update* to an
  issue that has already been migrated — once a global copy exists it wins.
  Upgrading the whole team, or moving the demand to GitHub issues, closes the
  gap.

## Completion and closure authorization

Execution completion sets `pipeline.executionCompleted`. During `run`, it leaves
`issueStatus: in_progress` and `completedAt: null` until the requested delivery
phases finish. Standalone `execute` retains its independent completion behavior.
A malformed issue-review result is a `review_protocol` error, never implicit PASS;
previous findings remain available and no correction agent is launched for a
protocol defect.

`closeIssue?: boolean` is a CLI-owned execution choice. Absence means false for
legacy plans. `issueClosedAt?: string` records confirmed provider closure.
SQLite migration 8 adds nullable columns; JSON compatibility retains optional
fields. Generated agent plans cannot grant/revoke authorization or fabricate
confirmation. `--no-close-issue` revokes future closure; it does not reopen an
already closed issue.

Queue authorization belongs to `execution-plan.json`: `closeIssue`,
`closedIssueIds` and `prReviewCompleted`. A queue closes completed members only
after consolidated delivery and the requested review succeed. Confirmation is
persisted per member, so a retry reads provider state and skips confirmed closes.
A closure failure exits 1 and remains resumable. `resume <queue-or-member>` resumes
queue-owned work together; `resume --all` also considers pending queue delivery.
These fields do not turn a Skill invocation into a resumable CLI process. The
portable artifact state can continue across interfaces; process ownership and
runtime telemetry cannot.
