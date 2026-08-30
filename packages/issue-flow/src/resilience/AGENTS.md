# src/resilience

The failure taxonomy and the retry policy of the pipeline. Everything that
decides *whether to try again, and after how long* belongs here — and only here.

`errors.ts` answers **what went wrong** (`classify`); `policy.ts` answers **what
to do about it** (`resolvePolicy`, the backoff, the run state machine);
`retry.ts` is the one place that **does** it (`withRetry`). Nothing in this
directory performs I/O, reads configuration files or knows about phases: it
takes evidence and returns a verdict.

## The golden rule

**`task_execution` is never retried by this layer.**

A failing test, a type error, a lint violation — that is the agent's work being
wrong, not the infrastructure being unavailable. Retrying it changes nothing:
the same prompt against the same tree produces the same failure. It already has
its own loop, and it is a different one — the `review` correction cycle, bounded
by `maxCorrectionCycles` in the task plan.

Confusing the two is exactly how an infinite retry is born: the resilience layer
waits, retries, fails identically, waits longer, forever, while the actual defect
is never fed back to anyone who could fix it. `--retry-forever` does not change
this, and no configuration key may.

The same veto covers `authentication`, `configuration` and `repository_state`:
waiting cannot fix a missing credential, a mistyped flag or a repository stuck
mid-merge. `requiresHumanAction(kind)` is the predicate; those four kinds
escalate, they do not retry.

The rule is not a convention to be remembered — `resolvePolicy()` clamps those
four kinds to `maxAttempts: 0, retryForever: false` **after** the configuration
layer has been merged in, so no profile, no configuration file and no flag can
buy them an attempt. Anything that wants to bypass it has to delete that clamp,
which is a much louder change than editing a JSON file.

## Rules of `errors.ts`

- **Text is the last resort, never the first.** `classify()` decides by
  precedence: `errno` / `httpStatus` (a machine told us) → how the process ended
  (`stalled`, `timedOut`, `signal`) → an exit code whose meaning is unambiguous →
  and only then the output text. A caller that has an `errno` or an HTTP status
  in hand must pass it: dropping it down to a text blob throws away the only
  evidence that is not a heuristic.
- **A new classification rule earns a row in the table test before it earns a
  line of code.** `errors.test.ts` is a case-by-case table of realistic signals;
  the table *is* the contract.
- **`retryable` is advice, not a budget.** It says whether this layer will
  consider the failure at all. How many attempts, and how long between them, is
  the policy's answer — never the classifier's.
- **`internal` and `unknown` are not retryable.** An unclassified failure gets
  the conservative answer, which is also exactly what `isTransientFailure()`
  answered before this module existed. A policy may still grant them a small
  bounded budget; the classifier will not claim they are transient.
- **`isTransientFailure(exitCode, output)` stays exported from `utils/retry.ts`
  as a thin adapter over `classify()`**, with the same signature and the same
  verdict for every case it used to cover. It exists because `core/engine.ts`
  and the phase commands are written against it. New call sites should call
  `classify()` and keep the whole `ClassifiedFailure` instead — the adapter can
  only ever see an exit code and a blob of text.
- **Ordering inside `TEXT_RULES` is meaningful.** First hit wins, so the
  specific causes (rate limit, credentials) are consulted before the generic
  ones, and `task_execution` is last: a network failure surfacing inside a test
  run is still a network failure.
- **A pattern may be a string or a `RegExp`.** Strings are matched with
  `includes` against the lower-cased output; use a `RegExp` when the shape
  matters (`/\b\d+\s+failed\b/` for what a test runner actually prints).

## Rules of `policy.ts`

- **The defaults table is the contract, and it is the PRD's table.** Every cell
  of `BASE_POLICIES` is asserted row by row in `policy.test.ts`. Changing a
  number there is changing documented behaviour and the test says so out loud.
- **Precedence is base → profile → user configuration → the golden-rule
  clamp.** The clamp is last on purpose; everything else is a plain object
  spread, in that order, so "what wins" is readable in one expression.
- **A profile only ever widens a budget.** `continuous` grants more attempts and
  `retryForever`; it never makes a non-retryable kind retryable.
- **`retryForever` is bounded in *delay*, never in *count*.** The ceiling is
  `maxDelayMs` and `computeDelayMs()` applies it identically whether the budget
  is finite or not. Waiting forever is a supported answer; hammering a service
  that is down is not.
- **Full jitter is the default**: `random(0, ceiling)`, not `ceiling ± noise`.
  The RNG is injectable (`computeDelayMs(policy, n, { random })`) so the backoff
  curve is asserted exactly, with no tolerance window.
- **A server's `Retry-After` wins outright** — un-jittered, and *not* capped by
  `maxDelayMs`. Capping it would mean coming back before the server allowed,
  which is precisely the behaviour rate limiting exists to punish.
- **Every wait goes through `abortableDelay()`**, which resolves `false` when
  the signal fires instead of throwing. A caller that slept fifteen minutes and
  a caller that was interrupted must not take the same next step, and an abort
  is an expected outcome here, not an error.
