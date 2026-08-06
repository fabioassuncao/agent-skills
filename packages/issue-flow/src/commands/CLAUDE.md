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

Anything that window needs from `tasks.json` is read in the single `try` block
that already loads the plan (the one resolving `--no-branch`): a run must not
gain a second disk read per enrichment. The seed publishes nothing on an empty
plan — an event with no content still bumps the publisher's version and forces a
write plus a cache miss on every poller.
