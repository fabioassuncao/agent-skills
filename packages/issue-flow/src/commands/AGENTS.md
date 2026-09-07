# src/commands

`usage` is a reader, like `status` / `runs` / `logs`: it only aggregates
`tasks.json.executions`. It never writes an `executionSummary`.

`bench` measures the #79 corpus. `synthetic` is free and what CI runs.
`real` spends money, requires confirmation or `--yes`, isolates
`ISSUE_FLOW_HOME`, and is refused under `npm test`. Rules live in
`src/benchmark/AGENTS.md`.

`run` always installs a `MemoryPublisher`. Disk surfaces (`FilePublisher`,
`JournalPublisher`) stay opt-in. `activity` events are published in every
mode so the clean terminal and the dashboard share `currentActivity`;
`FilePublisher` already throttles the write that would otherwise bust the
`/api/status` ETag on every tool call.

## `project` and `serve`

`project ls|add|rm|use` reads and writes the project registry in SQLite
**directly**. That is a hard requirement, not an optimization: the CLI may
never need a server to be running. A live monitor is notified afterwards, best
effort, only so it starts serving a new project without a restart — a monitor
that cannot be reached is not an error, because the registry write already
happened and it is the authority.

`project rm` is demotion, not deletion. Say so in the output: the word "remove"
invites the other reading, and runs, artifacts and telemetry all survive it.

`serve` is the canonical name of the machine-wide monitor; `web serve` is an
alias delegating to the same body (`web/AGENTS.md`: a third way to bind is what
that module exists to prevent).

Its serialized 60-second maintenance cadence is headless: per served project,
Linear pickup (when enabled and credentialed) and GitHub merged-worktree GC
(when enabled) run independently. A Linear failure must not suppress GitHub GC;
shutdown aborts an in-flight pass and waits for it before closing storage.

The bare root command is onboarding, not status: it always renders
`cli-help.ts`. `ps` is the only root-level run inventory. Keep the preformatted
help's command list and public environment list exact; internal context
variables never belong there.

`worktree ls|archive|unarchive|label|remove|merge|prune` works directly, without
a server, but never implements lifecycle policy here. Every mutation delegates
to `agents/session/worktree-control.ts`. Destructive commands require
confirmation/`--yes`; prune is dry-run by default and rechecks candidates under
the shared cross-process lock.

## Layout of `run/` (#100)

`run.ts` is a thin façade: `RunPipelineOptions`, `runPipeline()`, and
re-exports. Behaviour lives under `src/commands/run/`:

| File | Responsibility |
|---|---|
| `types.ts` | `QueueFailureMode`, `QueueRunContext`, `IssueRunResult`, phase tables |
| `publish.ts` | Session snapshot publication helpers |
| `pull-request.ts` | Consolidated PR context, propagation, issue close |
| `oversized.ts` | Decomposition report / auto sub-issues |
| `multi-issue.ts` | Queue **execution**: `decideQueue`, `runQueue`, `finishQueue`, detach, adopt branch |
| `queue-failure.ts` | Per-issue failure handling inside a queue |
| `session.ts` | Lock, writable-repo gate, one-issue session lifecycle |
| `phase-options.ts` | Pure resolvers for `--no-branch`, `--pr-review`, `--start-us`, retry budget |
| `phase-bootstrap.ts` / `phase-prepare.ts` / `phases.ts` | Phase orchestration split |
| `phase-runners.ts` / `phase-config.ts` / `phase-start.ts` / `phase-finalize.ts` | Named helpers for runners, agent config, resume start, summary |
| `demand.ts` | Pure resolvers for what the invocation runs (issues vs `--prompt`) and for `--auto-close`/`--keep-open` |
| `auto-close.ts` | The end of an autonomous run: the agent's completion signals, and the optional close of the sessions it left open |

Direction is `run.ts → run/*` only. Modules under `run/` must not import
`run.ts`. `types.ts` imports none of its siblings.

**`multi-issue.ts` vs `src/execution/queue.ts`:** the execution package owns
the **plan** (discovery, confirm, order, `execution-plan.json`).
`run/multi-issue.ts` owns **running** that plan (per-issue sessions, shared
branch, consolidated PR). The name is intentional so the two are not
confused when both appear in an import list.

## Contract of a single-invocation phase

`review` runs the acceptance contract (`src/verify/`) **before** its
`runHeadless` call. A fatal red check is `task_execution` and skips the
LLM. `unverified` continues, labelled.

