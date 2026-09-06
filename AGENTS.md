# Issue Flow

Portable Agent Skills and an independent experimental CLI that take an issue —
from GitHub or from files — from statement to reviewed Pull Request. CLI
harnesses and Skill host compatibility are documented separately below.

This file is an **index**. It holds no rule, command or convention of its own —
those live in the documents referenced below, which are the source of truth.

> Document once. Reference everywhere it is needed.

## Start here

- [`README.md`](README.md) — what the tool does, how the pipeline works, and the
  entry point to every other document
- [`skills/README.md`](skills/README.md) — recommended Skill workflow, installation,
  first issue, capabilities and execution boundaries
- [`docs/cli.md`](docs/cli.md) — experimental CLI setup, usage and reference map
- [`docs/project-status.md`](docs/project-status.md) — what "experimental" means
  here: how the project was built, the risks, where it should not be used yet,
  and token consumption
- [`docs/commands.md`](docs/commands.md) — every command and flag, and the exit
  codes
- [`docs/configuration.md`](docs/configuration.md) — the precedence ladder,
  `.issue-flow.json`, `~/.issue-flow/config.json` and every environment variable
- [`docs/agents.md`](docs/agents.md) — Claude, Codex, Cursor and Antigravity:
  selection by phase, authentication, permission, token economy, troubleshooting
- [`docs/issues.md`](docs/issues.md) — GitHub and local providers, conflict
  resolution, hierarchy discovery and multi-issue queues
- [`docs/storage.md`](docs/storage.md) — the global tree, the project id, the
  project registry, `tasks.json`, `session.json`, telemetry and the legacy migration
- [`docs/web-monitor.md`](docs/web-monitor.md) — the dashboard, its HTTP API, the
  single-instance server and serving several projects at once
- [`docs/resilience.md`](docs/resilience.md) — failure taxonomy, retry table,
  failover, watchdog, journal and decomposition
- [`docs/verification.md`](docs/verification.md) — the acceptance contract, the
  independent reviewer, shadow routing and escalation
- [`docs/runtime.md`](docs/runtime.md) — the three runtime modes (`headless`,
  `interactive`, `sandbox`): what each one isolates, how an agent in a pane is
  observed, and what a teardown is allowed to remove
- [`docs/sandbox-security.md`](docs/sandbox-security.md) — what the `sandbox` mode
  protects against and what it does not, the launch flags, credential handling and
  the two images
- [`docs/conventions.md`](docs/conventions.md) — how conventions are discovered,
  the precedence ladder, the defaults, and the `AGENTS.md` / `CLAUDE.md` policy
- [`docs/git-conventions.md`](docs/git-conventions.md) — branches, commits and
  Pull Request titles; provider-independent by construction
- [`docs/skills-and-agents.md`](docs/skills-and-agents.md) — how a person uses the
  Skills from an agent, and what each one expects
- [`docs/skills.md`](docs/skills.md) — Skill sources, artifacts, sync and validation
- [`docs/skills-compatibility.md`](docs/skills-compatibility.md) — official host support
- [`docs/skills-evals.md`](docs/skills-evals.md) — behavioral scenarios and evidence
- [`docs/provenance.md`](docs/provenance.md) — every unit absorbed from WebMux, with
  origin, commit and strategy; the frozen upstream baseline lives here
- [`docs/absorption-trace.md`](docs/absorption-trace.md) — the behavioural chain per
  ported module: original, existing behaviour, adaptations, what was deliberately not
  ported, and the parity tests

## Research

Investigations that produced knowledge rather than rules. They are dated,
because what they describe changes in weeks, and they are evidence for
decisions — never a source of truth for behaviour.

- [`docs/research/2026-08-30-multi-harness-orchestration.md`](docs/research/2026-08-30-multi-harness-orchestration.md)
  — the multi-harness orchestration landscape, the gap between configurable and
  adaptive selection, and the target architecture behind the routing,
  verification and escalation issues
- [`docs/research/2026-08-30-harness-baseline.md`](docs/research/2026-08-30-harness-baseline.md)
  — latency baseline (before table) for instrumentation `#79`; phases 3–4 are `#89`
