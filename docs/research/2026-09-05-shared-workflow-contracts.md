# Skills, CLI and shared workflow contracts

Investigation: 2026-09-05. Issue Flow baseline: `ebb7124`, package 0.18.0.
This is dated evidence and a decision record, not a second behavioral specification.
Current contracts live in [architecture](../code-organization.md), [Skills](../skills.md),
[commands](../commands.md) and [storage](../storage.md).

## Discovery and scope

Discovery preceded implementation. The repository already contradicted several
hypotheses in the request: its directory is `skills-src`, not `skills.src`; eleven
Skills already have small entry points and progressive disclosure; canonical
TypeScript already supplies standalone bundles; shared prose already composes
CLI prompts; exact-byte drift checks already run before generation in CI. The
CLI is an agent orchestrator for reasoning phases, not exclusively a deterministic
filesystem tool. Removing that orchestration would break the product.

The approved evolution preserves these investments. It adds shared deterministic
inspection, repairs observed behavioral gaps, and makes the existing build boundary
explicit. It does not merge runtime stores or require either interface to install
the other. The approved compatibility changes are enforcing declared story
dependencies and requiring explicit issue-closure authorization.

### Sources, build and artifacts

`skills-src/manifest.json` maps each destination to an authored source. Sources
include each `SKILL.md.in` and `workflow.md`, `_shared` references and optional
integration helper, `src/conventions`, `src/issues` parsing/hashing,
`src/schemas.ts`, scaffold renderers, and `scripts/skill-entries/*.entry.mjs`.
CLI templates live in `prompts-src/*.md.in`. The builder uses esbuild for readable
standalone bundles, copies local resources/licenses, composes fixed Markdown
contracts and checks path containment. No postinstall is required for Skills.

Outputs are eleven `skills/<name>` directories and eight packaged prompts. The
current manifest produces 151 resources. `skills/README.md` and `skills/AGENTS.md`
are authored exceptions. `dist/` is ignored CLI compilation output. The check
compares bytes and complete file sets, validates frontmatter/links/anchors/imports,
and rejects escaping resources. Tests copy each Skill into isolation. The npm
payload carries compiled CLI, prompts and web resources, not Skill sources.

Prior gaps in this boundary: `build` compiled only the CLI; most generated
references/prompts lacked provenance; task semantics did not have one pure
inspection implementation. Those are now addressed without replacing the builder.

## Responsibility inventory and gaps

In this table, duplication means independent behavior or declarations, not the
intentional copies generated for independent distribution.

