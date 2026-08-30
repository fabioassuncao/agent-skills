# src/core

## session-state.ts ↔ schemas.ts are in lockstep

`sessionSnapshotSchema` ends with `satisfies z.ZodType<SessionSnapshot>`. Any
field added to `SessionSnapshot`, `SessionPhaseSnapshot` or
`SessionStorySnapshot` **must** be added to the matching zod schema in
`src/schemas.ts` in the same change, or `tsc --noEmit` fails. The two cannot be
split across commits.

`schemaVersion` stays `1` for purely additive fields — bump it only when an
existing field changes shape or disappears.

A newly added snapshot field must also be tolerant on **input**, or a
`session.json` written by an earlier release stops parsing: the snapshot's
non-optional fields (`number | null` and friends) need `.default(null)` in
`src/schemas.ts` so "absent" and "not reported" resolve to the same value. The
output type is unchanged, so `satisfies z.ZodType<SessionSnapshot>` still
compiles. Fields on `UserStory` are plainly `.optional()` instead — a plan that
never had them must not gain artificial nulls on a round trip.

## Reducer contract (`applyEvent`)

- Pure: never mutates the input, never does I/O. Returning the input snapshot
  by identity (`return snapshot`) is how an event is "ignored"; callers and
  tests rely on `expect(next).toBe(before)`, and `reduceSessionEvent`
  short-circuits on identity so `updatedAt` is not bumped either.
- `stories:update` **rebuilds** the stories array from the plan on every
  publish. Anything accumulated per story by other events (`completedAt`,
  metrics) must be copied over from the `previous` map, or the next update
  wipes it.
- A phase's `durationSeconds` comes only from `phase:start`/`phase:end`. Other
  events carrying a duration must not write it.
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

## journal.ts: the history beside the projection

- **`session.json` is a projection; `events.jsonl` is the history.** The reducer
  folds every event into one snapshot and discards the events, which is right
  for a dashboard and useless for an audit — after a six-hour run, "what
  happened at 3am" has no answer. The journal writes the events themselves, one
  JSON line each, in order, with a monotonic `seq`.
- **It sits *beside* `FilePublisher`, never in its place.** `MultiPublisher`
  holds both and fans one event stream out; `snapshot()` and `version()` answer
  from the first member, so the dashboard reads exactly what it always read.
  Dropping either surface leaves the other untouched.
- **Replaying the journal must reproduce the snapshot.** `replayJournal()` runs
  the same `reduceSessionEvent` over the lines in order, and `journal.test.ts`
  asserts the result equals the live snapshot. A file that cannot do that is a
  log, not a journal — if you add an event type, that test is what proves the
  two paths did not drift.
- **The invariant of this directory is unchanged**: `publish()` is synchronous
  and never throws, writes are serialized on a promise chain so lines never
  interleave, and every I/O failure is swallowed after a single warning.
  Nothing is throttled — coalescing is what the snapshot already does.
- **Rotation keeps exactly one previous generation**, and happens *before* the
  write that would cross `maxFileBytes`, so a line is never split across two
  files. `maxFileBytes: 0` disables it.
- **The journal is opt-in** (`resilience.journal.enabled`), because "monitoring
  off means the pipeline creates nothing at all" is a documented invariant of
  issue 25 and a journal writing by default would break it.

## executor.ts output contract

On the happy path (`exitCode === 0` and parseable JSON envelope),
`ClaudeResult.output` is the **assistant text** (`parsed.result`), not raw
stdout. On any failure it falls back to raw `stdout + stderr`, because
`isTransientFailure()` inspects the raw diagnostics. Never unwrap the envelope
on a failing exit code.

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
`publishIterationMetrics` calls. The session snapshot cannot be the source for
anything printed to the terminal: with web monitoring off the publisher is a
`NullPublisher` and its snapshot stays empty, so the numbers would vanish
exactly in the default mode. Story-scoped usage is deliberately **not**
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

Both artifacts are user-facing contracts: any new field on `SessionSnapshot` or
`UserStory` also belongs in the root `README.md` (`Web Monitoring →
session.json` for the snapshot, `Pipeline State & File Structure` for
`tasks.json`), which documents each field's meaning and states that `null` /
absent means "not reported", never zero.
