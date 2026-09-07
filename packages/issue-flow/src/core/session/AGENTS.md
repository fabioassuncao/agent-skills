# src/core/session

Contract, pure reducer and publishers for the live session snapshot. This
directory owns the shape every surface reads — the terminal status view, the
web dashboard, and resume.

## Boundary with `session-*.ts` in `core/`

| Location | Role |
|---|---|
| `session/` (this directory) | Event/snapshot contract, pure `reduceSessionEvent`, publishers |
| `core/session-publisher.ts` | Process-wide slot for the active publisher (`get`/`set`) |
| `core/session-git.ts` | Collects git/repo state and publishes `git:update` |
| `core/session-metrics.ts` | Publishes `metrics:update` and holds process usage counters |
| `core/session-state.ts` | Façade: re-exports this directory's public surface for existing call sites |

Dependency direction: the `session-*.ts` instrumentation modules **consume**
this contract (publish events, read snapshots). They do not define the
reducer or the snapshot shape. `session-publisher.ts` imports
`NullPublisher` from `session/publishers.ts`, not from the façade — that
avoids treating the façade as the home of the class.

## Module map

| File | Contents |
|---|---|
| `events.ts` | `SessionEvent` union, status types, `DEFAULT_*`. No imports from within `session/`. Type-only imports from package-level type modules only (`types`, `telemetry/types`, `resilience/errors`) so the payload keeps identity with `UserStory` / `ExecutionRecord` / `FailureKind`. |
| `snapshot.ts` | Snapshot interfaces, `empty*`, `createInitialSnapshot` |
| `derive.ts` | Pure derivations (`accumulate`, `reported`, `deriveStoryStatus(es)`, …) |
| `reducer.ts` | `reduceSessionEvent`, exhaustive `applyEvent` dispatch, re-exports stage helpers |
| `reducer-*.ts` | Cases by area (session, phase, story, metrics, git, log, resilience) |
| `reducer-stage.ts` | `isTerminalStage`, `transitionStory`, `deriveStageOnStoriesUpdate` |
| `publishers.ts` | `SessionPublisher`, `NullPublisher`, `MemoryPublisher` |

Adding a `SessionEvent` member without a matching case must fail
`tsc --noEmit`: each area function takes a subtype of the union and the
dispatch / area `default` branches use `never`.

## Invariants

The reducer contract — purity, `stories:update` rebuild, derived fields after
`applyEvent`, stage accumulation inside cases, metric scopes — is documented
in [`../AGENTS.md`](../AGENTS.md) under "Reducer contract (`applyEvent`)".
Do not weaken those rules when editing an area file.

Atomic writes go through `utils/fs.writeFileAtomic`. Domain modules do not
keep a private copy.
