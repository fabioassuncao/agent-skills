# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions refer to the `issue-flow` npm package (`packages/issue-flow`). Releases
that were tagged but never published to the registry are marked as such.

## [Unreleased]

### Added

- **Convention-aware initialization** — Issue Flow now works predictably both in
  repositories that already have conventions and in ones that have none.
  - **A documented default convention set** (`src/conventions/defaults.ts`,
    [`docs/conventions.md`](docs/conventions.md)): six issue types (Idea,
    Research, Epic, Feature, Bug, Task — the last three being GitHub's own
    defaults), a small cross-cutting label vocabulary, and an explicit list of
    what is deliberately *not* a type. It applies only where the repository, its
    organization and the user's configuration are all silent.
  - **`issue-flow init` now reports and can create what a repository is
    missing**: `--apply` writes, `--json` emits the plan, `--scope` resolves a
    monorepo subdirectory, `--check-only` restores the old prerequisites-only
    behavior. The convention half never changes the exit code, so a script that
    treats `init` as a prerequisite gate is unaffected.
  - **The `init-repository` skill** drives the same core through
    `issue-flow init --json` rather than re-deriving the analysis, so both
    interfaces produce the same plan.
  - Initialization is **non-destructive and idempotent**: nothing that exists is
    ever overwritten, existence is re-checked immediately before each write, and
    a second run writes nothing.
  - **`AGENTS.md` is established as the canonical agent entry point** and
    `CLAUDE.md` as a one-line bridge to it. Scaffolding generates both that way,
    and a repository whose `CLAUDE.md` carries its own instructions is reported
    for a human decision — promoting it means moving text somebody wrote, which
    is never automatic.

### Fixed

- **Organization-published Issue Forms were invisible.** GitHub's
  `issueTemplates` GraphQL connection only returns *markdown* templates, so a
  repository whose organization publishes `.yml` Issue Forms looked like a
  repository with no templates at all — and would have been given a local copy of
  the organization's. Discovery now also reads the organization's `.github`
  repository tree, in a single call that returns names and contents together.

