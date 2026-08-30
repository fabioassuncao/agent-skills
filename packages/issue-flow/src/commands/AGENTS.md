# src/commands

## Contract of a single-invocation phase

`analyze`, `generate`, `prd`, `plan`, `review`, `pr` and `pr-review` each own
one `runHeadless` call. Anything that has to be derived from that call belongs
to the command, not to the `instrumentedRunners` wrapper in `run.ts`: the
wrapper only sees `() => Promise<void>` and never receives the
`HeadlessResult`. Keeping it in the command also covers standalone runs
(`issue-flow prd 42`), which never go through the pipeline at all.

Concretely, a new phase command must:

- pass `outputFormat: 'json'` — `'text'` makes `runHeadless` return
  `cost: null` outside verbose mode, so no metric is ever captured. The
  envelope's `result` field carries the same assistant text, so every parser
  built on `result.result` keeps working;
- call `publishPhaseMetrics('<phase>', result.cost, startedAtMs)` (from
  `core/session-metrics.js`) **before** the `result.success` check — the tokens
  were spent whether or not the phase succeeded. The helper is a no-op when the
  CLI reported nothing, and can never change an exit code;
- publish once per invocation when it retries (inside the `attempt` callback of
  `runPhaseWithRetry`), letting the reducer sum the attempts.

`phase:start`/`phase:end` stay the only source of a phase's `durationSeconds`;
the duration carried by a metrics event is informational.

## Publication order in run.ts

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
