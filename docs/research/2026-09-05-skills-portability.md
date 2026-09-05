# Agent Skills portability refactor — 2026-09-05

Dated implementation evidence, not a second source of behavioral rules. The maintained contracts are [user usage](../skills-and-agents.md), [authoring/build](../skills.md), [host compatibility](../skills-compatibility.md) and [evals](../skills-evals.md).

## Baseline and diagnosis

The reviewed baseline is **557bcec**. All ten original Skills, their README files, shared policy/configuration references, Claude orchestrator, relevant CLI prompts, conventions/scaffold/policy modules, tests, packaging and CI were inspected. The [initial per-Skill inventory](2026-09-05-skills-initial-audit.json) records responsibility, triggering, structure, format, resources, scripts, external/CLI/provider dependencies and required corrections. The discarded PR #109 was not used as implementation source.

Every original Skill referenced a sibling `_shared` policy directory. Copying just one directory therefore broke its dependency closure. The shared policy could invoke/download the CLI, and conventions depended on repository files or CLI commands. The init fallback referred outside the artifact. Long entry points mixed procedure and conditional detail; discovery text lacked tested near-neighbor boundaries. The orchestrator was Claude-specific. Conversion mandated handoff; review could publish/close implicitly; execution carried provider-specific instruction-file behavior. Both PR review surfaces requested unsupported `gh pr diff --stat`/file-filter forms.

The CLI already owned its prompts and runtime. Its storage/locks/SQLite were never appropriate dependencies of a portable Skill. Two additional validation gaps emerged during implementation: npm packaging stripped the required `node:` prefix from SQLite, and the existing smoke still asserted against legacy repository-local output paths.

## Architecture before and after

Before: authored `skills/<name>/SKILL.md` → sibling shared Markdown → CLI policy/conventions; a separate Claude subagent implemented the full workflow. CLI prompts and Skill prose could drift. Installer success proved copying, not resource closure.

After:

```text
skills-src/<name> + skills-src/_shared + manifest
                   |
            deterministic sync
                   |
        skills/<name>/SKILL.md
        references/ + bundled scripts/ + licenses

canonical pure CLI modules --+--> compiled CLI
                            +--> bundled Skill helpers
shared prose contracts -----+--> packaged CLI prompts
                            +--> local Skill references
```

All eleven directories are independent distribution units. The new `resolve-issue` carries the phase procedures from the same authored files as standalone Skills and runs in the current agent. `agents/resolve-issue.md` is only an optional Claude preload adapter. Generated artifacts are committed directly, discoverable without a build step or distribution branch. Source `.md.in` files avoid duplicate discovery.

Only actual parity boundaries are shared: Git names/taxonomy, issue parsing/hash, canonical schemas, scaffold renderers, repository decisions, evidence, publication and structured review results. CLI prompt placeholders/overrides and runtime storage remain intact. Skill local plans and CLI global sessions are separate; no cross-surface transfer/resume was introduced.

The bundler now preserves `node:sqlite`; the packed CLI test reproduces the formerly broken load path. The smoke uses disposable global storage and expects an empty acceptance contract to remain unverified. An existing 30 ms heartbeat test was made deterministic using the query clock, with no change to production expiration semantics.

## Reference projects and design choices