`analyze`, `generate`, `prd`, `plan`, `review`, `pr` and `pr-review` each own
one `runHeadless` call. Anything that has to be derived from that call belongs
to the command, not to the `instrumentedRunners` wrapper in
`run/phase-runners.ts`: the wrapper only sees `() => Promise<void>` and never
receives the `HeadlessResult`. Keeping it in the command also covers
standalone runs (`issue-flow prd 42`), which never go through the pipeline.

Concretely, a new phase command must:

- pass `outputFormat: 'json'` — `'text'` makes `runHeadless` return
  `cost: null` outside verbose mode, so no metric is ever captured. The
  envelope's `result` field carries the same assistant text, so every parser
  built on `result.result` keeps working;
- call `publishPhaseMetrics('<phase>', result.cost, startedAtMs, result.agent?.provider)`
  (from `core/session-metrics.js`) **before** the `result.success` check — the
  tokens were spent whether or not the phase succeeded. The helper is a no-op
  when the CLI reported nothing, and can never change an exit code. The fourth
  argument labels usage by the agent that actually ran (`AgentRunResult.agent`);
- publish once per invocation when it retries (inside the `attempt` callback of
  `runPhaseWithRetry`), letting the reducer sum the attempts.

`phase:start`/`phase:end` stay the only source of a phase's `durationSeconds`;
the duration carried by a metrics event is informational.

## Publication order in `run/`

`session:start` rebuilds the snapshot from `createInitialSnapshot()`, so
**everything that enriches the snapshot is published after
`publishSessionStart(...)`** and before the `init` phase events — that window is
what the monitor's first `/api/status` poll sees. The current order is
`session:start` → `issue:update` → story seed → `phase:start`/`phase:end`
(init) → `publishGitState`. A new enrichment belongs in the same window, not
before it.

The Issue data published there comes from the `ResolvedIssue` the run already
holds (`resolveCommandIssue` runs once, at the top), never from a fresh provider
call.

## What one failing issue does to a queue

`--on-issue-failure` picks between three answers, and `stop` — ending the run
where it failed — stays the default and the behaviour of every release before
the flag existed.

- **`skip` sets the issue aside and comes back to it.** `nextQueueIssue()` hands
  out `skipped` entries **last**, which is what "go on with the independent work
  and return at the end" means in one line. `attempts` is what keeps that from
  becoming "come back forever": past `resilience.queue.maxIssueAttempts` (2 by
  default) the entry becomes `failed`.
- **`block` is for a failure a person has to look at.** `nextQueueIssue()` never
  hands a `blocked` entry back out — waiting cannot fix a missing credential —
  so the queue finishes the rest and reports it.
- **`exhausted` is per invocation, and it has to be.** The resumption policy
  puts `failed` before `pending`, which is right *across* invocations (re-run
  and it picks up where it stopped) and wrong *inside* one, where it would hand
  the same spent issue back out on the very next lookup.
- **Dependencies are enforced at hand-out, not only in the order.**
  `computeExecutionOrder` already places blockers first; the check in
  `nextQueueIssue()` only bites once an entry stops being `completed`, which is
  exactly when handing out its dependents would produce work that cannot build.
- **A queue that ends with unfinished issues exits non-zero**, even though the
  independent work landed: the run did not do what it was asked.

## The repository is described, never repaired

`ensureRepositoryWritable()` runs `preflightRepository()` (in `utils/git.ts`)
before every phase that writes to the repository — `plan`, `execute`, `pr`. A
rebase, merge, cherry-pick or revert in progress, an unresolved conflict or a
detached HEAD **fails the phase with the command that gets out of it**, printed
for a human to run.

**Nothing in that path is destructive, and nothing may become so.** No
`reset --hard`, no `checkout -f`, no `--abort`, no implicit `stash` — not on a
resume, not under a continuous profile, not ever. `utils/shell.ts` enforces the
same rule one level down by refusing to retry a destructive `git` invocation;
this is the same limit stated at the pipeline level. "The tool aborted my rebase
overnight" is the outcome both exist to make impossible.

