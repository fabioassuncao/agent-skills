# src/core

## session-state.ts ↔ schemas.ts are in lockstep

`sessionSnapshotSchema` ends with `satisfies z.ZodType<SessionSnapshot>`. Any
field added to `SessionSnapshot`, `SessionPhaseSnapshot` or
`SessionStorySnapshot` **must** be added to the matching zod schema in
`src/schemas.ts` in the same change, or `tsc --noEmit` fails. The two cannot be
split across commits.

`schemaVersion` stays `1` for purely additive fields — bump it only when an
existing field changes shape or disappears.

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
- `metrics:update` scopes: `phase`/`iteration` feed the named phase **and** the
  issue-wide aggregate; `story` feeds the story only. Story metrics are a
  rateio of an iteration already counted at phase level — counting them
  globally too would double the totals.
- `undefined` in a metric field means "not reported", never zero: it leaves the
  accumulator at `null`. An explicitly reported `0` is a value and is kept.

## executor.ts output contract

On the happy path (`exitCode === 0` and parseable JSON envelope),
`ClaudeResult.output` is the **assistant text** (`parsed.result`), not raw
stdout. On any failure it falls back to raw `stdout + stderr`, because
`isTransientFailure()` inspects the raw diagnostics. Never unwrap the envelope
on a failing exit code.

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
