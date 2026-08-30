# Verification, routing and escalation

Three mechanisms answer three different questions about a run:

| Mechanism | Question | Default |
|---|---|---|
| [Acceptance contract](#the-acceptance-contract) | Did the work actually pass objective checks? | **L1**, on |
| [Shadow routing](#shadow-routing) | Which harness *would* be the right one for this task? | **shadow** — records, acts on nothing |
| [Escalation](#escalation) | The attempts are not converging; what do we change? | **off** |

Configured through the [`verify`](configuration.md#verify) and
[`routing`](configuration.md#routing) keys of `.issue-flow.json`.

## The acceptance contract

Objective checks run twice: at the end of `execute`, and again at the start of
`review` before the LLM gives its verdict. A second model never substitutes for a
command that can fail on its own.

A red contract at the end of `execute` fails that phase. A red contract inside
`review` fails the review, which is what the correction cycle exists for — the
run re-executes and re-reviews, up to `maxCorrectionCycles`.

A check is a **command or an expected file, never prose**. The runner does not
parse model output; a regex over assistant text on this path would be a bug.

```json
{
  "verify": {
    "level": "L1",
    "contract": [
      { "id": "typecheck", "run": "npm run typecheck", "fatal": true },
      { "id": "lint", "run": "npm run lint", "fatal": true },
      { "id": "test", "run": "npm test", "fatal": true },
      { "id": "migration", "expectFiles": ["db/migrations/*.sql"] }
    ]
  }
}
```

### Where the contract comes from

| Source | When |
|--------|------|
| `verify.contract` in `.issue-flow.json` | Declared. Wins over everything |
| `package.json` scripts | `typecheck`, `lint` and `test` become `npm run …` / `npm test` |
| `Makefile` targets | `typecheck:`, `lint:`, `test:` become `make …` |
| `composer.json` scripts | a `test` script becomes `composer test` |
| Nothing | the contract is **empty** |

Discovery stops at the first source that yields anything. An explicitly declared
empty array (`"contract": []`) is an empty contract, not a request to discover.

### Verdicts

| Verdict | Meaning |
|---------|---------|
| `passed` | Every fatal check ran and succeeded |
| `failed` | A fatal check failed. Classified as `task_execution`, so [resilience](resilience.md#the-golden-rule) never retries it — the `review` correction cycle owns it |
| `unverified` | The contract was empty, or nothing conclusive ran |

**An empty contract finishes `unverified`, not green.** The pipeline continues,
and is never labelled a verified success. This is the single most important
property of the layer: silence is not a pass.

The verdict is written to `verify.json` in the issue directory, published on the
session snapshot (`verification`), attached to the execution telemetry record,
and printed on the terminal. Evidence is
[redacted](storage.md#execution-telemetry) before it touches disk and is keyed by
`executionId`.

Failed-check output is **diagnostic data**, not instructions: it is framed
explicitly before any later agent sees it, and the fixer must not edit the check
that failed.

### Levels

| Level | What runs |
|-------|-----------|
| `L0` | The contract runs and is recorded, but the level is reported as `L0` |
| `L1` | **Default.** The acceptance contract alone |
| `L2` | L1 plus an **independent reviewer** on a second harness |
| `L3`, `L5` | Accepted by the flag and recorded; the contract still executes as L1 |

`--verify-level L2` (or `verify.level: "L2"`) turns L2 on explicitly. Otherwise
L2 only fires when a **configured** trigger in `verify.triggers` matches one of
the run's signals. **No trigger is a default**: none will become one until an
L1/L2 corpus table exists to justify it. `--no-cross-verify` (or
`verify.crossVerify: false`) keeps L2 off even when a trigger would fire.

L2 is skipped when the contract already came back `failed` — there is nothing for
a second opinion to add to a red build.

### The independent reviewer

When L2 fires, a second agent reviews the result. Selection prefers, in order:

1. a **configured pairing** (`verify.pairings`, e.g. `{ "claude": "codex" }`);
2. a provider that differs in **both harness and vendor** from the producer;
3. a provider that differs in **harness only**;
4. the producer itself — which is reported as `independence: "none"`.

| `independence` | Meaning |
|---|---|
| `harness-and-vendor` | Full independence |
| `harness-only` / `vendor-only` | Degraded, and labelled as such |
| `none` | Only one harness is installed; L2 cannot claim independence |

The reviewer is **always read-only**. No setting can make it writable. The
independence actually reached is recorded: a single-harness machine degrades with
a label and never claims a vendor split it did not have.

A reviewer verdict of `failed` makes the whole verdict `failed`; a reviewer
`unverified` downgrades a `passed` to `unverified`. It never upgrades anything.

## Shadow routing

The router classifies a task, filters the candidate harnesses by capability and
scores them against priors. It is the **lowest rung of the agent ladder**: it
never overrides an explicit `agent.phases` or `--agent`.

```bash
issue-flow routing           # the resolved configuration
issue-flow routing report    # agreement between the selected and the actual harness
```

| `mode` | Behaviour |
|--------|-----------|
| `off` | Records nothing |
| `shadow` (**default**) | Decides, records `selected` and `actual` on the execution record, **changes nothing**. No terminal output outside `--verbose` |
| `recommend` | Reserved — decision surfaced, still not acted on |
| `active` | Reserved — applies only where nothing was configured |

`profile` biases the score: `economy`, `balanced` (default), `quality`, `speed`.

Invariants worth knowing:

- **No I/O.** Classification, filter and score are pure functions; history
  arrives ready-made from the caller.
- **No chain-of-thought.** What is persisted is `reasonCodes`, priors and scores
   — never free text from a model. The codes are `HIGH_PRIOR`,
  `HIGH_HISTORICAL_SUCCESS`, `LOWER_EXPECTED_LATENCY`, `MISSING_CAPABILITY`,
  `PROVIDER_UNAVAILABLE`, `EXPLICIT_CONFIG`, `TIE_BREAK`, `COLD_START`.
- **Permission is not a score dimension.** A candidate never becomes more
  permissive than the configured phase.
- **Cost `unknown` does not score cost.** "Not reported" is not `$0`.

`issue-flow routing report` reads the recorded decisions and reports how often
the shadow choice agreed with what actually ran — which is the data a later
`active` mode would need before it could be trusted.

## Escalation

When repeated attempts fail **the same way**, retrying identically is waste. The
escalation ladder changes one variable at a time instead.

**It is off by default** (`routing.escalation.enabled: false`) and every ceiling
starts at `null`. `--no-escalation` keeps it off explicitly.

### Non-convergence

Non-convergence is detected from `CheckResult` **ids**, never from error text.
The fingerprint is the sorted list of failed check ids; progress is a drop in the
number of failed fatal checks, or a growing diff.

After `minAttemptsBeforeEscalation` attempts (default 2), the run is
non-converged when the fingerprint repeated across the window, or when there was
no progress at all. Anything else is progress, and progress is left alone.

Failures are first classified:

| Class | From | Owner |
|-------|------|-------|
| `availability` | `provider_down`, `provider_crash`, `rate_limit`, `network` | [resilience / failover](resilience.md#provider-failover) — **never** the escalation ladder |
| `environment` | `configuration`, `repository_state`, `authentication`, or a check that could not run | a human |
| `non-convergence` | a fatal check that ran and failed | the ladder below |

### The ladder

```
current → effort → model → harness → review → decompose → blocked
```

**The ladder only climbs.** A rung is skipped when the provider lacks the
capability it needs (no reasoning-effort knob, no model selection, no second
harness installed), and the skip is recorded. `maxRungs` bounds how far it may
go — default `["effort", "model", "harness"]` — and `maxEscalations` (default 2)
bounds how many times it may climb per issue.

`blocked` is terminal, and it is left **only** by a human (`actor: "human"`).

### Ceilings

```json
{
  "routing": {
    "ceilings": {
      "maxCostUsdPerIssue": 12.0,
      "maxDurationMsPerIssue": 7200000,
      "maxExecutionsPerIssue": 40,
      "onCeiling": "block"
    }
  }
}
```

Also available as `--max-cost <usd>` and `--max-duration <seconds>`.

Ceilings are enforced by **Issue Flow**, at a single choke point before each
agent invocation — never delegated to a harness flag, because a runner that
ignores `--max-budget-usd` still has to stop. Hitting one sets the issue to
`blocked` with a `stopReason` of `max_cost`, `max_duration` or `max_attempts`.

**Cost `unknown` does not consume the cost ceiling.** Codex, Cursor and
Antigravity do not report USD, so a cost ceiling simply does not bind on those
runs — and the verdict says which ceilings *are* in force, so a run is never
silently unbounded without saying so.
