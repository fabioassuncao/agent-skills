# src/verify

Objective acceptance before any LLM judgement. A second model never
substitutes for a command that can fail on its own.

## Invariants

- **A check is a command or an expected file, never prose.** `runContract`
  does not parse model output. A regex over assistant text on this path is
  a bug.
- **Empty contract → `unverified`, not green.** The pipeline continues.
- **Fatal red → `failed`**, classified as `task_execution` (#64). No new
  failure kind.
- **L1 is the default.** L2 only fires on `--verify-level L2` or a
  configured trigger. No trigger is a default until #85 stage 3 publishes
  an L1/L2 table.
- **The independent reviewer is always `read-only`.** No setting can make
  it writable. The independence actually reached is recorded; a single
  harness degrades with a label and never claims a vendor split it did not
  have.
- **Failed-check output is diagnostic data.** `frameCheckOutput` is what
  any later agent is allowed to see. The fixer must not edit the check.
- **Evidence is redacted** (`telemetry/redact.ts`) before it touches disk
  and is keyed by `executionId`.