- **`failoverOnAuth` is opt-in and stays that way.** It is the only way
  `authentication` gets a `failover` other than `never`, and it never leaks to
  the other three human-action kinds. Silently switching provider because the
  main one lost its credential hides exactly what the user needs to be told.
- **The state machine lives here and only here.** `RUN_TRANSITIONS` is the whole
  table; `canTransition()` is the only reader. `completed` and `cancelled` are
  terminal, and `blocked` is left only by `actor: 'human'` — a pipeline that
  could unblock itself would spin on the same missing credential forever.
- **`RunStatus` is the run level.** The issue-level `runState.status` persisted
  in `tasks.json` is a projection of it (`idle` is the name `queued` takes on a
  single issue); the transitions are not re-declared there.

## Rules of `retry.ts`

- **There is one retry loop in this project, and it is `withRetry()`.** Before
  it, `core/phase-runner.ts` and the `execute` loop of `core/engine.ts` each had
  their own counter, their own backoff and no way of staying in step; both now
  delegate. A third loop is a bug, not a feature — a new call site passes a
  `RetryPolicy`, it does not write a `for`.
- **The veto is enforced here a second time.** `resolvePolicy()` clamps the
  four human-action kinds, but a caller may hand-build a `RetryPolicy` without
  ever going through it, so `withRetry()` checks `requiresHumanAction()` on the
  *classified kind* as well. Neither check is redundant: one guards the
  configuration, the other guards the call site.
- **The caller owns the verdict, through `evaluate`.** Only the caller knows
  what failure looks like in its own return type — an exit code, an `ok: false`,
  an HTTP response — and `ClassifiedFailure.retryable` as it returns it is
  authoritative. A phase that failed on something only it can see (a PRD file
  that never appeared) says so there; `classify()` is then consulted for the
  *kind* alone.
- **Nothing is published from this module.** Everything observable goes back
  through `onAttempt`, which is awaited before the backoff, so a caller's event,
  print or `tasks.json` write lands before the wait begins. Keeping the
  publisher out is what lets this directory stay I/O-free.
- **`onAttempt` fires on *every* attempt, including the successful one and the
  one that spends the last of the budget.** `willRetry` is the discriminator,
  never the presence of a failure.
- **`fixedBackoffPolicy()` is un-jittered on purpose.** It is the shape the two
  legacy call sites express themselves in, and both publish their delay in a
  `retry` event and print it; jitter arrives with the configuration key that
  asks for it, not as a silent change of today's numbers.
- **The two historical budgets are preserved as data, not as code**:
  `fixedBackoffPolicy(3, 15, 120)` for the single-shot phases and
  `fixedBackoffPolicy(retryLimit + 1, 30, 900)` for `execute`. The `+ 1` is not
  a fudge: `EngineConfig.retryLimit` counts *retries*, `maxAttempts` counts
  *attempts*.

## Gotchas

- **Exit code `143` decides nothing on its own.** The Claude CLI handles
  `SIGTERM` itself, so a user's Ctrl+C and our own timeout both leave `143`
  behind. Only `timedOut` or `signal` tells them apart, which is why `143` is
  deliberately absent from `EXIT_CODE_KINDS` — `core/headless.test.ts` guards
  both halves of this.
- **The words "timed out" are a contract.** `core/headless.ts` phrases a timeout
  so it keeps saying them, because the text rules are what classifies it when no
  structured evidence survived. See `src/core/AGENTS.md`.
- **GitHub reports a secondary rate limit as `403`, not `429`.** That is why
  `kindFromHttpStatus` consults the text for a `403` before calling it an
  authentication failure — and why a plain `401` never does.
- **`Retry-After` is either a count of seconds or an HTTP date.** Both are
  parsed; a date already in the past yields nothing rather than a bogus zero.
  The clock is injectable (`classify(signal, { now })`) precisely so the date
  branch is testable.
- `retryAfterMs` is **omitted**, not set to `undefined`, when the server said
  nothing — a caller can test the property's presence.
- **`attemptsMade` is a count of failures, not an index.** `computeDelayMs(p, 1)`
  is the wait *before the second attempt* and yields `initialDelayMs` as its
  ceiling, because the exponent is `attemptsMade - 1`. Off by one here doubles
  or halves every delay in the project.
- **`stalled` and `internal` have `initialDelayMs === maxDelayMs`.** That is the
  table saying "a flat delay", not a missing value: with the two equal, the
  backoff factor has nothing to grow into.
- **A retry costs no iteration budget in `execute`.** `withRetry` loops *inside*
  one pass of the engine's `while`, which is what the old `i--; continue` bought;
  everything a retried attempt must redo — re-reading `tasks.json`, republishing
  `iteration:start`, re-rendering the prompt — has to stay inside the function
  handed to `withRetry`, because the loop it replaces re-ran all of it.
- **Faking a backoff in a test means mocking `abortableDelay` from
  `resilience/policy.js`**, not `sleep` from `utils/retry.js`. `withRetry` never
  touches the latter, and a test that mocks the wrong one waits for real.
