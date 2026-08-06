# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions refer to the `issue-flow` npm package (`packages/issue-flow`). Releases
that were tagged but never published to the registry are marked as such.

## [Unreleased]

### Added

- **User Story numbering continuity** (issue #36, PR #48) — `plan` no longer
  restarts at `US-001` on every run. The highest `US-NNN` already used anywhere
  in the project is recovered from the global storage and the new plan continues
  from it, so ids no longer collide between issues of the same project.
  - `--start-us <n>` forces a starting number, ignoring history; `--continue`
    names the (already automatic) history-based behavior explicitly. Combining
    both fails with a clear error before anything runs.
  - The decision is always logged and persisted to the project's
    `metadata.json` for audit.

### Changed

- **Behavior change**: `plan` runs on a project that already has plans now start
  above the last used number instead of at `US-001`. Re-running `plan` for the
  same issue is idempotent — the plan it is about to overwrite is excluded from
  the scan. Pass `--start-us 1` to restore the old behavior for a single run.
- A storage failure while scanning the numbering history now aborts with an
  explicit error instead of silently restarting the numbering at `US-001`.

## [0.5.0] - 2026-08-03

### Added

- **Web monitoring** (issue #22, PR #24) — `issue-flow run --web` starts a local
  HTTP server that serves a live dashboard of the running pipeline.
  - `src/core/session-state.ts` and `src/core/session-publisher.ts` — state
    publishing layer writing an atomic `issues/{N}/session.json` snapshot.
  - `src/web/server.ts` — zero-dependency HTTP server with polling endpoint.
  - `web/public/{index.html,app.js,app.css}` — dashboard UI, packaged with the
    CLI and resolved at runtime alongside `prompts/`.
  - Execution instrumentation: current phase, story, active tool, and tracking
    of commits and PRs created during the run.
  - Configuration via CLI flags, environment variables, and `.issue-flow.json`.
- `LICENSE` file (MIT) at the repository root and inside the package — the
  manifest declared MIT but no license file existed.
- `CHANGELOG.md` (this file).

### Changed

- Monitoring is strictly non-invasive: publish failures are swallowed with a
  single warning, a busy port (`EADDRINUSE`) skips the server, and killing the
  server mid-run has no effect on the pipeline. With `--web` off, terminal
  output and behavior are unchanged.
- `PIPELINE_PHASES` declaration simplified in `src/core/pipeline.ts`.
- CI matrix now runs Node 22 and 24, matching `engines.node >= 22.0.0`
  (it was testing Node 18 and 20, which the package does not support).

### Fixed

- `npm version` no longer bumps the manifest without creating a commit and a
  tag. npm only runs its git step when it finds a `.git` directory inside the
  package folder; in this monorepo `.git` is at the root, so the bump was
  silently untagged — the root cause of 0.4.3 and 0.4.4 reaching npm with no
  tag. `preversion`/`postversion` hooks (`scripts/git-version.mjs`) now refuse
  to bump a dirty tree and create the release commit and annotated tag.
- `prepack` and `prepublishOnly` scripts added to the package manifest, so
  `npm publish` always rebuilds `dist/` and gates on lint, typecheck, and tests.
  Previously a stale or missing `dist/` could be published silently.
- Package metadata completed with `author`, `homepage`, and `bugs`.
- `tsconfig.json` no longer declares `declaration`, `declarationMap`, and
  `outDir`, which the tsup-based build (`dts: false`) never used.
- Release documentation in `packages/issue-flow/CONTRIBUTING.md` rewritten: it
  described a `.github/workflows/publish.yml` that had been deleted, so anyone
  following it would push a tag and publish nothing.

## [0.4.4] - 2026-04-01

### Removed

- The `analyze` phase was removed from the pipeline; related documentation
  updated accordingly.

### Documentation

- Added an example of running on the current branch without creating a PR.

## [0.4.3] - 2026-04-01

### Added

- `--no-branch` flag (issue #20): run the pipeline on the current branch
  without creating a new one, with the execution mode persisted in `tasks.json`.
- Configurable pipeline phases in `PipelineManager`.
- Conditional summary output.

### Changed

- Verbosity checks for logging and bottom bar display adjustments.
- Invalid flag combinations are now rejected explicitly.

## [0.4.2] - 2026-04-01

### Fixed

- The version reported by the CLI is now read from `package.json` at runtime
  instead of being hardcoded, so `issue-flow --version` can no longer drift out
  of sync with the published version.

## [0.4.1] - 2026-04-01

> Tagged but **never published to npm**.

### Fixed

- Duplicate `execute` output (issue #17): direct stderr writes were removed from
  the executor and all output routed through the output callback.
- Non-TTY / CI output verified to remain readable.

## [0.4.0] - 2026-04-01

### Added

- Terminal UI redesigned around listr2 (issue #15): single-writer pipeline
  progress display, execute-phase subtask progress, and CI-friendly fallback
  rendering for non-interactive environments.

### Changed

- Output routing consolidated in `core/engine.ts`; verbose mode kept compatible
  with the new renderer.

### Removed

- `PipelineTracker`, superseded by the new progress display.
- `.github/workflows/publish.yml` — automated npm publishing was dropped in
  favor of a manual release flow. (The documentation was not updated at the
  time; this was corrected in 0.5.0.)

## [0.3.1] - 2026-04-01

### Changed

- Formatting and type-safety improvements in the CLI and headless modules.

## [0.3.0] - 2026-04-01

First release published to npm under the `issue-flow` name.

### Added

- Subcommand architecture for the CLI: `init`, `generate`, `analyze`, `prd`,
  `plan`, `execute`, `review`, `pr`, and the `run` full-pipeline orchestrator.
- `core/headless.ts` — typed wrapper for Claude Code Headless invocations.
- `core/pipeline.ts` — pipeline state machine with resume support.
- Zod validation schemas for headless outputs and pipeline state.
- Global `--timeout` and `--verbose` options.
- Biome for formatting, linting, and import organization.
- CI workflow (`.github/workflows/ci.yml`).
- `CONTRIBUTING.md` with development and publishing instructions.

### Changed

- Package renamed from `ralph-agent` to `issue-flow`.
- Node.js requirement raised to `>= 22.0.0`.

### Removed

- The Ralph pattern and `ralph.sh`; prompts unified under Issue Flow.
- Obsolete marketplace and plugin configuration files.

## [0.2.0] - 2026-03-19

> Skills-only release, predating the npm package. **Never published to npm.**

### Added

- Skills for the full issue lifecycle: `analyze-issue`, `generate-prd`,
  `convert-prd-to-json`, `execute-tasks`, and the `resolve-issue` orchestrator.
- `ralph.sh` for autonomous task execution, with dependency validation,
  Bash version checks, a portable shebang, and remote execution support.

### Changed

- Project renamed from `agent-skills` to `issue-flow`.

## [0.1.0] - 2026-03-18

> Skills-only release, predating the npm package. **Never published to npm.**

### Added

- Initial set of Claude Code Agent Skills, including issue generation with
  environment validation, language detection, and scope control.
- Installation documentation via `skills.sh` and manual setup.

[0.5.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.5.0
[0.4.4]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.4.4
[0.4.3]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.4.3
[0.4.2]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.4.2
[0.4.1]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.4.1
[0.4.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.4.0
[0.3.1]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.3.1
[0.3.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.3.0
[0.2.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.2.0
[0.1.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.1.0
