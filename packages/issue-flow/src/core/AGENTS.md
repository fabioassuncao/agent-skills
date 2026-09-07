# src/core

## session-state.ts ↔ schemas.ts are in lockstep

`session-state.ts` is a façade over [`session/`](session/AGENTS.md). The
snapshot contract lives in `session/events.ts` and `session/snapshot.ts`;
the reducer is `session/reducer.ts` (cases in `session/reducer-*.ts`).

`sessionSnapshotSchema` ends with `satisfies z.ZodType<SessionSnapshot>`. Any
field added to `SessionSnapshot`, `SessionPhaseSnapshot` or
`SessionStorySnapshot` **must** be added to the matching zod schema in
`src/schemas.ts` in the same change, or `tsc --noEmit` fails. The two cannot be
split across commits.

`schemaVersion` stays `1` for purely additive fields — bump it only when an
existing field changes shape or disappears.

The snapshot schema describes only the current release. New required fields must be added to the TypeScript interface, reducer initializer and Zod schema in the same change; do not add defaults solely to accept obsolete payloads. Optional fields remain optional only when absence has current domain meaning.

## Reducer contract (`applyEvent`)

- Pure: never mutates the input, never does I/O. Returning the input snapshot
  by identity (`return snapshot`) is how an event is "ignored"; callers and
  tests rely on `expect(next).toBe(before)`, and `reduceSessionEvent`
  short-circuits on identity so `updatedAt` is not bumped either.
- `stories:update` **rebuilds** the stories array from the plan on every
  publish. Anything accumulated per story by other events (`completedAt`,
  metrics) must be copied over from the `previous` map, or the next update
  wipes it.
- `verification` on the snapshot is set by `verify:end`. `null` means no contract has run; `unverified` is a first-class verdict, never presented as verified success.
- A phase's `durationSeconds` comes only from `phase:start`/`phase:end`. Other
  events carrying a duration must not write it. Additive timing on the same
  event (`harnessExecutionMs`, `orchestrationOverheadMs`, `harnessStartupMs`,
  `ttftMs`, `attemptCount`, `retryDurationMs`) is optional: absent stays
  `null` (`.default(null)` in `src/schemas.ts`). `schemaVersion` stays `1`.
- `issue:update` **merges** over the `issue` section: `number` and `url` fall
  back to what `session:start` published (`event.x ?? snapshot.issue.x`), so an
  origin with no remote never erases an identifier the run already knew. The
  enrichment fields (title, description, labels, state) are written as reported
  — an empty body is a value, not "unknown".
- `git:update` feeds two sections from one publication: `git` (branch, base,
  commits) and `repository` (identity and location). On the repository fields
  `undefined` means "not collected in this publication" and keeps the previous
  value, while an explicit `null` means "collected and unavailable" and
  overwrites it — that is why they go through `reported()` instead of `??`.
  New repository data belongs on this event, not on a second one, or the two
  sections drift apart on `branch`.
- `execution:update` projects the canonical SQLite execution row into
  the live snapshot; it must upsert by execution id so begin/end publications
  describe one invocation, not two. `process:output` is a bounded redacted tail,
  while durable diagnostics belong to `storage/diagnostics.ts`.
- Story `history` is append-only for real stage changes. Repeating the current
  stage does not add an event; `stories:update` must preserve existing history.