| Responsibility | Skill | CLI before | Duplicated / source | Concrete problem | Decision |
| --- | --- | --- | --- | --- | --- |
| Lifecycle | Bundled procedures and artifact evidence | Pipeline flags, engine, finalizer | Phase mapping and completion prose | Engine could complete issue before remaining delivery | Shared phase metadata; distinguish execution/delivery |
| Issue inputs | URL, number, file, supplied content; grouping | Resolver/providers, queue discovery | Partial intentional difference | CLI has narrower command inputs | Preserve; no universal normalization engine |
| Task shape | Bundled Zod helper and plan reference | Zod schema and plan command | Schema already shared | CLI planning lacked helper's duplicate-ID check | Shared inspector for shape and graph |
| Story scheduling | Eligible dependencies, then priority | Priority alone | Independent selectors | Blocked story could run first | Shared eligibility; reject invalid graph before agent |
| States/transitions | Evidence determines next phase | Persisted pipeline + run/queue state | Runtime stores intentionally separate | Common methodology obscured by runtime differences | Generate phase reference; do not share sessions |
| Review validation | Exact final result required | Missing result defaulted to PASS | Parser vs composed protocol | False approval, unnecessary correction attempts | Strict parser; preserve findings; fail protocol separately |
| Dependencies | Task prerequisites and issue grouping | Inter-issue graph; story deps observational | Two distinct graph domains | Story dependencies had no execution effect | Enforce task graph only; keep inter-issue graph |
| Context gathering | Current host reads relevant resources/code | Prompts, policy discovery, state loader | Repeated manual plan interpretation | Full plan parsing by LLM; state loader unsuitable for pure inspection | Explicit-file compact projection |
| Templates | Manifest copies shared resources | Packaged composed prompts | Largely already canonical | Build command did not rebuild them | Extend existing build |
| Prompts | Procedures and reference contracts | Prompt overrides and phase templates | Consumer-specific prompts intentional | Execute asked to update CLAUDE despite preservation rule | Fix contradiction; retain overrides |
| Artifact creation | Current-agent filesystem operations | Providers, scaffold, planner agent | Pure renderers/hash already shared | Local generation still probed remote numbering/policy | Explicit local-only discovery/allocation |
| Artifact reading | Local standalone helper | Runtime loaders can import/reconcile | No shared pure read adapter | Inspection could initialize state | Read-only adapter shared with helper |
| Artifact updates | Preserve IDs/evidence; conversational refine | Plan/regenerate and narrow SQLite agent projection | Some intentional divergence | Regeneration is not semantic refinement | Defer update command; preserve closure ownership |
| Finalization | Publication and closure require authorization | Automatic provider close | Behavior diverged | Closed issues without explicit choice; weak failure recovery | Persist explicit choice; confirm/retry per issue |
| Verification | Host checks, evidence, unmet/unverified distinctions | Acceptance runner, independent reviewer | Evidence prose already shared | CLI cannot own subjective acceptance decisions | Keep reasoning in agents and technical checks in code |
| Git | Invocation branch/commit choices, publication checks | Git conventions, preflight, no-branch, commit prompts | Naming already shared | No-branch prompt could switch; execute instruction contradicted docs | Guard current branch; keep broader choices Skill-only |
| Configuration | Invocation choices + repository policy | Config precedence, env, policy loaders | Policy shared; invocation modes differ | Repeated policy reads | Reuse established context until relevant change |
| Installation | Portable directories, host installer | npm CLI payload | Independent by design | None requiring new installer | Keep current installer/isolation tests |
| Updating Skills | Regenerate then reinstall pinned distribution | npm update independent of installed Skills | Independent versions intentional | No guarantee a user's custom override stays current | Document maintenance boundary; no auto-updater |
| Agent outputs | Bundled JSON operations | `status --json` used prefixed logger | Existing flag unusable for JSON.parse | LLM/client must strip terminal text | Raw stdout, version field and structured project errors |

### Duplications worth eliminating

| Rule | Baseline locations | Drift risk | Canonical owner after change |
| --- | --- | --- | --- |
| Plan validity | `schemas.ts`, standalone entry, plan command | High: different checks | Schema + `core/task-plan.ts`; shared `artifact-files.ts` |
| Next story | `state-manager`, execute prompt, Skill procedure | High: dependency ignored | `eligibleStories`; prose describes same decision |
| Phase order/field mapping | `pipeline.ts`, state defaults, plan reference | Medium | `workflow-contract.ts`; runtime maps and generated table |
| Review result | CLI parser and composed protocol | High: implicit success | Strict `verify/review-result.ts` tested against protocol |
| Closure | Single finalizer and queue helper | High: implicit and unconfirmed | CLI closure service, queue-owned confirmed IDs |
| Defaults/naming/hash/scaffold | Generated copies | Low, already checked | Existing TypeScript domains; no new extraction |
| Context instructions | Repeated required `--help`, policy rereads | Medium: latency and tokens | Conditional help, same-execution context reuse |

A prose prerequisite label is not an executable validator. Phase-specific
validation remains in its domain, backed by tests. No claim is made that generating
a table proves the semantics of every agent procedure or consumer override.

## Per-Skill audit

Baseline token proxies below are `ceil(characters/4)`, not model tokenizer usage.
Entry / workflow / all Markdown inventories distinguish initial disclosure from
the entire installed directory. Required reads can be batched, so file counts are
not fixed tool-call counts. Scripts should be executed rather than read into context.
All Skills require the current host's relevant capabilities; none requires a
sibling Skill, Issue Flow CLI, plugin or subagent runtime.