| Project | Observed approach | Adopted / rejected for Issue Flow |
|---|---|---|
| [OpenSpec](https://github.com/Fission-AI/OpenSpec/) | Canonical templates, generated committed Skills, generation/parity tests, CLI/tool adapters | Adopted explicit generated artifacts and byte/file-set parity; did not inherit its runtime CLI assumptions or adapter catalogue. See [distribution README](https://github.com/Fission-AI/OpenSpec/blob/main/skills/README.md). |
| [Superpowers](https://github.com/obra/superpowers/) | Focused references, pressure scenarios, baseline→revision testing, bootstrap and sibling workflows | Adopted observable behavioral evals and evidence/feedback discipline; no bootstrap, mandatory subagents, universal TDD or sibling dependency graph. See [writing-skills](https://github.com/obra/superpowers/blob/main/skills/writing-skills/SKILL.md). |
| [Specsfy](https://github.com/promovaweb/specsfy) | Detailed references, setup/installation conventions and reference validation; project context and related Skills | Adopted progressive disclosure and reference checking; did not copy its project-context or sibling-Skill assumptions. |

The normative contract is [Agent Skills](https://agentskills.io/specification). Host-specific extensions are documented in the [official-source matrix](../skills-compatibility.md), not incorporated into canonical frontmatter. Vercel Skills remains the installer, not a new Issue Flow package manager.

## Corrections by Skill

All entries now have validated frontmatter, focused positive/negative discovery descriptions, a short main entry, directly linked resources, independent input handling, no required provider and optional CLI enrichment only. Each has been tested as an isolated directory. Detailed before/after dimensions follow below.

| Skill | Specific correction |
|---|---|
| analyze-issue | Local/supplied/GitHub inputs; direct policy discovery; investigation stops before implementation. |
| generate-prd | Requirements derived from issue/code; observable, stack-appropriate checks; standalone artifact ownership. |
| convert-prd-to-json | Canonical schema helper; preserve existing IDs/state; no checkout, compulsory handoff, fabricated GitHub URL or universal TypeScript requirement. |
| execute-tasks | Fresh checks; regression reproduction where feasible; validate GENERAL findings; no automatic CLAUDE.md editing; focused staging and bounded completion. |
| create-pr | Actual base and head, existing-PR handling, correct references for local/GitHub issues, authorization-aware publication and recovery. |
| review-issue | Evidence-based PASS/FAIL; default report only; comments/closure depend on existing authorization. |
| review-pr | Valid GitHub diff commands, exact revision, eight-section parseable report, additive rounds/index, no fabricated approval from missing context. |
| generate-issue | Proportional template-driven drafting, open/closed deduplication, existing taxonomy, remote capability checks and preserved drafts on failure. |
| generate-local-issue | Offline allocation, safe identifiers, exclusive creation, canonical parser/hash/metadata validation, no hidden GitHub prerequisite. |
| init-repository | Complete direct inspection path; bundled canonical renderers; plan/create/keep/review, preserve existing alternatives and exclusive application. |
| resolve-issue (new) | Portable auto/manual workflow, phase resumption including pending PR review, bounded corrections, local-only delivery, no CLI runtime or sibling dependency. |

## CLI dependencies classified

| Classification | Operation | Outcome |
|---|---|---|
| A — removed | CLI download in policy discovery; naming/hash/format access; provider selection; orchestration handoff | Direct capabilities plus shipped helpers; no `npx issue-flow` in workflows. |
| B — optional | `policy --json`, `init --json`, an explicitly requested `init --apply` | Bounded probe and schema check; direct fallback. Neither absence nor unsupported output prevents Skill operation. |
| C — runtime-exclusive | SQLite, session ownership, transactional recovery, locks, telemetry, queues, independent reviewer orchestration | Remain CLI responsibilities, documented outside the portable execution promise. No current Skill requires them. |

## Distribution evidence

The pinned installer 1.5.23 discovered eleven Skills. Tested: all eleven individually; selected sets; all-Skill installation; Claude/Codex/OpenCode targets; project and disposable user scope; copy and symlink modes; inventory; clone via a Git URL; and refreshing a changed Git revision via `add`. Every installed directory was compared byte-for-byte and revalidated, including resources and licenses.

Two limitations are explicit. Local-path installs are not registered as remotely updateable packages. `update -p -y` returned exit 1 for the test's `file://` Git origin, while reinstalling that origin with `add` correctly picked up its second revision. GitHub update of these new artifacts requires publishing this revision; no remote publication/update is claimed. The command examples in the user guide are the supported ecosystem interface, not evidence that unpublished work is already on GitHub.

Antigravity's documented global path differs from the pinned installer's mapping. Manual installation to the host-documented location is described. No host-specific fork of a Skill was introduced.

## Validation evidence

The machine-readable installer/eval evidence is linked below when finalized. Commands ran in `packages/issue-flow` unless noted:

| Command | Purpose |
|---|---|
| `npm run skills:sync` repeated | Deterministic, idempotent generation |
| `npm run skills:check` | Byte/file-set drift, format and dependency closure |
| `npm run skills:test` | Isolated artifacts, helper behavior, negative mutations and evaluator tests |
| `npm run skills:eval -- --check` | Versioned corpus coverage for every Skill |
| `npm run skills:install-test -- --global-container` | Real installer paths, copies, symlinks, Git and global scope |
| `npm run skills:cli-test` | Actual npm payload without Skills, full pipeline fixtures and optional integration |
| `npm run check` | Biome and TypeScript |
| `npm test` | Complete CLI regression suite |
| `npm run build` / packaged `--help` | Production bundling and command registration |

Initial sandbox-only HTTP failures were reproduced as `listen EPERM` and rerun with local-port access. The unrelated heartbeat flake was diagnosed rather than hidden by retries. The packed CLI test caught a load-time defect that source tests could not catch.

Behavioral evidence includes a real baseline failure: the old standalone conversion emitted `issueUrl: null`, rejected by the canonical task-plan schema, and introduced an unconfigured typecheck requirement in a plain JavaScript fixture. The candidate produced a validated plan on Claude and Codex. The first evaluator only checked JSON syntax and incorrectly passed that baseline; its assertions were strengthened and the baseline rerun. This is a verifier correction, not a claimed model improvement without evidence.

Catalogue selection is an explicit description test, not a measurement of native automatic activation. Behavior evals load an isolated copied artifact, but personal/enterprise harness instructions may still be visible. Hosted remote creation and every agent's native discovery have not been certified by these synthetic tests. Rubrics assess results and commands, never chain-of-thought. One sample is not a flakiness estimate.

## Related issues and remaining verification

[Issue #111](https://github.com/fabioassuncao/issue-flow/issues/111) supplied the eval requirements and remains the appropriate place to track repeated runs, cost/variance and broader native-harness coverage. The runner, scenarios, pressure contracts and two-harness evidence were implemented here, rather than deferred into a duplicate issue. Earlier #61 policy parity and #107 architecture history were considered; discarded implementation claims were not treated as current code. No duplicate issue was created and no remote issue was closed automatically. [Issue #111 was updated with verified results and remaining measurements](https://github.com/fabioassuncao/issue-flow/issues/111#issuecomment-5555371365).

Final acceptance statuses and per-Skill detailed audit are appended below.

## Detailed audit of every Skill

This is a dated source-to-artifact snapshot. “PASS” below refers to structural checks; host execution evidence has the limits stated above.

### analyze-issue

| Item | Before | Implemented artifact |
|---|---|---|
| Name | analyze-issue | analyze-issue |
| Responsibility | Analyze demand before planning | Phase/workflow remains independently invocable |
| Triggering | Description present; needs explicit positive/negative scenarios | Analyze a GitHub issue, local issue file or supplied demand to identify scope, affected code, constraints and unanswered questions before implementation. Use for issue analysis; not for reviewing completed work or implementing it. |
| Structure | SKILL.md + README.md | SKILL.md + 4 references + 1 helpers + licenses |
| Agent Skills conformance | name matches directory; description present; no proprietary frontmatter | PASS: portable core frontmatter, naming and resource checks |
| Self-contained | No | PASS: copied directory validated alone |
| Progressive disclosure | External policy only; detailed procedure remains in entrypoint | 29 entry-point lines; conditional resources listed directly |
| CLI dependency | Indirect policy command and automatic npx download; no direct command in entrypoint | Only optional enrichment; no runtime requirement |
| External directory dependency | ../_shared/repository-policy.md | None; consumer inputs are explicit task data |
| Provider dependency | Orchestrator references | None in canonical Skill; separate optional Claude adapter |
| Shared resources | repository-policy.md | repository-policy.md, cli-integration.md, issue-input.md |
| Scripts | Inline commands; no bundled script files | optional-cli.mjs |
| Portability | Fails individual-copy dependency closure | Independent artifact; host support/evidence in compatibility matrix |
| Corrections required | Internalize resources, remove implicit CLI download, revise triggers and independent inputs; see audit report for skill-specific corrections | Implemented; see specific correction table and behavioral evidence |

### generate-prd

| Item | Before | Implemented artifact |
|---|---|---|
| Name | generate-prd | generate-prd |
| Responsibility | Write requirements | Phase/workflow remains independently invocable |
| Triggering | Description present; needs explicit positive/negative scenarios | Write a PRD with verifiable requirements and user stories from an issue or supplied demand. Use when requirements or a PRD are requested; not for implementing code or converting an existing PRD to JSON. |
| Structure | SKILL.md + README.md | SKILL.md + 6 references + 2 helpers + licenses |
| Agent Skills conformance | name matches directory; description present; no proprietary frontmatter | PASS: portable core frontmatter, naming and resource checks |
| Self-contained | No | PASS: copied directory validated alone |
| Progressive disclosure | External policy only; detailed procedure remains in entrypoint | 32 entry-point lines; conditional resources listed directly |
| CLI dependency | Indirect policy command and automatic npx download; no direct command in entrypoint | Only optional enrichment; no runtime requirement |
| External directory dependency | ../_shared/repository-policy.md | None; consumer inputs are explicit task data |
| Provider dependency | Orchestrator references | None in canonical Skill; separate optional Claude adapter |
| Shared resources | repository-policy.md | repository-policy.md, cli-integration.md, issue-input.md, plan-format.md, evidence.md |
| Scripts | Inline commands; no bundled script files | optional-cli.mjs, artifacts.mjs |
| Portability | Fails individual-copy dependency closure | Independent artifact; host support/evidence in compatibility matrix |
| Corrections required | Internalize resources, remove implicit CLI download, revise triggers and independent inputs; see audit report for skill-specific corrections | Implemented; see specific correction table and behavioral evidence |

### convert-prd-to-json

| Item | Before | Implemented artifact |
|---|---|---|
| Name | convert-prd-to-json | convert-prd-to-json |
| Responsibility | Build task plan | Phase/workflow remains independently invocable |
| Triggering | Description present; needs explicit positive/negative scenarios | Convert an existing PRD into an ordered JSON task plan, or update that plan while preserving existing work. Use for PRD-to-plan conversion; not for writing the initial requirements or executing tasks. |
| Structure | SKILL.md + README.md | SKILL.md + 6 references + 3 helpers + licenses |
| Agent Skills conformance | name matches directory; description present; no proprietary frontmatter | PASS: portable core frontmatter, naming and resource checks |
| Self-contained | No | PASS: copied directory validated alone |
| Progressive disclosure | External policy only; detailed procedure remains in entrypoint | 33 entry-point lines; conditional resources listed directly |
| CLI dependency | Indirect policy command and automatic npx download; direct conventions/init calls | Only optional enrichment; no runtime requirement |
| External directory dependency | ../_shared/repository-policy.md, docs/git-conventions.md | None; consumer inputs are explicit task data |
| Provider dependency | Orchestrator references | None in canonical Skill; separate optional Claude adapter |
| Shared resources | repository-policy.md | repository-policy.md, cli-integration.md, issue-input.md, plan-format.md, git-conventions.md |
| Scripts | Inline commands; no bundled script files | optional-cli.mjs, conventions.mjs, artifacts.mjs |
| Portability | Fails individual-copy dependency closure | Independent artifact; host support/evidence in compatibility matrix |
| Corrections required | Internalize resources, remove implicit CLI download, revise triggers and independent inputs; see audit report for skill-specific corrections | Implemented; see specific correction table and behavioral evidence |

### execute-tasks

| Item | Before | Implemented artifact |
|---|---|---|
| Name | execute-tasks | execute-tasks |
| Responsibility | Implement task plan | Phase/workflow remains independently invocable |
| Triggering | Description present; needs explicit positive/negative scenarios | Implement stories from an existing JSON task plan with checks, focused commits and progress tracking. Use when asked to execute a plan or continue its implementation; not to create a plan or only review work. |
| Structure | SKILL.md + README.md | SKILL.md + 8 references + 3 helpers + licenses |
| Agent Skills conformance | name matches directory; description present; no proprietary frontmatter | PASS: portable core frontmatter, naming and resource checks |
| Self-contained | No | PASS: copied directory validated alone |
| Progressive disclosure | External policy only; detailed procedure remains in entrypoint | 35 entry-point lines; conditional resources listed directly |
| CLI dependency | Indirect policy command and automatic npx download; direct conventions/init calls | Only optional enrichment; no runtime requirement |
| External directory dependency | ../_shared/repository-policy.md, docs/git-conventions.md | None; consumer inputs are explicit task data |
| Provider dependency | Named tools / CLAUDE-specific instructions | None in canonical Skill; separate optional Claude adapter |
| Shared resources | repository-policy.md | repository-policy.md, cli-integration.md, issue-input.md, plan-format.md, git-conventions.md, evidence.md, completion-signal.md |
| Scripts | Inline commands; no bundled script files | optional-cli.mjs, conventions.mjs, artifacts.mjs |
| Portability | Fails individual-copy dependency closure | Independent artifact; host support/evidence in compatibility matrix |
| Corrections required | Internalize resources, remove implicit CLI download, revise triggers and independent inputs; see audit report for skill-specific corrections | Implemented; see specific correction table and behavioral evidence |

### create-pr

| Item | Before | Implemented artifact |
|---|---|---|
| Name | create-pr | create-pr |
| Responsibility | Publish pull request | Phase/workflow remains independently invocable |
| Triggering | Description present; needs explicit positive/negative scenarios | Create a GitHub pull request for a working branch, using repository conventions and verified change context. Use when asked to open or publish a PR; not to review a PR or merely summarize a diff. |
| Structure | SKILL.md + README.md | SKILL.md + 6 references + 2 helpers + licenses |
| Agent Skills conformance | name matches directory; description present; no proprietary frontmatter | PASS: portable core frontmatter, naming and resource checks |
| Self-contained | No | PASS: copied directory validated alone |
| Progressive disclosure | External policy only; detailed procedure remains in entrypoint | 32 entry-point lines; conditional resources listed directly |
| CLI dependency | Indirect policy command and automatic npx download; direct conventions/init calls | Only optional enrichment; no runtime requirement |
| External directory dependency | ../_shared/repository-policy.md, docs/git-conventions.md | None; consumer inputs are explicit task data |
| Provider dependency | No proprietary tool requirement | None in canonical Skill; separate optional Claude adapter |
| Shared resources | repository-policy.md | repository-policy.md, cli-integration.md, issue-input.md, git-conventions.md, publication.md |
| Scripts | Inline commands; no bundled script files | optional-cli.mjs, conventions.mjs |
| Portability | Fails individual-copy dependency closure | Independent artifact; host support/evidence in compatibility matrix |
| Corrections required | Internalize resources, remove implicit CLI download, revise triggers and independent inputs; see audit report for skill-specific corrections | Implemented; see specific correction table and behavioral evidence |

### review-issue

| Item | Before | Implemented artifact |
|---|---|---|
| Name | review-issue | review-issue |
| Responsibility | Verify issue resolution | Phase/workflow remains independently invocable |
| Triggering | Description present; needs explicit positive/negative scenarios | Verify whether an issue is resolved by comparing its requirements with code and fresh check results. Use for resolution review of GitHub or local issues. Return a report; comment or close only when requested. Not for pre-implementation analysis or general PR review. |
| Structure | SKILL.md + README.md | SKILL.md + 7 references + 1 helpers + licenses |
| Agent Skills conformance | name matches directory; description present; no proprietary frontmatter | PASS: portable core frontmatter, naming and resource checks |
| Self-contained | No | PASS: copied directory validated alone |
| Progressive disclosure | External policy only; detailed procedure remains in entrypoint | 32 entry-point lines; conditional resources listed directly |
| CLI dependency | Indirect policy command and automatic npx download; no direct command in entrypoint | Only optional enrichment; no runtime requirement |
| External directory dependency | ../_shared/repository-policy.md | None; consumer inputs are explicit task data |
| Provider dependency | Orchestrator references | None in canonical Skill; separate optional Claude adapter |
| Shared resources | repository-policy.md | repository-policy.md, cli-integration.md, issue-input.md, evidence.md, issue-review-result.md, publication.md |
| Scripts | Inline commands; no bundled script files | optional-cli.mjs |
| Portability | Fails individual-copy dependency closure | Independent artifact; host support/evidence in compatibility matrix |
| Corrections required | Internalize resources, remove implicit CLI download, revise triggers and independent inputs; see audit report for skill-specific corrections | Implemented; see specific correction table and behavioral evidence |

### review-pr

| Item | Before | Implemented artifact |
|---|---|---|
| Name | review-pr | review-pr |
| Responsibility | Review complete pull request | Phase/workflow remains independently invocable |
| Triggering | Description present; needs explicit positive/negative scenarios | Review a complete GitHub pull request and return findings and a structured recommendation. Use for PR code review or merge-readiness assessment; not to create a PR, modify code or publish a remote review. |
| Structure | SKILL.md + README.md | SKILL.md + 6 references + 1 helpers + licenses |
| Agent Skills conformance | name matches directory; description present; no proprietary frontmatter | PASS: portable core frontmatter, naming and resource checks |
| Self-contained | No | PASS: copied directory validated alone |
| Progressive disclosure | External policy only; detailed procedure remains in entrypoint | 31 entry-point lines; conditional resources listed directly |
| CLI dependency | Indirect policy command and automatic npx download; direct conventions/init calls | Only optional enrichment; no runtime requirement |
| External directory dependency | ../_shared/repository-policy.md, docs/git-conventions.md | None; consumer inputs are explicit task data |
| Provider dependency | Named tools / CLAUDE-specific instructions | None in canonical Skill; separate optional Claude adapter |
| Shared resources | repository-policy.md | repository-policy.md, cli-integration.md, issue-input.md, evidence.md, pr-review-result.md |
| Scripts | Inline commands; no bundled script files | optional-cli.mjs |
| Portability | Fails individual-copy dependency closure | Independent artifact; host support/evidence in compatibility matrix |
| Corrections required | Internalize resources, remove implicit CLI download, revise triggers and independent inputs; see audit report for skill-specific corrections | Implemented; see specific correction table and behavioral evidence |

### generate-issue

| Item | Before | Implemented artifact |
|---|---|---|
| Name | generate-issue | generate-issue |
| Responsibility | Create GitHub demand | Phase/workflow remains independently invocable |
| Triggering | Description present; needs explicit positive/negative scenarios | Draft and publish a GitHub issue from a request to file a bug, feature or other backlog item, checking repository conventions and duplicates. Use for recording a GitHub work item; not for a request to fix code directly or create an offline issue. |
| Structure | SKILL.md + README.md | SKILL.md + 7 references + 2 helpers + licenses |
| Agent Skills conformance | name matches directory; description present; no proprietary frontmatter | PASS: portable core frontmatter, naming and resource checks |
| Self-contained | No | PASS: copied directory validated alone |
| Progressive disclosure | External policy only; detailed procedure remains in entrypoint | 33 entry-point lines; conditional resources listed directly |
| CLI dependency | Indirect policy command and automatic npx download; no direct command in entrypoint | Only optional enrichment; no runtime requirement |
| External directory dependency | ../_shared/repository-policy.md | None; consumer inputs are explicit task data |
| Provider dependency | Named tools / CLAUDE-specific instructions | None in canonical Skill; separate optional Claude adapter |
| Shared resources | repository-policy.md | repository-policy.md, cli-integration.md, issue-input.md, issue-authoring.md, publication.md, git-conventions.md |
| Scripts | Inline commands; no bundled script files | optional-cli.mjs, conventions.mjs |
| Portability | Fails individual-copy dependency closure | Independent artifact; host support/evidence in compatibility matrix |
| Corrections required | Internalize resources, remove implicit CLI download, revise triggers and independent inputs; see audit report for skill-specific corrections | Implemented; see specific correction table and behavioral evidence |

### generate-local-issue

| Item | Before | Implemented artifact |
|---|---|---|
| Name | generate-local-issue | generate-local-issue |
| Responsibility | Create local demand | Phase/workflow remains independently invocable |
| Triggering | Description present; needs explicit positive/negative scenarios | Create a local issue as issue.md and metadata.json in the consumer project. Use when asked to record a demand locally or offline; not when the requested destination is GitHub or the user wants immediate implementation. |
| Structure | SKILL.md + README.md | SKILL.md + 7 references + 3 helpers + licenses |
| Agent Skills conformance | name matches directory; description present; no proprietary frontmatter | PASS: portable core frontmatter, naming and resource checks |
| Self-contained | No | PASS: copied directory validated alone |
| Progressive disclosure | External policy only; detailed procedure remains in entrypoint | 34 entry-point lines; conditional resources listed directly |
| CLI dependency | Indirect policy command and automatic npx download; direct conventions/init calls | Only optional enrichment; no runtime requirement |
| External directory dependency | ../_shared/repository-policy.md | None; consumer inputs are explicit task data |
| Provider dependency | Named tools / CLAUDE-specific instructions | None in canonical Skill; separate optional Claude adapter |
| Shared resources | repository-policy.md | repository-policy.md, cli-integration.md, issue-input.md, issue-authoring.md, local-issue-files.md, git-conventions.md |
| Scripts | Inline commands; no bundled script files | optional-cli.mjs, conventions.mjs, artifacts.mjs |
| Portability | Fails individual-copy dependency closure | Independent artifact; host support/evidence in compatibility matrix |
| Corrections required | Internalize resources, remove implicit CLI download, revise triggers and independent inputs; see audit report for skill-specific corrections | Implemented; see specific correction table and behavioral evidence |

### init-repository

| Item | Before | Implemented artifact |
|---|---|---|
| Name | init-repository | init-repository |
| Responsibility | Fill repository convention gaps | Phase/workflow remains independently invocable |
| Triggering | Description present; needs explicit positive/negative scenarios | Inspect repository conventions and create only missing issue templates, PR templates and documentation entry points. Use when asked to initialize or standardize repository conventions; not for application scaffolding, issue creation or replacing existing policy. |
| Structure | SKILL.md | SKILL.md + 5 references + 2 helpers + licenses |
| Agent Skills conformance | name matches directory; description present; no proprietary frontmatter | PASS: portable core frontmatter, naming and resource checks |
| Self-contained | No | PASS: copied directory validated alone |
| Progressive disclosure | External policy only; detailed procedure remains in entrypoint | 31 entry-point lines; conditional resources listed directly |
| CLI dependency | Indirect policy command and automatic npx download; direct conventions/init calls | Only optional enrichment; no runtime requirement |
| External directory dependency | ../_shared/repository-policy.md, ../../docs/conventions.md | None; consumer inputs are explicit task data |
| Provider dependency | No proprietary tool requirement | None in canonical Skill; separate optional Claude adapter |
| Shared resources | repository-policy.md | repository-policy.md, cli-integration.md, issue-input.md, repository-scaffold.md |
| Scripts | Inline commands; no bundled script files | optional-cli.mjs, scaffold.mjs |
| Portability | Fails individual-copy dependency closure | Independent artifact; host support/evidence in compatibility matrix |
| Corrections required | Internalize resources, remove implicit CLI download, revise triggers and independent inputs; see audit report for skill-specific corrections | Implemented; see specific correction table and behavioral evidence |

### resolve-issue

| Item | Before | Implemented artifact |
|---|---|---|
| Name | Not a portable Skill | resolve-issue |
| Responsibility | Claude-only orchestrator | Phase/workflow remains independently invocable |
| Triggering | Claude delegation | Resolve an issue through requirements, task planning, implementation, verification and authorized PR delivery. Use for an end-to-end issue request or resuming that workflow. Manual mode stops after planning. Not for a request limited to analysis, review or a single phase. |
| Structure | agents/resolve-issue.md | SKILL.md + 18 references + 3 helpers + licenses |
| Agent Skills conformance | Proprietary subagent frontmatter | PASS: portable core frontmatter, naming and resource checks |
| Self-contained | No | PASS: copied directory validated alone |
| Progressive disclosure | Monolithic orchestration | 50 entry-point lines; conditional resources listed directly |
| CLI dependency | Runtime/provider assumptions | Only optional enrichment; no runtime requirement |
| External directory dependency | Ten sibling Skills | None; consumer inputs are explicit task data |
| Provider dependency | Claude subagent API | None in canonical Skill; separate optional Claude adapter |
| Shared resources | Sibling phase bodies | repository-policy.md, cli-integration.md, issue-input.md, plan-format.md, git-conventions.md, evidence.md, publication.md, issue-review-result.md, pr-review-result.md, completion-signal.md |
| Scripts | Inline CLI/tool instructions | optional-cli.mjs, conventions.mjs, artifacts.mjs |
| Portability | Claude only | Independent artifact; host support/evidence in compatibility matrix |
| Corrections required | Move workflow into canonical portable artifact | Implemented; see specific correction table and behavioral evidence |

## Recorded results and final acceptance

- [Validation totals](skills-evals-2026-09-05/validation.json): **2,202 unit tests in 171 files**, **34 structural/helper/evaluator tests**, and **53 packed CLI smoke assertions**, all passing. Biome, TypeScript, production build, `skills:check`, repeated generation and changed-document links passed.
- [Installer evidence](skills-evals-2026-09-05/installer.json): all supported install/discovery/copy/isolation assertions passed; `file://` update limitation is recorded with its exit code. Recursive discovery on the actual source checkout also found exactly eleven Skills.
- [Claude corpus](skills-evals-2026-09-05/claude-corpus.json): 35/35 PASS, covering every original positive/negative and behavior case. The later 36th scenario, PR-review resumption, passed in [Codex](skills-evals-2026-09-05/codex-resume.json).
- Codex **0.153.4**: [core conversion/review](skills-evals-2026-09-05/codex-core.json) 2/2, [behavior](skills-evals-2026-09-05/codex-behavior.json) 4/4, [selection](skills-evals-2026-09-05/codex-selection.json) 6/6 and resumption 1/1 PASS.
- Claude Code **2.1.261**: [baseline conversion](skills-evals-2026-09-05/baseline-conversion.json) FAIL on canonical schema, candidate conversion PASS. Earlier runs did not identify the model and retain null; a subsequent [metadata observer smoke](skills-evals-2026-09-05/claude-metadata.json) captured `claude-opus-5` and passed 2/2. No model was retrospectively inferred for earlier runs.

Manual rubric inspection confirmed relevant PRD criteria, preservation of source while reviewing/planning, regression execution before and after the fix, a technically rejected invalid finding, canonical local metadata, and explicit remote-verification limits in drafts. These are small synthetic smoke cases, not proof of production correctness or polished prose in every output. The corpus gained its resumption case after the 35-case run began; hashes identify the exact artifacts/corpus used by each run. Later license/runtime-requirement wording and optional-probe hardening were structurally and package-tested. Rerun behavioral cases against a release revision when exact-revision certification is required.

| Criterion | Status | Evidence / next step |
|---|---|---|
| Agent Skills Spec compliance | PASS | All eleven portable-core artifacts validate. |
| Self-contained Skills | PASS | Individual copies and real installed closures validate; scripts run independently. |
| Independent Skill execution | PASS | Every Skill has an executed behavior fixture; no Issue Flow CLI required. Remote operations remain conditional on authenticated capabilities. |
| Independent CLI execution | PASS | Actual npm payload and complete pipeline fixtures work without Skills. |
| CLI + Skills integration | PASS | Packed CLI policy enrichment plus missing/failed/incompatible CLI fallback checks. |
| npx skills compatibility | PARTIAL | Install/discovery/Git refresh pass. `file://` update fails in installer 1.5.23; GitHub update requires a published revision. Publish through the normal reviewed release process, then install/update from GitHub and revalidate bytes. |
| Cross-agent portability | PARTIAL | Canonical format, official-source matrix and Claude/Codex execution verified. Native activation and live execution on Cursor/OpenCode/Antigravity/Gemini/Copilot remain unmeasured; test their installed versions in isolated environments using the same corpus. |
| Shared-content architecture | PASS | One authored source, deterministic copies/bundles, drift check before CI generation. |
| Progressive disclosure | PASS | Short entry points with direct links to conditional resources; no sibling dependencies. |
| Validation/tests | PASS | Unit, structural, package, installer and sampled behavioral checks above; probabilistic/native coverage limitations remain explicit. |
| Documentation | PASS | User/contributor guides, installation, compatibility, evals, source ownership and complete per-Skill audit updated. |

No implementation was merged or published as part of this work. Changes are reviewable on `refactor/agent-skills-portability`; remote installation examples apply once the revision is available from the selected source.
