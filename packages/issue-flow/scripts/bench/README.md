# Harness baseline (`#79`)

Four task classes (`trivial`, `small`, `medium`, `analysis`) on the axis

```text
tarefa × harness × modelo × esforço × verificação × estratégia
```

Two modes, never mixed:

| Mode | What it measures | When it runs |
|---|---|---|
| `synthetic` | Orchestration only. The harness is a mocked duration. | CI (`vitest` → `src/benchmark/synthetic.test.ts`) |
| `real` | The same task through Issue Flow **and** a direct `claude -p`. | On demand. **Never CI.** |

`time-to-accepted-result` is the headline metric. It needs the acceptance
verdict from `#85`. Until that contract exists every row is `unverified`, and
`unverified` must not be mixed with `passed` when comparing quality.

## Synthetic (CI)

```bash
npm test -- src/benchmark/synthetic.test.ts
```

A regression of the reducer or of `sessionSnapshotSchema.parse` past the
budgets in `src/benchmark/synthetic.ts` fails the suite.

## Real (never CI)

```bash
node scripts/bench/run.mjs --mode real
```

The script refuses to start when `CI` is set. When you run it locally:

- Pass `--setting-sources user,project,local` (or a narrower list) so a
  personal MCP/settings mix is not silently part of the measurement.
- Do **not** pass `--fallback-model`. If a fallback fires, the model that
  ran is not the one being measured and the envelope does not say so.
- Record harness version **and** model version on every row. `claude-code` +
  model M and `codex-cli` + model M are different execution targets.

The published **before** table lives in
[`docs/research/2026-08-30-harness-baseline.md`](../../../../docs/research/2026-08-30-harness-baseline.md).
Phases 3–4 (quick wins, `storiesPerIteration`) are `#89` and must not be
decided against this file alone.