Two checks the preflight supports are deliberately **not** used here and belong
to `resume`: the dirty tree (the phases of one run follow each other by design,
and uncommitted work between them is the pipeline's own doing) and the branch
comparison (within a run, `plan` is what creates and checks the branch out, and
a queue adopts a shared one after its own plan ran). A resume has none of those
guarantees and passes both.

A test that mocks `execa` wholesale must answer the preflight's probes, or the
pipeline reads the silence as a detached HEAD and blocks: `git symbolic-ref -q
HEAD` needs a `refs/heads/...` on exit 0, and `git rev-parse --verify --quiet
<REF>` must **fail** — a blanket success claims the repository is mid-rebase.

## The multi-issue queue

`run` may coordinate several issues in one process (`src/execution/`). Three
rules keep that from leaking into the single-issue path, which is still the
common case and the one every older test covers:

- **The decision is taken before anything is published.** `runPipelinePhases`
  runs `init`, resolves the Issue, and only *then* asks the planner whether this
  invocation is a queue — a window in which no `session:start` has been emitted
  and no artifact written. A run that turns out to be a queue returns
  `{ queue }` instead of an exit code, and `runIssueSession` deliberately skips
  its `session:end` publication so nothing is written for the aborted attempt.
- **A queue is only ever a queue with more than one issue.** Discovery finding
  nothing, `--only` on a single issue, a scope trimmed back to one issue: all of
  them fall back to `{ kind: 'single' }` and create no `execution-plan.json`.
- **A container is not implemented.** A node with children (or, when configured,
  an Epic type / `epic` label / `[Epic]` prefix) gets `role: 'container'`: it
  names the branch and the PR, `nextQueueIssue` never hands it out, and it
  completes when every child in the queue completes. `--yes` on a container
  means `--cascade`. Non-interactive without a flag **fails** rather than
  running the umbrella alone. `Closes` becomes `Refs` when a child is still
  pending — the verb follows the plan, not the issue type (#77 / #74).
- **Per-issue runs differ from a standalone run in exactly four ways**: the `pr`
  (and `pr-review`) phase leaves the per-issue phase list, the branch of the
  queue is written over the plan's own `branchName` after the `plan` phase,
  `runExecute` receives a `commitScope`, and neither the issue close nor the
  final summary happens per issue — the queue owns both.

Each issue of a queue gets its **own** publisher over its **own**
`session.json`, so the publication order documented below is per issue and
unchanged; nothing publishes into two sessions at once. The queue's closing
pass (the consolidated Pull Request) publishes into the primary issue's
session with a phase list of `init` + `pr` (+ `pr-review`), which is why
`startIdx` is clamped: a resume phase that is not in that list starts the
renderer at the beginning instead of at `-1`.

Anything that window needs from `tasks.json` is read in the single `try` block
that already loads the plan (the one resolving `--no-branch`): a run must not
gain a second disk read per enrichment. The seed publishes nothing on an empty
plan — an event with no content still bumps the publisher's version and forces a
write plus a cache miss on every poller.

## The convergence of the oneshot (§17)

`issue-flow run` is the **only** execution path. §17 of the absorption plan
folded `webmux oneshot` into it, and the rule that came with it is that nothing
here may grow a second one: there is no `oneshot` command, and `--prompt` is not
a lighter mode.

Three things arrived, and each stays in its own place:

- **A free prompt is an Issue.** `--prompt` is resolved by `demand.ts` and
  minted by `issues/providers/inline.ts` into an Issue of the `inline` origin,
  *before* the pipeline starts. Past `resolveRequestedIssues()` in `run.ts`,
  nothing downstream can tell an inline demand from a GitHub one — which is
  what keeps the phases, the acceptance contract and the independent reviewer
  identical for both. Do not add a branch that asks "is this inline?" to a
  phase; if one seems necessary, the mint is wrong.
- **The agent's own end-of-work signals are additional, never authoritative.**
  `agent_stopped` and `pr_opened` (already persisted by `agents/hooks/`) are
  read by `auto-close.ts` and weigh only on the close. The pipeline's verdict
  is what ends a run: a run that stopped its phases early on the agent's say-so
  would be a run nobody verified (§45.3).
- **Auto-close is opt-in and a person disarms it.** `--auto-close` marks the
  run's live `AgentSession` rows `stopped`; it deletes nothing and never touches
  a branch or a worktree. A run under `human_hold` is skipped, and the hold is
  re-read immediately before closing so a takeover during the run's own
  finalization still aborts it. There is no second armed/disarmed flag — armed
  *is* "no human hold", and `core/human-hold.ts` owns that question alone.

`core/run-completion.ts` is the ported decision (grace window, cold-start guard,
in-flight guard, disarm-even-when-the-close-failed) and knows nothing about
Issue Flow; `run/auto-close.ts` is the half that does. Keep them apart: the
first is what the upstream suite is ported against.