| Skill | Baseline entry / workflow / all Markdown | Required context | Conditional context | Deterministic / reasoning split | Calls and opportunity |
| --- | --- | --- | --- | --- | --- |
| analyze-issue | 468 / 288 / 5003 | Input, options, policy, affected code | Comments, linked sources, optional CLI policy | Source resolution / trace impact and completeness | 3–7 logical discovery operations plus code; reuse source/policy |
| generate-prd | 518 / 384 / 6299 | Demand, options, input, policy, format | Analysis if it exists, clarification | IDs/paths / acceptance, scope and constraints | 3–7 reads + writes; do not require analyze Skill |
| convert-prd-to-json | 537 / 442 / 7563 | PRD, options, format, existing plan, Git policy | Existing progress and project numbering | Validate graph/IDs / coherent decomposition | 4–8 discovery/validation operations; use shared inspector |
| execute-tasks | 579 / 732 / 8305 | Options, plan format, policy, Git, evidence, PRD/progress/code | Correction findings, browser, specialized checks | Eligibility/shape/branch / implementation and interpretation | 5–10 setup operations plus per-story checks; compact first inspection, no mandatory help |
| create-pr | 533 / 780 / 8686 | Options, policy, Git, metadata, publication, diff | Existing PR, issue association, missing metadata recovery | Resolve/query/confirm / title/body and impact | 5–9 local/remote operations; already reuses existing PR and bounded repair |
| review-issue | 539 / 346 / 5916 | Options, input, policy, evidence, result protocol, code | Browser/links and historical decisions | Validate output / assess requirements and evidence | 4–8 setup operations plus checks; reject malformed result before fixer |
| review-pr | 501 / 659 / 6067 | Options, policy, evidence, PR result, diff | Related issue and browser evidence | PR discovery/report protocol / risk and severity | 4–8 setup operations plus checks; no remote review publication |
| generate-issue | 550 / 385 / 7302 | Policy, authoring, publication, demand | Labels/types/template/duplicate candidates | Hash/metadata / write proportionate issue | 4–8 discovery operations; current remote calls useful for remote intent |
| generate-local-issue | 570 / 378 / 7414 | Policy, authoring, local files, demand | Remote coordination only if requested | Local allocation/hash / duplicate judgment and writing | 3–7 local operations; CLI now respects same remote boundary |
| init-repository | 514 / 358 / 5500 | Policy, scaffold, existing files | Organization templates and optional CLI plan | Render candidates / decide create/keep/review | 3–7 discovery operations; preserve plan-then-apply and existing docs |
| resolve-issue | 802 / 1795 / 15404 | Options, input, policy, current phase | Bundled phase procedures, correction, PR review | State evidence / orchestration and scope | Several phases; avoid rereading common policy and unneeded phases |

Repeated material is mostly deliberately generated policy/options/Git/evidence
contracts. Removing distribution copies would create runtime dependencies. Entry
points already fit 31–53 lines, so wholesale splitting is not warranted. The
largest inventory belongs to the orchestrator but its phases are already loaded
on demand. No additional specialist hierarchy is justified by this audit.

The expensive part is often returned code/diff/plan content, repeated source
resolution, help calls, and retries after invalid state—not the entry point alone.
Context reuse must stop when branch, scope, instructions or configuration change.
A compact inspection cannot replace reading the actual PRD, relevant code or test
results required to reason correctly.

## External references and decision log

Inspected public source snapshots, including implementation and tests, rather than
only READMEs. Versions and commit links make the comparison reproducible; these
projects can change independently after the investigation.