- [`docs/research/2026-09-05-skills-portability.md`](docs/research/2026-09-05-skills-portability.md)
  — complete Skill audit, architecture and measured validation

- [`docs/research/2026-09-05-shared-workflow-contracts.md`](docs/research/2026-09-05-shared-workflow-contracts.md)
  — Skills/CLI audit, external comparisons, shared contracts and benchmark

- [`docs/research/2026-09-05-context-engineering.md`](docs/research/2026-09-05-context-engineering.md)
  — prompt/context audit, correction-state fixes, measurements and behavioral limits

- [`docs/research/2026-09-06-agent-skills-audit.md`](docs/research/2026-09-06-agent-skills-audit.md)
  — Agent Skills refactor, Skill Creator/Ralph comparison, triggering holdout and comparative eval harness

- [`docs/research/2026-09-06-webmux-absorption.md`](docs/research/2026-09-06-webmux-absorption.md)
  — WebMux absorption plan: measured critical path, agent wrappers, worktree/tmux/sandbox
  architecture, Git-convention findings and the phased port roadmap
  — its executable companion is
  [`docs/research/2026-09-06-webmux-absorption-prompt.md`](docs/research/2026-09-06-webmux-absorption-prompt.md),
  the master prompt that drives the port one phase at a time
  — and its follow-up,
  [`docs/research/2026-09-06-webmux-parity-completion-prompt.md`](docs/research/2026-09-06-webmux-parity-completion-prompt.md):
  the mutation routes the absorption never wrote, which is why several ported
  dialogs are unreachable, plus how to close them and how to measure parity
  against the screen rather than against the modules

- [`docs/research/2026-09-06-graph-repos-deep-dive.md`](docs/research/2026-09-06-graph-repos-deep-dive.md)
  — deep dive into four "graph" repositories (Awesome-Graph-Engineering, RepoGraph,
  agent-graph, GraphCode): what each one actually is, component-level absorption verdicts,
  licence constraints (including a dual MIT/FSL boundary), and the seven pieces worth
  incorporating now; evidence for `#116` and `#125`

## Developing

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — environment, issue-to-PR contribution
  workflow, validation and documentation ownership
- [`packages/issue-flow/CONTRIBUTING.md`](packages/issue-flow/CONTRIBUTING.md) —
  local CLI testing, packaging and the release process
- [`docs/code-organization.md`](docs/code-organization.md) — architecture, generation and
  runtime boundaries, code responsibilities and placement conventions

## The modules that carry their own rules

Each of these documents the invariants of one area. Read the one covering what
you are about to change — they exist because the constraint was not obvious from
the code, and was learned the hard way.

