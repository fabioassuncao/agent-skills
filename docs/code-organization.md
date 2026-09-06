# Architecture and code organization

Issue Flow exposes a recommended Agent Skills workflow and an independent,
experimental CLI. This document maps their sources, runtime boundaries and
module responsibilities.

See also [`AGENTS.md`](../AGENTS.md) (index) and
the [Contributing guide](../CONTRIBUTING.md).

## Repository overview

| Location | Responsibility |
|---|---|
| `skills-src/` | Authored Skill entry points, procedures, shared references and resource manifest |
| `skills/` | Committed, self-contained Skill distribution; its README is the user guide |
| `agents/` | Optional host-specific adapters, currently the Claude `resolve-issue` adapter |
| `packages/issue-flow/src/` | CLI implementation and canonical pure rules bundled for Skills |
| `packages/issue-flow/prompts-src/` | Authored CLI prompt templates |
| `packages/issue-flow/prompts/` | Generated, committed CLI runtime prompts |
| `packages/issue-flow/scripts/` | Generation, validation, packaging, smoke and release tooling |
| `packages/issue-flow/web/public/` | Packaged monitoring dashboard |
| `evals/skills/` | Versioned behavioral scenarios |
| `.github/` | Issue and PR templates and CI checks |
| `docs/` | Human-facing guides, references and dated research |

## Generation and runtime boundaries

```text
Skill sources ─────────┐
Shared contracts ──────┼── skills:sync ──┬── skills/<name>/ → current agent
Pure rules/helpers ───┤                └── packaged prompts → CLI runtime
CLI prompt templates ─┘
```

Shared resources are composed at build time. An installed Skill reads its own
bundled instructions and helpers; it does not need this source checkout or the
CLI package. `resolve-issue` bundles phase procedures and runs in the current
agent without requiring subagents. The optional Claude adapter points to that
same Skill rather than owning another workflow.

The CLI loads its own prompts and invokes configured agent processes. It owns
the persistent execution lifecycle: sessions, locks, queues, independent reviewer
routing, recovery and telemetry. It has no runtime dependency on installed Skills.
See [source and distribution](skills.md#source-and-distribution) for generation
ownership and checks; `build` compiles the CLI and does not perform `skills:sync`.

| Interface | Execution and state |
|---|---|
| [Agent Skills](../skills/README.md) | Current host's tools and permissions; artifacts default to the consumer project's `issues/<id>/`; resumption verifies artifacts and Git evidence |
| [CLI](cli.md) | Agent process orchestration; global storage under `~/.issue-flow`, canonical SQLite data and session/telemetry projections |

These are separate lifecycles. Shared task formats do not make sessions
transferable; a run cannot be resumed across interfaces. Skills can optionally
consult an installed CLI for policy discovery, with direct discovery as fallback.
See [Skill limits](../skills/README.md#artifacts-resumption-and-limits) and
[CLI storage](storage.md).

## Directories under `src/`

| Directory | Layer |
|---|---|
| `agents/` | Adapters for external CLIs (Claude, Codex, Cursor, Antigravity) and selection by phase |
| `benchmark/` | Real / synthetic corpus and measurement arms |
| `commands/` | One function per CLI subcommand; thin orchestration only |
| `config/` | Domain-specific configuration loading and overrides, exposed through `config.ts` |
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

## Skill and prompt sources

Portable Skill instructions live in repository-root `skills-src/`. CLI prompt
templates live in package `prompts-src/`. Their committed distributions are
`skills/` and package `prompts/`, respectively. Pure domain rules stay under
`src/`; bundling entry points in `scripts/skill-entries/` package those rules
for independent Skill use. The CLI loads its own packaged resources at runtime.

The [Skill source/artifact contract](skills.md) defines ownership, shared
resources, generation and validation. Follow it when changing a shared rule or
adding a workflow; the [eval guide](skills-evals.md) covers observable behavior.

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
