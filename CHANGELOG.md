# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions refer to the `issue-flow` npm package (`packages/issue-flow`). Releases
that were tagged but never published to the registry are marked as such.

Entries for 0.5.1 through 0.8.0 were reconstructed from the commit history after
the fact, so they list what changed rather than explaining why. Everything from
0.9.0 onwards was written at release time.

## [Unreleased]

### Fixed

- **A headless timeout was reported as `claude exited with code 143`, and cost
  the phase every retry it had** (#72). `runHeadless()` runs execa with
  `reject: false`, so a timeout *resolves* instead of throwing — the `catch`
  block never saw one, and the only other check looked for `signalName`, a
  property execa 9 does not have. Detection now reads the finished result and
  covers all three shapes it arrives in (`timedOut: true`,
  `signal: SIGTERM/SIGKILL`, or a bare 143/137 exit code left behind by a CLI
  that handles the signal itself), guarded by the elapsed time so an unrelated
  external kill is not relabelled. The message keeps the words `timed out`,
  which is what `isTransientFailure()` matches on, so the phase gets its three
  attempts back — and now says how to raise the limit.

### Changed

- **One timeout for every single-invocation phase, raised to 15 minutes**
  (#72). `analyze`, `prd`, `plan`, `review`, `pr` and `generate` each carried a
  literal `300_000`, `pr-review` carried `900_000`, and the README documented a
  third number. They now share `DEFAULT_HEADLESS_TIMEOUT_MS`, so `--timeout`
  still wins and `--timeout 0` still means no limit. The `execute` loop remains
  the deliberate exception, with no limit at all, because its iteration budget
  is what bounds it.

## [0.11.0] - 2026-08-29

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

## [0.8.0] - 2026-08-04

### Added

- Kanban view of the user stories in the web monitor (issue #31, PR #47)

## [0.7.7] - 2026-08-04

### Added

- US-007 - Cobertura de testes dos cenarios de instancia unica
- US-002/US-003/US-004/US-005/US-006 - Servidor web desacoplado, multi-sessao e modo legado
- US-001 - Lock/PID file com detecção de instância viva

### Fixed

- OnSignal deve chamar handle.close para incluir cleanup de lock/poller

### Changed

- US-008 - Atualizar Web Monitoring com o modelo de instancia unica

## [0.7.6] - 2026-08-04

### Added

- US-003 - Estender card de User Stories com status, progresso e dependencias
- US-002 - Adicionar card Repositorio ao painel
- US-001 - Adicionar card Resumo da Issue ao painel

### Fixed

- Usar checagem explícita de null/undefined para story.status

### Changed

- US-004 - Atualizar Web Monitoring com os novos cards do painel

## [0.7.5] - 2026-08-04

### Added

- US-006 - Documentacao do formato do snapshot e nao-regressao
- US-005 - Publicar a secao repository no snapshot
- US-004 - Publicar a secao issue enriquecida no snapshot
- US-003 - Semear as user stories do tasks.json existente no inicio da sessao
- US-002 - Expor status e dependencies no SessionStorySnapshot com derivacao no reducer
- US-001 - Estender o schema de user story com status e dependencies

### Fixed

- Strip embedded credentials from published repository.remoteUrl

## [0.7.4] - 2026-08-04

### Fixed

- Update @biomejs/biome version in package.json and package-lock.json to 2.4.10 and 0.27.7 respectively

## [0.7.3] - 2026-08-04

### Added

- US-012 - Retrocompatibilidade e não-regressão
- US-011 - Documentação dos novos campos e limitações
- US-010 - Tokens e tempo no painel web
- US-009 - Tokens e custo no terminal
- US-008 - Métricas por story persistidas em tasks.json
- US-007 - Métricas por iteração e por story na fase execute
- US-006 - Fases de invocação única publicam suas métricas
- US-004 - Evento metrics:update e sua redução
- US-005 - Campos de métricas no SessionSnapshot e schema em lockstep
- US-003 - Instrumentar executor.ts (fase execute)
- US-002 - headless.ts passa a capturar métricas corretamente
- US-001 - Parser único de métricas do CLI (core/metrics.ts)

### Changed

- Update README and CLAUDE.md to clarify per-story attribution and usage counters
- CLAUDE.md de src/core com contratos do redutor e do executor

## [0.7.2] - 2026-08-04

### Added

- US-011 - Documentação e .gitignore
- US-010 - Suíte de testes no novo layout, incluindo cenário real de migração
- US-009 - Eliminar getIssueDir() e travar a regra por teste
- US-008 - Migrar LocalFileIssueProvider
- US-007 - Migrar resolvePaths() / execute
- US-006 - Migrar run e o FilePublisher
- US-005 - Migrar review, pr e pr-review
- US-004 - Migrar analyze, prd e plan
- US-003 - Fases headless conseguem escrever fora do repositório
- US-002 - Aviso de migração visível ao usuário
- US-001 - Resolver central de paths de issue com migração automática

### Fixed

- LocalFileIssueProvider.isAvailable() não deve criar diretório global

## [0.7.1] - 2026-08-04

### Added

- US-009 - Implementa correção de revisão e persistência de resultados
- US-008 - Documentacao da nova estrutura
- US-007 - Compatibilidade e migracao nao destrutiva
- US-006 - loadGlobalConfig() e precedencia documentada
- US-005 - Schemas Zod de storage
- US-004 - Resolucao centralizada de paths de issue
- US-003 - Geracao deterministica de project-id
- US-002 - Leitura normalizada do remote git
- US-001 - Resolucao do diretorio global com override por env var

### Fixed

- Elimina segunda chamada a getRemoteUrl em migrateLegacyStorage

### Changed

- Atualiza plano e progresso da issue 32 (US-002)

## [0.7.0] - 2026-08-03

### Added

- US-014 - Documentacao e validacao final
- US-013 - Skill review-pr e registro no agente
- US-012 - Configuracao prReview em .issue-flow.json
- US-011 - Superficies de UI e monitoramento
- US-010 - Correcao do gh pr list --head vazio
- US-009 - Integracao com o comando run
- US-008 - Registro na CLI
- US-007 - Comando issue-flow pr-review [pr]
- US-006 - Prompt pr-review.md
- US-005 - Parser, relatorio e indice estruturado
- US-004 - Descoberta automatica do Pull Request
- US-003 - A fase pr persiste o Pull Request criado
- US-002 - Estado retrocompativel em tasks.json
- US-001 - Conjunto de fases da pipeline com pr-review

### Changed

- Update .gitignore to exclude issues and node_modules directories
- Remove obsolete results.json file from vitest directory
- Clarify read-only nature of PR review phase and update documentation
- Remove arquivos obsoletos da issue 25, incluindo .last-branch, prd.md, progress.txt e tasks.json
- Marca fase review como concluida na issue 25
- Marca US-013 como concluida e registra progresso
- Marca US-012 como concluida e registra progresso
- Marca US-011 como concluida e registra progresso
- Consolida padroes de teste e narrowing no progresso da issue 25
- Marca US-008 como concluida e registra progresso
- Marca US-006 como concluida e registra progresso
- Marca US-004 como concluida e registra progresso
- Marca US-003 como concluida e registra progresso
- Marca US-002 como concluida e registra progresso
- Marca US-001 como concluida e registra progresso
- Unify issue directory resolution across commands

## [0.6.0] - 2026-08-03

### Added

- US-015 - Documentacao e validacao final
- US-014 - Prova executavel de extensibilidade
- US-013 - Skill generate-local-issue
- US-012 - generate multi-destino
- US-011 - init nao bloqueia quando a origem e local
- US-008 - Migracao atomica dos cinco templates de prompt
- US-010 - run resolve uma vez e delega fechamento ao provider
- US-009 - Comandos da pipeline consomem resolveIssue
- US-007 - IssueResolver com matriz de cenarios
- US-006 - Configuracao de providers em .issue-flow.json
- US-005 - LocalFileIssueProvider
- US-004 - GitHubIssueProvider
- US-003 - Interface IssueProvider e registry
- US-002 - Schema de metadados e afrouxamento do taskPlanSchema
- US-001 - Modelo de dominio Issue e hash de conteudo

### Changed

- Remove deprecated files and finalize issue 23
- Marca review da issue 23 como concluido
- Consolida padroes da issue 23 (skills e flags de CLI)
- Atualiza plano e progresso da issue 23 (US-008/009/010)

## [0.5.2] - 2026-08-03

### Fixed

- Expõe monitor --web em 0.0.0.0 e adiciona retry às fases do pipeline

### Changed

- Delete obsolete files related to issue #22

## [0.5.1] - 2026-08-03

### Changed

- Version-only release: the tag carries nothing but the manifest bump. It exists
  because the 0.5.0 publish had already been made and the version had to move on.

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

[0.11.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.11.0
[0.10.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.10.0
[0.9.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.9.0
[0.8.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.8.0
[0.7.7]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.7
[0.7.6]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.6
[0.7.5]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.5
[0.7.4]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.4
[0.7.3]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.3
[0.7.2]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.2
[0.7.1]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.1
[0.7.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.0
[0.6.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.6.0
[0.5.2]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.5.2
[0.5.1]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.5.1
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