- Derived fields (`errors`, `warnings`, `nextSteps`, `estimatedRemainingSeconds`
  and each story's `status`) are recomputed in `reduceSessionEvent` **after**
  `applyEvent`, never accumulated inside a case. A new derived field belongs
  there so it stays consistent for every event type.
- A story's `stage` is the one exception to the rule above, and deliberately
  so: it is **accumulated inside the cases** that cause a transition
  (`stories:update`, `iteration:start`, `correction:cycle`, `phase:start`/
  `phase:end` of `review`, `session:end`), never recomputed afterwards, because
  a stage like `in_correction` has to survive an unrelated `stories:update`
  that carries no information about it. Two invariants keep that safe: only
  `done` and `failed` are terminal, and every ending event (`phase:end` with
  `success: false`, `session:end`) must close all non-terminal stages — a run
  that is over can never leave a story on `executing`.
- A story's `status` is observational: `passes` remains the only thing the
  pipeline (engine, state-manager, review) reads to decide flow. The derivation
  is idempotent by construction — `done` (from `passes`) > a sticky `in_review`
  > `in_progress` (the story owns `currentActivity`) > `backlog` — and
  `in_review` is never produced automatically, only carried from an explicit
  `status` in `tasks.json`.
- `metrics:update` scopes: `phase`/`iteration` feed the named phase **and** the
  issue-wide aggregate; `story` feeds the story only. Story metrics are a
  rateio of an iteration already counted at phase level — counting them
  globally too would double the totals.
- `undefined` in a metric field means "not reported", never zero: it leaves the
  accumulator at `null`. An explicitly reported `0` is a value and is kept.

## journal.ts: serialized event utilities

- Canonical event history lives in SQLite. `parseJournal()` and `replayJournal()` consume serialized records for diagnostics and decomposition without owning persistence.
- Replaying ordered records must reproduce the same snapshot as the live reducer.
- Invalid or incomplete diagnostic lines are ignored; persisted rows are validated at their storage boundary.

## shutdown.ts: the order of a Ctrl+C is the design

- **The sequence is fixed**: abort the process-wide signal → write the
  checkpoint → `SIGTERM` the child, grace, `SIGKILL` → close the surfaces →
  exit (130 for `SIGINT`, 143 for `SIGTERM`). Each position is load-bearing.
  The signal fires first because every retry backoff already waits on it, so an
  interrupt during a fifteen-minute delay stops in that instant. The checkpoint
  runs **while the child is still alive**, because checkpointing after the kill
  races the very writes it is trying to capture. The SQLite publisher closes
  **last**, so everything the steps above published is durable.
- **A second interrupt ends it now.** Someone who pressed `Ctrl+C` twice has
  said what they want, and waiting out the remaining grace to be polite is not
  it.
- **`getShutdownSignal()` works without handlers installed.** It creates the
  controller lazily, so a backoff that captured the signal behaves identically
  in a test that never installs anything — which is what keeps every existing
  path unchanged.
- **`installShutdownHandlers()` is idempotent.** A second set of handlers would
  run the whole sequence twice: two checkpoints, two kills, two exits.
- **Every child must be deregistered when it finishes normally.** `registerChild`
  returns the function that does it; a set that only grows has the shutdown
  signalling pids that belong to something else entirely by then.
- **A hook that throws does not stop the ones after it.** Storage still has to
  be closed even when the checkpoint could not be written.

## The post-commit story checkpoint is a net, not a source

`adoptCommittedStories()` runs before every iteration of the execute loop and
marks a pending story as passing when **both** hold: its id appears in a commit
subject of this branch (`<type>(scope): US-001 - Title`, what the prompt writes),
and the working tree is **clean**.

- **The agent's `passes` remains the primary source.** This closes exactly one
  window the agent cannot close itself: the crash between the commit landing and
  `passes: true` being written. Without it the next iteration redoes the story on
  top of a commit that already exists.
- **A dirty tree disables it entirely.** Uncommitted changes mean work in
  flight, and adopting a story on that basis calls finished what is not.
- **It only ever reads.** `committedStoryIds()` and `isWorkingTreeClean()` run
  `git log` and `git status`; nothing here checks a branch out or creates one.
  That is the invariant that makes it safe beside the agent's `git checkout -B`
  and the queue's `adoptQueueBranch` — this code has no opinion about which
  branch is checked out, it reads the one that is.
- **It never throws.** A git that cannot answer, or a plan that cannot be
  written, leaves the loop doing exactly what it did before.
- **A test that mocks `execa` wholesale must stub `../utils/git.js`**, or the
  two git reads consume the CLI results the test queued.

## decompose.ts: detected, reported, never acted on

- **Two signals or nothing.** Each one alone is ambiguous — a long plan can be a
  long plan, a timeout can be a slow afternoon. `DECOMPOSITION_MIN_SIGNALS` is
  what turns coincidence into evidence.
- **An infrastructural failure never reaches this conclusion.** Network and
  rate-limit retries are not size signals; only `timeout` and `stalled` ones
  count. Reacting to an outage with "have you considered splitting this issue?"
  is worse than saying nothing, and `decompose.test.ts` pins it.
- **Every signal quotes its number.** "This is too big" is not an argument; "the
  `execute` phase timed out twice" is, and a person can disagree with it.
- **The default is a report plus `blocked`.** Splitting an issue is a product
  decision. `--auto-decompose` is the opt-in, and even then it refuses once the
  branch carries committed stories — splitting on top of half-finished work
  leaves commits belonging to no issue.
- **The proposed cut is deliberately unclever**: pending stories in priority
  order, five at a time, each piece depending on the one before it. That is the
  only dependency shape derivable from the plan alone; anything more would be a
  guess dressed as a plan.

`runHeadless` and `executeClaude` stay the facades seven commands and the
engine talk to. Argv and stream parsing live in `src/agents/` — see
[`src/agents/AGENTS.md`](../agents/AGENTS.md). The default agent is Claude,
and an unconfigured invocation produces the same argv this project has always
used (`workspace` for `runHeadless`, `autonomous` for `executeClaude`).

## executor.ts output contract

On the happy path (`exitCode === 0` and parseable JSON envelope),
`ClaudeResult.output` is the **assistant text** (`parsed.result`), not raw
stdout. On any failure it falls back to raw `stdout + stderr`, because
`isTransientFailure()` inspects the raw diagnostics. Never unwrap the envelope
on a failing exit code.

## The stream is always requested; only the rendering differs

`--output-format stream-json --verbose` is what **every** invocation asks for
now — `runHeadless` in both its paths and `executeClaude`. The single `json`
envelope arrives in one write at the very end, which meant the non-verbose path
(the common one, and the one that runs unattended for hours) had no signal at
all while the agent worked: a hung invocation looked exactly like a thinking
one. Verbose prints each event; non-verbose feeds a spinner and the watchdog.

- **`core/stream.ts` is the shared reader**, so the two renderings cannot drift
  on what a `result` event means or on how usage is extracted.
- **The stream is consumed by the time the process exits**, so `result.stdout`
  is empty and `StreamOutcome.raw` is the only copy of what the CLI printed.
  That is the fallback for a build that ignores `--output-format`, and for a
  failure whose diagnostics went to the stream.
- **A malformed line is activity, not an error.** The CLI interleaves its own
  output with the stream; a line that is not JSON still proves the process is
  alive, which is the only question the watchdog asks.
- **A test that mocks `execa` must return a subprocess with a `stdout` stream**,
  not a plain resolved result — otherwise the reader sees nothing and every
  assertion about the result falls back to the raw-output path.

## watchdog.ts: silence, not slowness

- **The absolute timeout is a ceiling; the watchdog is the tighter instrument.**
  `DEFAULT_HEADLESS_TIMEOUT_MS` still bounds a task that keeps talking and never
  finishes. The watchdog bounds one that stops talking — which is the only case
  the execute loop had no instrument for at all, since it runs with `timeout: 0`
  by design.
- **`inactivityTimeoutMs: 0` is the off switch**, and it returns an inert
  watchdog rather than adding a second code path anywhere else.
- **`describeStall()`'s wording is a contract**, exactly like the timeout's:
  `classify()` reads text as its last resort, and `stalled` has to survive the
  trip through a plain string for the phase to keep its retries. The
  `errors.test.ts` table pins it.
- **The child is asked before it is killed** — `SIGTERM`, grace, `SIGKILL` —
  the same courtesy the shutdown extends, for the same reason: an agent killed
  mid-write leaves half a file behind.

## The headless timeout is reported, never swallowed

`runHeadless` runs the CLI with `reject: false`, so **execa resolves on a
timeout instead of throwing** — the `catch` block is not what handles one. The
finished result is what carries it, and it arrives in more than one shape:
`timedOut: true` always, plus `signal: 'SIGTERM' | 'SIGKILL'` when execa did
the killing, or a bare `exitCode` of 143/137 when the CLI installed its own
handler and exited by itself (which `claude` does, leaving 143 and no signal).
`wasTimedOut()` covers all three, guarded by the elapsed time so an unrelated
external kill is not relabelled. The same clock guard decides in the `catch`,
where there is no process to inspect at all: a rejection that arrives nowhere
near the limit — or with no limit set — keeps its own message rather than being
dressed up as our timeout.

The wording matters as much as the detection: once the finished process is
behind us, the error string is all that reaches `resilience/errors.ts`, whose
**text rules are the last resort** of the classifier — and that is what earns
the phase its retries in `phase-runner.ts`. A timeout reported as a bare
`claude exited with code 143` — the shape this had before — both hides the
cause and silently costs the phase every retry it had, because `143` on its own
deliberately classifies nothing (Ctrl+C leaves the same code). Any new failure
message that describes a timeout keeps the words `timed out` in it.

Every single-invocation phase takes its limit from `DEFAULT_HEADLESS_TIMEOUT_MS`
(`getGlobalTimeout() ?? DEFAULT_HEADLESS_TIMEOUT_MS` at the call site, so
`--timeout` always wins, and `--timeout 0` means no limit). Do not write a
per-phase literal: the value drifted apart across the commands exactly that way,
and the README documented a third number. The execute loop is the deliberate
exception, running with `timeout: 0` (`executor.ts`) because its iteration
budget is what bounds it.

## Parsing CLI metrics

All token/cost parsing goes through `core/metrics.ts` (`parseUsage`,
`sumUsage`, `formatTokens`). Do not read `total_cost_usd` / `usage.*` directly
from a call site — that is exactly how the three call sites diverged before.
Per-invocation history lives in `src/telemetry/` and is written only by
`recorder.ts`; see that module's `AGENTS.md`.

`runHeadless` only ever returns a non-null `cost` when it can see the CLI's
JSON: `outputFormat: 'json'`, or the verbose path (`stream-json`).
`outputFormat: 'text'` always yields `cost: null`, so a phase that wants
metrics has to ask for `'json'` — the envelope's `result` field carries the
same assistant text `'text'` would have returned.

## Publishing metrics

`core/session-metrics.ts` is the single entry point for `metrics:update`
events — `publishPhaseMetrics` for the single-invocation phases,
`publishIterationMetrics` / `publishStoryMetrics` for the execute loop. They
are no-ops when the CLI reported no usage, so no call site needs to guard on
`result.cost`. One call per headless invocation: retrying phases and the review
correction cycle publish several, and the reducer's summing is what produces
the phase total.

## Totals for the terminal come from the process, not the snapshot

`session-metrics.ts` also keeps process-owned counters (`getRunUsageTotals`,
`getPhaseUsageTotals`), fed by the same `publishPhaseMetrics` /
`publishIterationMetrics` calls. The session snapshot is what the clean terminal view renders
(`src/ui/status-view.ts`), because `run` now installs a `MemoryPublisher` even
when `--web` is off. Cost totals in the end-of-run summary box still come from
the process-owned counters: they predate the always-on reducer and stay the
source of `printSummaryBox` so a standalone phase command without a publisher
does not print zeros. Story-scoped usage is deliberately **not**
recorded there — it is a rateio of an iteration already counted, same
anti-double-counting rule as the reducer.

They are module state, so any test that publishes metrics must call
`resetRunUsageTotals()` in `afterEach`, or later tests in the same file inherit
the counters.

Multiple issues **do** run in the same process now (the multi-issue queue of
`commands/run.ts`), so the counters are a **stack of scopes** rather than a
single accumulator. `beginUsageScope()` pushes one and returns a handle;
every publication feeds *all* open scopes, and `getRunUsageTotals()` /
`getPhaseUsageTotals()` always read the innermost one. That is what makes a
queue report a per-issue cost and a consolidated total from the same stream of
events, without issue A's tokens ever showing up in issue B's summary. A scope
must be `end()`ed by whoever opened it (`end()` is idempotent and tolerates
being called out of order); the bottom of the stack is the process total and is
never popped.

## Story-level metrics are an approximation

The CLI reports a single usage per invocation, and one execute iteration can
close several stories at once. `engine.ts` therefore diffs the plan read before
`executeClaude()` against the one read after it, and splits the iteration's
tokens, cost and duration evenly (`divideUsage`) across the stories that
flipped `passes: false → true`. With zero flips nothing is attributed and the
whole cost stays on the execute phase — never invent an owner.

Publication order in the loop matters: `stories:update` →
`metrics:update` (story) → `iteration:end` → `metrics:update` (iteration). The
story events must come after `stories:update`, which rebuilds the stories
array, or the reducer drops them.

The same shares are also written to `tasks.json` by `applyStoryMetrics()`
(state-manager), so they survive the session and are readable with web
monitoring off. That write is wrapped in a try/catch and the in-memory plan
only advances on success: persisting metrics is observational and must never
change an iteration's outcome. `UserStory`'s metric fields are optional and
accumulate by summing — an absent field means "not reported", so a plan from a
run that predates them never gains artificial zeros.

## Testing the execute loop end to end

`engine.test.ts` mocks `executor.js`, so it never exercises the CLI invocation
itself. When the change under test spans the loop **and** the executor (flags,
envelope unwrapping, what the loop decides from the result), write it in
`execute-regression.test.ts` instead: that file mocks `execa` and runs the real
`executeClaude()`, which is the only way to prove the CLI contract and the flow
decisions still agree. Mock `../utils/retry.js`'s `sleep` there too, or every
iteration costs real seconds — and `../resilience/policy.js`'s `abortableDelay`,
which is what the retry backoff waits on since the loop delegated to
`resilience/retry.ts:withRetry`.

Both contracts are user-facing: any new field on `SessionSnapshot` or `UserStory` also belongs in [`docs/storage.md`](../../../../docs/storage.md), which documents each field's meaning and states that `null` / absent means "not reported", never zero.