- **The repository policy reaches the flows** (issues #57, #58, #59, #60, #61).
  v0.10.0 shipped the discovery layer with no consumers; this connects it.
  - **Projection into the prompts and per-repository overrides** (#57): the
    `__REPO_*` placeholders carry a *summary* of the policy, budgeted by
    `policy.contextBudget` (default 1500 tokens) and degrading a whole section to
    a pointer rather than truncating mid-rule. `__REPO_DOCS__` carries **paths,
    never content** — the agent has `Read`, and embedding documents would
    multiply the cost of every run. A repository may now adjust any prompt via
    `.issue-flow/prompts/<name>.append.md` (recommended) or `<name>.md`
    (replacement, which makes the repository inherit that prompt's maintenance).
  - **Issue creation aware of templates, types and labels** (#58): the
    applicable Issue Template defines the body; Issue Types are passed with
    `--type`; the title follows the repository's convention, with no textual
    prefix when the repository uses Issue Types.
  - **Reviews validate conformance** (#60): `review` and `pr-review` gain an
    explicit policy-conformance axis. Every violation cites the document and
    section that defines the rule — a violation without a citation is an opinion
    the author cannot check. Severity is calibrated: a mandatory rule, a missing
    required template field or a wrong base branch blocks; a formatting
    divergence is an observation. `CODEOWNERS` is recorded, never blocked on.
  - **Parity between the Agent Skills and the CLI** (#61): both paths now decide
    from the same resolved policy, through `issue-flow policy --json` — a
    published contract with a `schemaVersion`, since skills are markdown and
    cannot import TypeScript. `skills/_shared/repository-policy.md` is the single
    source every policy-aware skill references rather than reproduces, and a
    parity test fails if one starts deciding differently. The step is
    best-effort by design: without the CLI, the network, or a declared policy,
    every skill continues with its documented defaults.

### Fixed

- **Pull Requests were opened against the wrong base branch** (#59) —
  `prompts/pr.md` hard-coded `main` in `git log main..HEAD`, `git diff
  main...HEAD` and `gh pr create --base main`. In a repository based on
  `develop`, `main` usually **exists** too, so nothing failed: the agent simply
  reviewed the wrong diff and opened the Pull Request against the wrong target.
  The base is now resolved from the repository (`policy.pullRequests.baseBranch`,
  then `origin/HEAD`, then `main`), and the same fix reaches `review-issue`,
  `create-pr`, `review-pr` and the `resolve-issue` agent.
- The branch pattern `issue/{N}-*` is no longer normative in `create-pr`:
  repositories using `feat/`, `fix/`, `docs/` or `chore/` are following a common
  convention, and refusing to open their Pull Requests was the skill's problem.
  The issue number now falls back to a `Closes #N` in the branch's commits and to
  the run in progress before asking.
- The execute loop no longer commits every story as `feat`. When the repository
  declares a commit convention, the type must match the nature of the change: a
  bug fix committed as `feat:` corrupts the changelog and any version bump
  computed from the history.

### Changed

- **Issue Flow no longer creates labels.** A label suggested for an issue that
  the repository does not have is dropped with a warning instead of being
  created. This is a deliberate behavior change: a team that deleted
  `high`/`medium`/`low` in favor of a native priority field, or
  `bug`/`enhancement` in favor of Issue Types, made a governance decision, and
  recreating those labels undoes it silently and repository-wide — worse than a
  failure, because it succeeds. Set `policy.issues.allowLabelCreation: true` to
  restore the previous behavior.
- `mergeConfigLayers()` gained a `discovered` layer, between the defaults and the
  global configuration, so repository-discovered values beat a fallback Issue
  Flow invented and lose to anything the user configured explicitly.

### Compatibility

A repository that declares no policy renders every prompt **byte for byte** as it
did before, which a test pins over every file in `prompts/`. The single
intentional exception is label creation, above.

## [0.10.0] - 2026-08-29

### Added

- **Repository policy discovery and resolution** (issue #56) — a single layer,
  `packages/issue-flow/src/policy/`, that finds what the consumer repository
  already declares about itself, resolves the hierarchy applying to a path, and
  returns one typed `RepositoryPolicy` with the provenance of every value.
  - **Discovers** Issue Templates and Forms (`.github/ISSUE_TEMPLATE/**`,
    `docs/ISSUE_TEMPLATE/**`, the root, plus the single-file `ISSUE_TEMPLATE.md`
    variant of each), the Pull Request template in every layout GitHub supports
    including the directory of several, `AGENTS.md` and `CLAUDE.md` from the
    root down to the scope, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
    `CODEOWNERS`, the labels that really exist (`gh label list`), the
    organization's Issue Types (`gh api orgs/{org}/issue-types`) and the base
    branch (`origin/HEAD`, then a local `main`/`master`).
  - **Organization defaults** come from the GraphQL `issueTemplates` connection,
    consulted only when the local tree has none: a repository with no
    `.github/ISSUE_TEMPLATE/` still serves the organization's on github.com, and
    filesystem discovery cannot see them. REST has no issue-template endpoint at
    all, and the GraphQL connection returns the bodies inline, so the whole
    lookup costs one round-trip.
  - **Documents are followed, not scanned**: the markdown links of `AGENTS.md`
    are walked one level. Scanning `docs/` blindly would pull in changelogs and
    ADR archives the repository never nominated as policy.
  - **Silent degradation is the contract.** A repository declaring none of this
    resolves to an empty policy, with no error and no warning — the exact input
    every flow had before. A missing or unauthenticated `gh`, or no network,
    degrades the same way; `sources` then records the source as `unavailable`,
    which is what distinguishes "declares nothing" from "could not find out".
    Every network call carries a timeout, each kind of data costs at most one
    `gh` invocation, and the resolution is cached once per `(root, scope)`.
  - **Precedence** reuses `mergeConfigLayers()`, which gains a `discovered`
    layer: defaults < discovered < `.issue-flow.json` < `ISSUE_FLOW_POLICY_*` <
    CLI. The new `policy` key declares what discovery cannot infer
    (`issues.titleConvention`, `pullRequests.baseBranch` and
    `titleConvention`, `git.branchConvention` and `commitConvention`) and turns
    off what it gets wrong (`discovery.*`); `policy.enabled: false` returns
    before a single `stat()` or network call.
  - **New command** `issue-flow policy [--scope <dir>] [--json]` prints the
    resolved policy and its provenance. It is the debugging surface and the
    bridge to the Agent Skills, which are markdown and cannot import TypeScript
    — hence the `schemaVersion` stamped on the JSON payload rather than on the
    CLI.

  Fully additive: no prompt, skill or phase consumes the layer yet, and no
  observable behavior changes. An `.issue-flow.json` without the `policy` key
  stays valid.

## [0.9.0] - 2026-08-20

### Added

- **Multiple issues and hierarchies in the pipeline** (issues #50, #51, #52, #53).
  - Hierarchy and dependency **discovery** (#50): `IssueProvider.fetchRelations?`
    plus a GitHub implementation reconciling the Sub-issues API, the Issue
    Dependencies API (`blocked_by`/`blocking`), timeline cross-references and a
    documented textual heuristic over the issue body. `buildDependencyGraph`
    walks it breadth-first with configurable node/depth limits and records
    cycles instead of throwing.
  - **Ordered plan and confirmation** (#51): `issue-flow run` accepts `42,43,50`
    and `42 43 50`; when a larger structure is found the run stops before any
    phase, shows the suggested order and offers "only what I informed" / "the
    whole hierarchy" / "cancel". `--yes` and `--only` answer it non-interactively
    (outside a TTY one of them is required). The order respects dependencies →
    hierarchy → priority labels → issue number, and a dependency cycle is an
    explicit error.
  - **Sequential execution on one branch** (#52): the whole queue runs in a
    single process, sharing one branch, with commits scoped per issue
    (`feat(issue-51): …`), per-issue token/cost accounting, and resume from the
    issue that failed without redoing the ones already completed. Queue state
    lives in `~/.issue-flow/projects/<id>/queues/<queue-id>/execution-plan.json`.
  - **One consolidated Pull Request** (#53): a single PR for the whole queue,
    with the issues implemented, the execution order, the pending items and one
    `Closes #N` per issue hosted on GitHub. The reference is replicated to every
    issue's `tasks.json`, so `pr-review --issue <any>` still finds it.

- **User Story numbering continuity** (issue #36, PR #48) — `plan` no longer
  restarts at `US-001` on every run. The highest `US-NNN` already used anywhere
  in the project is recovered from the global storage and the new plan continues
  from it, so ids no longer collide between issues of the same project.
  - `--start-us <n>` forces a starting number, ignoring history; `--continue`
    names the (already automatic) history-based behavior explicitly. Combining
    both fails with a clear error before anything runs.
  - The decision is always logged and persisted to the project's
    `metadata.json` for audit.

- **Real-time execution state of User Stories** (issue #38, PR #49) — each entry
  of `stories[]` in the session snapshot now carries `stage`, `stageSince` (ISO
  timestamp of the event that produced the stage) and `stageDetail` (a short
  human string, currently only used by `in_correction`). Where `status` is the
  four-value board summary, `stage` tracks the real pipeline cycle a story goes
  through: `execute` → `review` → correction (when needed) → `done`/`failed`.
  - Stages are set directly by the event that causes the transition, not
    recomputed on every reduction, so `in_correction` survives an unrelated
    `stories:update` in between. `iteration:start` gained an optional `storyId`
    and `correction:cycle` already carried `cycle`/`maxCycles`.
  - `done` and `failed` are the only terminal stages; `session:end` closes
    whatever was still `executing`, `in_review` or `in_correction`.
  - The terminal shows the active story's stage, and the web panel highlights
    the story being executed.

- **Multi-project dashboard in the web monitor** (issue #35, PR #55) — with two
  or more active sessions the monitor's home page becomes a dashboard with one
  card per execution (repository, issue number and title, short description,
  current phase, progress, elapsed time, status, and a live indicator while
  `status` is `running`). Clicking a card opens that session's existing detail
  view; a "Todas as execuções" control returns to the dashboard.
  - With exactly one active session the behavior is unchanged: the monitor opens
    the detail view directly, with no extra click.
  - `GET /api/sessions` was enriched with the card summary fields, so the client
    no longer needs N× `/api/status` fetches just to paint the list.
    `issueDescription` is a whitespace-collapsed preview, not the full body.
  - The mode is re-evaluated on every poll, so a second run started while the
    monitor is already open switches to the dashboard with no manual reload.

### Changed

- `core/session-metrics.ts` keeps a **stack** of usage scopes instead of a single
  module-level accumulator, so several issues can run in one process without
  their costs leaking into each other's summary (the caveat previously
  documented in `src/core/CLAUDE.md`).
- **Behavior change**: `plan` runs on a project that already has plans now start
  above the last used number instead of at `US-001`. Re-running `plan` for the
  same issue is idempotent — the plan it is about to overwrite is excluded from
  the scan. Pass `--start-us 1` to restore the old behavior for a single run.
- A storage failure while scanning the numbering history now aborts with an
  explicit error instead of silently restarting the numbering at `US-001`.

### Compatibility

- A single issue with no discovered relations behaves exactly as before: no
  prompt, no queue artifact, the same commit format and the same Pull Request
  body.
- A run asking for **one** issue never fails because of its hierarchy: a
  dependency cycle discovered around it, or a non-interactive terminal with no
  `--yes`/`--only`, degrades to the plain single-issue pipeline with a warning
  instead of exiting `1`. Only an explicitly multi-issue request is refused.
- `--start-us <n>` applies to the first issue of a queue only; the rest continue
  from the history those plans just wrote.
- A queue that already completed is reported and left untouched, instead of
  being re-planned and overwriting its recorded Pull Request.

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

[0.10.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.10.0
[0.9.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.9.0
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