OpenSpec 1.12.0, commit [`e062b957`](https://github.com/Fission-AI/OpenSpec/tree/e062b9572be933564ba3899d059377dfa1393e32):
[Skill generation](https://github.com/Fission-AI/OpenSpec/blob/e062b9572be933564ba3899d059377dfa1393e32/src/core/shared/skill-generation.ts),
[templates](https://github.com/Fission-AI/OpenSpec/blob/e062b9572be933564ba3899d059377dfa1393e32/src/core/templates/skill-templates.ts),
[equivalence tests](https://github.com/Fission-AI/OpenSpec/blob/e062b9572be933564ba3899d059377dfa1393e32/test/core/shared/skill-content-equivalence.test.ts),
[artifact graph](https://github.com/Fission-AI/OpenSpec/tree/e062b9572be933564ba3899d059377dfa1393e32/src/core/artifact-graph),
[status/instructions](https://github.com/Fission-AI/OpenSpec/tree/e062b9572be933564ba3899d059377dfa1393e32/src/commands/workflow),
[spec-driven schema/templates](https://github.com/Fission-AI/OpenSpec/tree/e062b9572be933564ba3899d059377dfa1393e32/schemas/spec-driven),
[update implementation](https://github.com/Fission-AI/OpenSpec/blob/e062b9572be933564ba3899d059377dfa1393e32/src/core/update.ts).

Its templates specialize content for consumers; artifact dependencies and status
separate readiness from reasoning. Schema-dependent instruction loading and
update generation solve problems in its spec lifecycle. Issue Flow already has
similar generation/parity machinery and a different runtime execution model.
Copying its schema discovery/custom workflow surface would add a second system.

Specsfy CLI 0.22.2, commit [`a73aab3b`](https://github.com/promovaweb/specsfy/tree/a73aab3b7ad771e2eea2178af85520eca4f6e2ae):
[lifecycle](https://github.com/promovaweb/specsfy/blob/a73aab3b7ad771e2eea2178af85520eca4f6e2ae/cli/src/lifecycle.ts),
[progress](https://github.com/promovaweb/specsfy/blob/a73aab3b7ad771e2eea2178af85520eca4f6e2ae/cli/src/progress.ts),
[catalog](https://github.com/promovaweb/specsfy/blob/a73aab3b7ad771e2eea2178af85520eca4f6e2ae/cli/src/catalog.ts),
[Skill locks](https://github.com/promovaweb/specsfy/blob/a73aab3b7ad771e2eea2178af85520eca4f6e2ae/cli/src/skill-lock.ts),
[installer](https://github.com/promovaweb/specsfy/blob/a73aab3b7ad771e2eea2178af85520eca4f6e2ae/cli/src/installer.ts),
[updater](https://github.com/promovaweb/specsfy/blob/a73aab3b7ad771e2eea2178af85520eca4f6e2ae/cli/src/updater.ts),
[progress tests](https://github.com/promovaweb/specsfy/blob/a73aab3b7ad771e2eea2178af85520eca4f6e2ae/tests/test_cli_progress.py),
[authoring context](https://github.com/promovaweb/specsfy/blob/a73aab3b7ad771e2eea2178af85520eca4f6e2ae/docs/develop/skills.md).

Its lifecycle/progress functions encode structural facts; catalog/installation
tracking supports optional specialized capabilities and update detection. This
suggests keeping discovery deterministic and measuring estimated context honestly.
Its directory/workset conventions and larger capability catalog do not solve an
observed Issue Flow need and are not adopted.

| Idea | Decision | Issue Flow application / reason |
| --- | --- | --- |
| Template source → specialized artifact (OpenSpec) | ADOPT existing | Keep manifest, bundles and prompt composition; make build complete |
| Generated equivalence checks (OpenSpec) | ADOPT existing | Retain pre-generation exact-byte CI gate; strengthen real consumer tests |
| Artifact dependency/readiness graph (OpenSpec) | ADAPT | Validate existing story IDs and prerequisites; no new workflow schema language |
| Structured status/instructions (OpenSpec) | ADAPT | Repair status JSON; add explicit-file artifact projection, not a generic instructions engine |
| Custom schemas/resolution hierarchy (OpenSpec) | REJECT | Existing task schema and six phases suffice |
| Automated host update machinery (both) | REJECT | Independent Skills installer and npm package already cover distribution |
| Progressive disclosure (both) | ADAPT existing | Conditional help, reuse context; retain phase procedures and eleven entry points |
| Structural lifecycle/progress (Specsfy) | ADAPT | Shared phase metadata plus execution/delivery distinction |
| Estimated context accounting (Specsfy) | ADAPT | Reproducible static inventory and projection benchmark, separate from model usage |
| Fingerprint/lock system (Specsfy) | REJECT for now | Exact byte/file-set checks already detect source/build drift; no new registry |
| Optional specialist catalog (Specsfy) | REJECT for now | No concrete capability requiring hierarchy or installation system |
| Mandatory setup/rereading large context trees | REJECT | Increases calls/context for portable Skills |
| Unified CLI/Skill runtime store | REJECT | Breaks explicit independence and creates migration burden |

## Proposed architecture and implementation sequence

```text
human edited                                      generated
skills-src/{manifest.json,_shared/,<skill>/} ─┐
packages/issue-flow/prompts-src/ ─────────────┤
packages/issue-flow/src/                     ├─ skills:sync → skills/<skill>/
  schemas.ts                                │                  references/scripts
  core/{task-plan,artifact-files,            │                → prompts/*.md
        workflow-contract}.ts ───────────────┤
  issues/{hash,markdown}.ts                  │
  conventions/, scaffold/ ───────────────────┘
  commands/, core/, execution/, storage/ ────── build:cli → dist/
```

Shared pure source is compiled into both consumers. Distribution sharing occurs
at build time. CLI-only code owns sessions/providers/orchestration/telemetry and
closure persistence. Skill-only procedures own current-host methodology and
conversational choices. There is no runtime import from `skills/` into the CLI
or from a copied Skill back into this repository.

Incremental implementation completed in these logical steps:

1. Extract strict review parsing and shared task graph/inspection functions.
2. Adapt standalone artifact helper and add the CLI explicit-file adapter.
3. Enforce dependency eligibility and current-branch prerequisites before execution;
   distinguish pipeline execution completion from delivery completion.
4. Persist explicit closure/revocation/confirmation, including queue delivery and
   closure-only resume; preserve CLI ownership across agent-written projections.
5. Remove local generation's remote probes; fix status stdout and prompt contradictions.
6. Extend existing generator/build/provenance and reduce mandatory helper/context reads.
7. Add semantic, protocol, persistence, isolation and actual-binary tests; update
   normative docs and reproducible static benchmark.

## Benchmark, limitations and future measurement

Run `node scripts/architecture-benchmark.mjs ebb7124` from the package directory.
It reads the baseline from Git, current generated files and a deterministic
20-story fixture. It performs no model call. The committed companion JSON records
the measured character counts converted to the stated token proxy.

For the representative 20-story fixture, full-plan discovery is about **4396**
estimated tokens; compact inspection is **419**, a **90% reduction for that
response only**, with one tool call in both cases. It is not a 90% claim for a
whole implementation. The projection includes only the next story's prose;
blocked stories expose IDs/dependencies, not their entire descriptions.

| Flow | Before | After | Expected consequence |
| --- | --- | --- | --- |
| Create/refine local demand | Local scan plus possible remote policy/number/duplicate probes; agent drafting | Local scan/allocation/hash, no remote probes; same drafting | Fewer remote round trips and unavailable-network failures; semantic refinement unchanged |
| Plan/implement | Full plan interpretation, mandatory helper help, dependency selection delegated/inconsistent | Validate graph first, compact next story, optional help, shared eligibility | Avoid invalid-state reasoning; smaller discovery result; code/PRD/test reads still needed |
| Review/finalize | Malformed result could appear PASS; closure implicit; retries uncertain | Parse before correction, delivery gate, explicit confirmed closure | More deterministic; successful close adds confirmation reads, failures become resumable |
| Resolve several phases | Possible rereads of shared policy/help | Reuse established context until relevant change | Fewer avoidable calls without removing phase-specific evidence |

The source inventory does **not** uniformly shrink: generated provenance, graph
contract and closure explanations add Markdown. CLI prompt provenance is stripped
before sending to agents. Entry points remain small; some resource inventories
grow. This is an explicit trade-off for clearer invariants, offset in applicable
flows by avoided rereads and smaller returned data. No end-to-end latency or
real billed-token reduction was measured in this change.

| Metric | Assessment | Evidence / qualification |
| --- | --- | --- |
| Token consumption | melhora média | 90% smaller plan discovery fixture; help/rereads avoided; total docs can grow |
| Tool calls | melhora média | Conditional help and local-only probes removed; confirmed closure adds reads |
| Latency | melhora baixa | Fewer remote/help operations; no live median/p95 claim |
| Determinism | melhora alta | Graph validation, exact protocol, structured inspection, confirmed closure |
| Maintainability | melhora alta | Domain source reused; same generation path; no new package/framework |
| Consistency | melhora alta | Scheduling/inspection parity and generated metadata; semantic behavior still needs evals |
| Debuggability | melhora média | Versioned errors, provenance and closure state; unminified helpers retained |
| Agent autonomy | neutro | Independent consumers and reasoning retained; invalid state stops earlier |

Future automation should run existing isolated behavioral scenarios on the same
fixtures and pinned host/model versions, collecting actual input/output/cache
usage, tools called, bytes returned, retries, p50/p95 wall time and acceptance
outcomes. Compare warm/cold policy discovery separately and keep failure cases.
Use the existing eval/telemetry infrastructure, not another benchmark framework.
CI keeps static tests and fixture size accounting separate from paid model evals.
Require acceptance quality to remain stable before treating lower tokens as a win.

## Explicit answers to the architectural questions

1. Recent Skill improvements absent from CLI: dependency-aware selection, strict
   issue-review failure handling, explicit closure, local-only discovery, coherent
   current-branch behavior, and context reuse guidance. Some broader invocation
   choices also remain Skill-only.
2. Deterministic checks, selection, output contracts, safe local discovery and
   explicit persisted delivery choices belong in the CLI and were implemented.
3. Conversational grouping/refinement, architecture judgment, arbitrary content
   interpretation and full Skill invocation vocabulary should not be ported blindly.
4. Actual duplicated behavior was task validation/selection, phase declarations,
   closure and some prompt instructions. Generated copies are not author duplication.
5. Schemas own shape; domain functions own graph/hash/naming; workflow metadata owns
   phase mapping; shared prose owns methodology; each consumer owns runtime state.
6. Current-agent methodology and portable request/choice interpretation remain Skill-only.
7. Agent process orchestration, SQLite, locks, queues, retry/telemetry/web remain CLI-only.
8. Pure inspection/eligibility/phase metadata become shared, extending existing shared domains.
9. Packaged procedures, references, bundles and prompt contracts are shared at build time.
10. Waste lies in full unneeded plan prose, mandatory help, repeated policy/input reads and retried invalid state.
11. Avoidable calls include unconditional help and remote discovery for local-only work.
12. Code handles schema/hash/graph validation, eligible IDs, current branch checks and result parsing better.
13. Moving decomposition, acceptance judgment or scope negotiation into CLI rules would reduce flexibility.
14. Keep exact-byte CI checks before generation, semantic parity tests, installed consumer tests and behavioral evals.
15. Yes, evolve `skills-src`; do not replace it.
16. It continues owning portable methodology, manifest and shared prose, not CLI sessions.
17. Existing `core`, `schemas.ts`, `issues`, `conventions` and `scaffold` are sufficient; no new top-level layer.
18. Generate CLI prompt resources, as already done; generating duplicate TypeScript constants has no benefit.
19. Generate phase reference metadata; keep reasoning prose authored. Do not synthesize every instruction from schemas.
20. OpenSpec contributes artifact readiness and generator/parity patterns, adapted to existing mechanisms.
21. Specsfy contributes structural progress, conditional capability context and honest context accounting.
22. Reject DSLs, custom schema resolution, plugin/specialist catalogs, new stores and mandatory CLI wrappers.
23. Discovery response is 90% smaller in the stated fixture; total speed/cost improvement is unmeasured and flow-dependent.
24. Automate static inventory plus existing isolated evals/telemetry, recording quality alongside cost and time.

## Not implemented and residual risks

No generic `context`, `next` or `validate` command family; no `--fields`, `--quiet`,
`--dry-run` or `--no-interactive` flags without an actual use; no semantic update
command; no forced host/subskill hierarchy; no new installer/updater; no runtime
store unification; no new DSL, plugins, framework or generated CLI source tree.
No automatic commits, publication or paid live model benchmark was performed.

Dependency enforcement intentionally rejects malformed old plans; missing dependencies
still means no prerequisites. Explicit closure changes the former default. Prompt
replacements remain consumer-owned and may ignore new instructions. Static tests
cannot prove agent compliance or detect every semantic drift. Local-only numbering
may later collide with remote numbering. Closure confirmation adds provider reads;
an unavailable provider leaves resumable pending work rather than inventing success.

## Validation evidence

- `npm test`: **2,238 tests passed in 174 files** on the development macOS/Node environment. Includes legacy command flows, real provider-chain fixtures, dependency eligibility, strict review outcomes, JSON/SQLite authorization preservation, confirmed closure and closure-only resume without pipeline agents.
- `npm run check`: Biome checked 429 files; TypeScript passed.
- `npm run build` and `npm run skills:check`: 151 generated resources synchronized; all eleven Skills match sources.
- `npm run skills:test`: **41 passed**, including repeated assembly equivalence, drift detection, references and copied Skill isolation.
- `npm run skills:eval -- --check`: **76 scenarios validated** for eleven Skills; this is corpus validation, not live behavioral execution.
- `npm run skills:cli-test`: installed npm payload passed actual JSON/exit-code/no-write checks, CLI-alone execution, optional integration and **53 smoke assertions**. The latest rebuilt binary's explicit-file and status output checks also passed.
- `npm run skills:install-test`: discovery of eleven Skills, individual/group/subset installation, copy/symlink, Git URL installation and revision refresh through `add` passed. The pinned installer reports `update` failure against the local Git test origin as an **observed limitation**, not a successful remote update. Global-container installation and remote update of this unpublished revision were not validated.
- `git diff --check`: passed. [Static benchmark data](2026-09-05-shared-workflow-benchmark.json) is reproducible from the accompanying script.

The first sandboxed full-suite attempt could not open local monitoring sockets
(`EPERM`). The reported full-suite pass was obtained with the required local
socket access. No production issues, PRs or personal Skill installations were
modified by these tests.
