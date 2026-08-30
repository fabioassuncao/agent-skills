# Issue Flow

CLI and Agent Skills that take a GitHub issue from statement to merged Pull
Request, through Claude Code.

This file is an **index**. It holds no rule, command or convention of its own —
those live in the documents referenced below, which are the source of truth.

> Document once. Reference everywhere it is needed.

## Start here

- [`README.md`](README.md) — what the tool does, every command, the file
 structure, the configuration and the web monitor
- [`docs/conventions.md`](docs/conventions.md) — how conventions are discovered,
 the precedence ladder, the defaults, and the `AGENTS.md` / `CLAUDE.md` policy
- [`docs/git-conventions.md`](docs/git-conventions.md) — branches, commits and
 Pull Request titles; provider-independent by construction
- [`docs/agents.md`](docs/agents.md) — Claude Code and Codex CLI: selection by
 phase, authentication, token economy and troubleshooting
- [`docs/skills-and-agents.md`](docs/skills-and-agents.md) — the interactive
 usage model, and the parity contract between the skills and the CLI

## Research

Investigations that produced knowledge rather than rules. They are dated,
because what they describe changes in weeks, and they are evidence for
decisions — never a source of truth for behaviour.

- [`docs/research/2026-08-30-multi-harness-orchestration.md`](docs/research/2026-08-30-multi-harness-orchestration.md)
  — the multi-harness orchestration landscape, the gap between configurable and
  adaptive selection, and the target architecture behind the routing,
  verification and escalation issues

## Developing

- [`packages/issue-flow/CONTRIBUTING.md`](packages/issue-flow/CONTRIBUTING.md) —
  environment, scripts, local testing and the release process

## The modules that carry their own rules

Each of these documents the invariants of one area. Read the one covering what
you are about to change — they exist because the constraint was not obvious from
the code, and was learned the hard way.

| Area | Document |
|---|---|
| The agent layer (Claude / Codex, selection by phase) | [`packages/issue-flow/src/agents/AGENTS.md`](packages/issue-flow/src/agents/AGENTS.md) |
| Phase commands, publication order, the multi-issue queue | [`packages/issue-flow/src/commands/AGENTS.md`](packages/issue-flow/src/commands/AGENTS.md) |
| The execute loop, the session snapshot, metrics | [`packages/issue-flow/src/core/AGENTS.md`](packages/issue-flow/src/core/AGENTS.md) |
| Execution telemetry in `tasks.json` | [`packages/issue-flow/src/telemetry/AGENTS.md`](packages/issue-flow/src/telemetry/AGENTS.md) |
| Convention discovery and resolution | [`packages/issue-flow/src/policy/AGENTS.md`](packages/issue-flow/src/policy/AGENTS.md) |
| Git conventions (branch, commit, PR title) | [`docs/git-conventions.md`](docs/git-conventions.md) |
| Failure taxonomy and retry policy | [`packages/issue-flow/src/resilience/AGENTS.md`](packages/issue-flow/src/resilience/AGENTS.md) |
| Global storage and artifact paths | [`packages/issue-flow/src/storage/AGENTS.md`](packages/issue-flow/src/storage/AGENTS.md) |
| The monitoring server | [`packages/issue-flow/src/web/AGENTS.md`](packages/issue-flow/src/web/AGENTS.md) |
| The monitoring dashboard | [`packages/issue-flow/web/AGENTS.md`](packages/issue-flow/web/AGENTS.md) |
| Terminal output (clean view, icon grammar) | [`packages/issue-flow/src/ui/AGENTS.md`](packages/issue-flow/src/ui/AGENTS.md) |

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