| Area | Document |
|---|---|
| Skill sources and generated distribution | [`skills-src/AGENTS.md`](skills-src/AGENTS.md), [`skills/AGENTS.md`](skills/AGENTS.md) |
| The agent layer (Claude / Codex / Cursor / Antigravity, selection by phase) | [`packages/issue-flow/src/agents/AGENTS.md`](packages/issue-flow/src/agents/AGENTS.md) |
| Phase commands, publication order, the multi-issue queue | [`packages/issue-flow/src/commands/AGENTS.md`](packages/issue-flow/src/commands/AGENTS.md) |
| The execute loop, the session snapshot, metrics | [`packages/issue-flow/src/core/AGENTS.md`](packages/issue-flow/src/core/AGENTS.md) |
| The session event contract, its reducers and the snapshot | [`packages/issue-flow/src/core/session/AGENTS.md`](packages/issue-flow/src/core/session/AGENTS.md) |
| Configuration loading, one file per domain | [`packages/issue-flow/src/config/AGENTS.md`](packages/issue-flow/src/config/AGENTS.md) |
| Default taxonomy and git naming (branch / commit / PR) | [`packages/issue-flow/src/conventions/AGENTS.md`](packages/issue-flow/src/conventions/AGENTS.md) |
| Multi-issue queue plan, confirm and order | [`packages/issue-flow/src/execution/AGENTS.md`](packages/issue-flow/src/execution/AGENTS.md) |
| Issue model, providers, resolver, relation graph, and GitHub Pull Request / CI reading | [`packages/issue-flow/src/issues/AGENTS.md`](packages/issue-flow/src/issues/AGENTS.md) |
| Execution telemetry and compatibility projections | [`packages/issue-flow/src/telemetry/AGENTS.md`](packages/issue-flow/src/telemetry/AGENTS.md) |
| Convention discovery and resolution | [`packages/issue-flow/src/policy/AGENTS.md`](packages/issue-flow/src/policy/AGENTS.md) |
| Git conventions (branch, commit, PR title) | [`docs/git-conventions.md`](docs/git-conventions.md) |
| Failure taxonomy and retry policy | [`packages/issue-flow/src/resilience/AGENTS.md`](packages/issue-flow/src/resilience/AGENTS.md) |
| Plan-then-apply repository scaffold | [`packages/issue-flow/src/scaffold/AGENTS.md`](packages/issue-flow/src/scaffold/AGENTS.md) |
| Global storage and artifact paths | [`packages/issue-flow/src/storage/AGENTS.md`](packages/issue-flow/src/storage/AGENTS.md) |
| Shared process / git / fs primitives | [`packages/issue-flow/src/utils/AGENTS.md`](packages/issue-flow/src/utils/AGENTS.md) |
| Runtime modes (headless / interactive / sandbox) | [`packages/issue-flow/src/runtime/AGENTS.md`](packages/issue-flow/src/runtime/AGENTS.md) |
| Worktree isolation, its binding and its rollback | [`packages/issue-flow/src/runtime/worktree/AGENTS.md`](packages/issue-flow/src/runtime/worktree/AGENTS.md) |
| The tmux multiplexer: sessions, windows, panes and the two defences | [`packages/issue-flow/src/runtime/tmux/AGENTS.md`](packages/issue-flow/src/runtime/tmux/AGENTS.md) |
| The Docker sandbox: the container per branch and its exact `docker run` args | [`packages/issue-flow/src/runtime/sandbox/AGENTS.md`](packages/issue-flow/src/runtime/sandbox/AGENTS.md) |
| Getting text into an agent running as a TUI | [`packages/issue-flow/src/runtime/terminal/AGENTS.md`](packages/issue-flow/src/runtime/terminal/AGENTS.md) |
| The link between a conversation and what it is for | [`packages/issue-flow/src/agents/session/AGENTS.md`](packages/issue-flow/src/agents/session/AGENTS.md) |
| What one phase hands to the next | [`packages/issue-flow/src/agents/handoff/AGENTS.md`](packages/issue-flow/src/agents/handoff/AGENTS.md) |
| The monitoring server | [`packages/issue-flow/src/web/AGENTS.md`](packages/issue-flow/src/web/AGENTS.md) |
| The monitoring dashboard | [`packages/issue-flow/web/AGENTS.md`](packages/issue-flow/web/AGENTS.md) |
| Terminal output (clean view, icon grammar) | [`packages/issue-flow/src/ui/AGENTS.md`](packages/issue-flow/src/ui/AGENTS.md) |
| Acceptance contract and independent review | [`packages/issue-flow/src/verify/AGENTS.md`](packages/issue-flow/src/verify/AGENTS.md) |
| Shadow routing | [`packages/issue-flow/src/routing/AGENTS.md`](packages/issue-flow/src/routing/AGENTS.md) |
| Real / synthetic benchmark | [`packages/issue-flow/src/benchmark/AGENTS.md`](packages/issue-flow/src/benchmark/AGENTS.md) |

## Agent entry points

`AGENTS.md` is the canonical entry point, at every level of this repository.
`CLAUDE.md` exists only at the root, as the Claude Code bridge, and holds one
line. The policy — and what does not belong in an `AGENTS.md` — is in
[`docs/conventions.md`](docs/conventions.md#agent-entry-points).

## What does not belong in this file

Anything that can live in a document of its own: build and test commands, code
style, architecture rules, testing strategy, operational procedures.

An instruction that today exists **only** here does not stay here: move it to the
right document and leave a reference behind. Duplicated instructions in an agent
file age out of sight and start contradicting the source without anyone noticing.
