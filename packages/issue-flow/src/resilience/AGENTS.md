# src/resilience

The failure taxonomy and the retry policy of the pipeline. Everything that
decides *whether to try again, and after how long* belongs here — and only here.

`errors.ts` answers **what went wrong** (`classify`); the retry policy and the
single retry executor land alongside it. Nothing in this directory performs I/O,
reads configuration files or knows about phases: it takes evidence and returns a
verdict.

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

## Rules

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
