# Harness baseline (`#79`)

Four task classes (`trivial`, `small`, `medium`, `analysis`) on the axis

```text
tarefa × harness × modelo × esforço × verificação × estratégia
```

Two modes, never mixed:

| Mode | What it measures | When it runs |
|---|---|---|
| `synthetic` | Orchestration only. The harness is a mocked duration. | CI (`vitest` → `src/benchmark/synthetic.test.ts`) |
| `real` | The same task through the Issue Flow pipeline and the acceptance contract. | On demand. **Never CI.** |

`time-to-accepted-result` is the headline metric. It needs the acceptance
verdict from `#85`. Until that contract exists every row is `unverified`, and
`unverified` must not be mixed with `passed` when comparing quality.

The corpus lives in TypeScript (`src/benchmark/corpus.ts`). The runner is
`issue-flow bench`.

## Synthetic (CI)

```bash
npm test -- src/benchmark/synthetic.test.ts
issue-flow bench --mode synthetic
```

A regression of the reducer or of `sessionSnapshotSchema.parse` past the
budgets in `src/benchmark/synthetic.ts` fails the suite.

## Real (never CI)

```bash
issue-flow bench --mode real --yes
```

`real` is refused under `VITEST` unless `ISSUE_FLOW_E2E_BENCH=1`. The
campaign pins `--setting-sources` and never passes `--fallback-model`.
Harness version and model version are recorded on every row.

The published **before** table lives in
[`docs/research/2026-08-30-harness-baseline.md`](../../../../docs/research/2026-08-30-harness-baseline.md).
Phases 3–4 (quick wins, `storiesPerIteration`) are `#89` and must not be
decided against this file alone.
