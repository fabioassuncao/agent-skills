# Code organization

Where each responsibility lives inside `packages/issue-flow`, and when a
file is already too big. Describes what the repository **already is** —
not an imported architecture.

See also [`AGENTS.md`](../AGENTS.md) (index) and
[`packages/issue-flow/CONTRIBUTING.md`](../packages/issue-flow/CONTRIBUTING.md).

## The seventeen directories under `src/`

| Directory | Layer |
|---|---|
| `agents/` | Adapters for external CLIs (Claude, Codex, Cursor, Antigravity) and selection by phase |
| `benchmark/` | Real / synthetic corpus and measurement arms |
| `commands/` | One function per CLI subcommand; thin orchestration only |
| `conventions/` | Default taxonomy and the only implementation of branch / commit / PR naming |
| `core/` | Execute loop, session snapshot, journal, metrics instrumentation |
| `execution/` | Multi-issue queue plan, confirm, order and live-run registry |
| `issues/` | Origin-agnostic Issue model, providers, resolver and relation graph |
| `policy/` | Discovery of conventions in the **target** repository |
| `resilience/` | Failure taxonomy, retry, failover, watchdog |
| `routing/` | Shadow / active model-aware selection and escalation |
| `scaffold/` | Plan-then-apply initialization that fills gaps, never overwrites |
| `storage/` | Global tree (`~/.issue-flow`), artifact paths, legacy migration |
| `telemetry/` | Execution history written to canonical SQLite storage and materialized into compatibility projections |
| `ui/` | Terminal output (clean view, icon grammar, pipeline renderer) |
| `utils/` | Shared process / git / fs primitives with no domain rules |
| `verify/` | Acceptance contract and independent reviewer |
| `web/` | Monitoring HTTP server (the dashboard assets live in `web/public/`) |

Root files next to those directories (`cli.ts`, `config.ts`, `types.ts`,
`schemas.ts`, …) are package entry points or cross-cutting contracts.
`config.ts` is a façade over `src/config/` (one loader file per domain).

## Where new code goes

- A helper with **no domain dependency** → `utils/` (`shell.ts`, `git.ts`,
  `fs.ts`). Never inline `gh`, `git` or agent CLI invocations inside a
  command.
- A **domain rule** → the directory of that domain. Prefer extending an
  existing file over inventing a sibling that always changes with it.
- An **adapter for an external process** → behind a named function in
  `utils/` or in the domain adapter (`agents/`, `issues/providers/`),
  never as a raw string command in `commands/`.
- A **CLI subcommand** → one file (or small folder) under `commands/`.
  Orchestration stays thin; logic belongs in `core/`, `execution/`,
  `issues/`, etc.
- A **configuration domain** → its own loader under `config/`, with its own
  `set*CliOverrides` and mutable state. Domains do not import each other.

## Size as a signal, not a hard rule

- A production file above ~500 lines, or a function above ~80–100 lines,
  asks for a reason — usually mixed responsibilities.
- Split by **responsibility**, not by line count. Do not create a file for
  a single export, and do not slice a unit that always changes together.
- Tests may be larger than the module they cover; prefer colocated
  `*.test.ts` next to the module, split when the subject splits.

## What not to do

- Do not invent a new layer directory (`services/`, `adapters/`,
  `use-cases/`) for its own sake.
- Do not introduce a DI container or a generic pipeline executor.
- Do not add barrel `index.ts` re-export files. Imports use explicit
  paths with the `.js` extension (ESM / NodeNext). Façades that preserve
  existing call sites (`run.ts`, `config.ts`, `session-state.ts`) are the
  exception, and they only re-export.
- Move and change behaviour in **separate commits**. Behaviour is
  contract: `tasks.json`, `session.json`, `.issue-flow.json`, environment
  variables and documented exit codes do not change under a refactor.

## Tooling

Biome covers `src/**/*.ts`, `web/public/**/*.js`, `scripts/**/*.mjs` and
`*.config.ts`. `npm run check` is read-only and matches the CI gate;
`npm run fix` applies Biome writes and then typechecks.
