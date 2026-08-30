# src/benchmark

Measure the orchestrator against the corpus of #79. Two modes, one instrument.

## Invariants

- **`synthetic` is CI.** It times `reduceSessionEvent` and snapshot parse.
  The harness is a number. `npm test` never invokes a provider, never
  spends money. Budgets live in `SYNTHETIC_BUDGETS`.
- **`real` is on demand.** `issue-flow bench --mode real` materializes a
  disposable git fixture per repetition, runs the pipeline, then the
  acceptance contract of #85. It is refused under `VITEST` unless
  `ISSUE_FLOW_E2E_BENCH=1`.
- **One fixture per repetition.** The second run of `small` must find the
  same failing test as the first. `dispose()` deletes the repository.
- **Comparability is code.** `assertComparable()` refuses two cells that
  differ in any field that is not the declared arm. `--setting-sources` is
  pinned; `--fallback-model` is never passed (if detected, the row is
  invalid); `--strict-mcp-config` is an arm, not environment.
- **Isolation.** A campaign sets `ISSUE_FLOW_HOME` to
  `<globalRoot>/bench/<campaignId>/`. The operator's `tasks.json`,
  journal and `providers.json` are not read or written. Issues resolve
  through `local.ts`. No `gh`, no push.
- **Cost `unknown` is not `$0`.** `timeToAcceptedResultMs` is `null` when
  the verdict is not `passed`. A ceiling stop emits a partial report —
  never a silently truncated table.
- **`p50` / `p95` live in `stats.ts`.** Both modes import them. Do not
  reimplement a percentile.

## Arms

`--arm` is a parameter. `#89` asks `baseline` / `strict-mcp`, `#85`
asks `L1` / `L2`, `#86` asks `escalation-off` / `escalation-on`. None of
those experiments add runner code.
