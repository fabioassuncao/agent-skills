# src/telemetry

Per-invocation history written into SQLite. `tasks.json` is a materialized
compatibility projection for agents; `executions` remains relational and is
never updated through a read-modify-write of that file. This complements
story-level metrics (`UserStory` token fields) and the journal (`events.jsonl`):
this is the consultable state; the journal is the timeline. They share
`executionId`.

```text
Git            → describes what changed in the software
Task telemetry → describes how the change was produced
```

## Invariants

- **`recorder.ts` is the only execution writer.** Call sites `beginExecution` /
  `endExecution`; it writes an `executions` row through `storage/db/repository.ts`.
  It must never read or rewrite `tasks.json`, since an agent may own that
  projection while an invocation closes.
- **Two writes, outside the agent's window.** `running` + `startedAt` +
  `owner` before spawn; final status after exit. A `kill -9` leaves `running`;
  `loadTaskPlan` reconciles it to `interrupted` when the pid on this host is
  gone (`storage/lock.ts`: only `ESRCH` is dead).
- **Observational.** A failed persist never changes the invocation outcome.
- **No secrets, no prompts, no full output.** `redact.ts` runs on every
  failure message. Tokens and cost are numbers, not payload.
- **Cost is a discriminated union.** `{ reported, amount: 0 }` is not
  `{ unknown }`. `summarize()` never adds reported to estimated.
- **Estimation is opt-in.** Default `telemetry.pricing.estimate: false`.
  Issue Flow never estimates a price unless asked, and never labels an
  estimate as a charge. An estimate stores the four rates it used.
- **`verdict` is additive.** `attachVerdict` writes `{ status, level,
  independence }` onto the last `ExecutionRecord`. Empty contract →
  `unverified`. L2 cost uses `purpose: 'verify'`, never mixed into
  `execute`.
- **Time lives on the same record.** `cliDurationMs`, `harnessStartupMs`
  (`wall − duration_ms`), `apiDurationMs`, `ttftMs` and `numTurns` are
  additive and optional. Absent means "not reported", never zero. There is
  no second observability system beside this one.
- **`executions` is additive in the projection.** No `.default([])`, no
  `schemaVersion` bump. A plan that never had the field must not gain `[]`
  merely from materialization.
- **`executionSummary` and `totalTokens` are derived, never persisted.**
- **Provider, harness and model are declared by the runner**, never inferred
  from argv or logs. `model.source: 'unavailable'` when the harness does not
  say.
- **Git artefacts never read this module.** Branch, commit, PR body and
  changelog stay provider-independent. `git-isolation.test.ts` enforces it.

## Configuration

`defaults < ~/.issue-flow/config.json < .issue-flow.json < env`

- `telemetry.enabled` (default `true`) — `ISSUE_FLOW_TELEMETRY`
- `telemetry.maxExecutions` (default `500`, FIFO + discarded counter) —
  `ISSUE_FLOW_TELEMETRY_MAX_EXECUTIONS`
- `telemetry.pricing.estimate` (default `false`) — `ISSUE_FLOW_TELEMETRY_ESTIMATE`
- `telemetry.pricing.overrides` — negotiated rates, beat the table
