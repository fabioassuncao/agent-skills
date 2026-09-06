# Prompt, context and knowledge-sharing audit

Date: 2026-09-05. Source of truth: `develop` at
`24662d3ca1a0e6349292e2c8f3547d1d06c9b265`, verified against `origin/develop`
before implementation. Implementation commit: `87ae3c58e9bc608f2e92a911564113f036ec5220`.

This is dated investigation and implementation evidence, not another source of
runtime rules. Normative ownership remains in [architecture](../code-organization.md),
[Skills](../skills.md), [storage](../storage.md), [conventions](../conventions.md),
[verification](../verification.md) and [evals](../skills-evals.md).

## 1. Executive summary

The pre-analysis was mostly confirmed. The project already has the right runtime
boundaries, build-time sharing, small Skill entrypoints, deterministic contracts,
installation checks and behavioral scenarios. A rewrite would discard useful
constraints without solving the principal defects.

The highest-impact findings were loss of correction acknowledgements/blockers at
SQLite reingestion, resetting the correction budget on resume, unsafe text
substitution, and insufficient or inconsistent review evidence. These received
regression tests and targeted corrections before context reduction.

Execution now receives a deterministic projection with the current criteria,
dependencies and feedback, and retrieves historical detail only when needed.
Generated execute text fell 38.7%; all eight prompts fell 8.2%. Skill entrypoints
were already 32–54 lines and remain unchanged. These are static measurements;
this small live sample cannot establish production token, cost or latency savings.

## 2. Architecture found

The audit covered the root index and contribution guides, the requested docs,
all eleven `SKILL.md.in` files, manifest/resources/workflows, all eight prompt
sources, generation/installation/eval scripts, builders, adapters, routing,
execute/correction loops, acceptance, both review paths, schemas and persistence.
Existing research and regression tests explained why branch guards, publication
confirmation, fresh evidence and independent runtime ownership must remain.

```text
skills-src entrypoints/workflows + _shared contracts + canonical TypeScript
                     │ skills:sync (manifest copies, includes, helper bundles)
                     ├── skills/<name>/ ── host discovery ── SKILL.md
                     │                         └── needed references/helpers
prompts-src ──────────┴── prompts/ ── CLI builder + phase policy + runtime inputs
                                                  │
                                   configured headless harness/agent
                                                  │
                            code / artifacts / structured completion or verdict
                                                  │
                   Skill: consumer files       CLI: validated ingest → SQLite
                        + Git evidence             → JSON/session projections
                                                  │
                                     next phase / correction / resume
```

`AGENTS.md` is an index; rules live in its target documents. Skill artifacts are
self-contained and directly installable. Their optional CLI policy lookup has a
direct-discovery fallback. The CLI ships compiled code and packaged prompts and
never loads installed Skills. SQLite is authoritative for CLI execution history
and pipeline state; `tasks.json` is also the agent's mutable projection. Skill
files are an independent state machine, not transferable CLI sessions.

Canonical TypeScript already covers schemas, dependency graphs, naming, artifact
hashing, workflow phase/evidence mapping and strict issue-review parsing. `_shared`
contains prose contracts with matching semantics. Generation copies these into
independent distributions; generated repetition is intentional. Agent adapters
own provider flags, permissions, output parsing and usage normalization. Routing
and resilience already separate provider failure from semantic correction.

## 3. Main problems

| Priority | Observed problem | Implemented response / evidence |
|---|---|---|
| P0 | Agent ingestion retained story notes/passes but discarded cleared findings and recorded blockers | Narrow transactional updates with pre-invocation comparison for feedback/error fields; repository tests preserve newer findings, telemetry and authorization |
| P0 | Resume initialized correction cycles at zero | Restore the persisted cycle; tests exercise remaining and exhausted budgets |
| P0 | `String.replace` replacement strings interpret `$&`, and sequential passes rewrite placeholder-like issue data | Single callback substitution after evaluating template conditionals; literal-data regression test |
| P0 | A failed L2 harness could still supply approval text; contradictory reviews were accepted | Schema validation, contradiction checks and failed-invocation handling return unverified |
| P1 | L2 received an acceptance summary without sufficient repository/task identity; correction lost finding detail | Typed repository/HEAD/artifact context, JIT inspection and complete redacted findings in evidence and correction state |
| P1 | PR review could attach a result to a revision changed during invocation | Pin head/base before and compare after; invalidate recommendation and retain the report if unavailable/changed |
| P1 | Plan repair retried without explaining the JSON/schema/dependency error | Pass the latest deterministic validation error to the next attempt |
| P1 | Very small policy budgets could discard required rule-document pointers | Mandatory convention and policy paths survive the optional-context budget |
| P2 | Every execute iteration requested broad plan/PRD/progress reading | Shared execution projection; preserve logs, read current patterns/entries and retrieve other content by need |
| P2 | Non-publication phases received publication metadata | Phase-specific projection, preserving conventions and rule paths |
| P4 | Eight authored copies of the same CLI policy wrapper | One build-time include; portable discovery remains a separate workflow |
| P4 | Resolve/execute wording disagreed about who clears addressed findings | Execution acknowledges with evidence; subsequent review remains authoritative |

No P0/P1 finding was traded away for a smaller prompt. Fatal acceptance remains a
stop condition. Unverified evidence remains distinct from a verified pass.

## 4. Context analysis

Classification: **required** for the current decision; **useful** for some cases;
**retrievable** by path/tool when needed; **redundant** already represented;
**stale** historical claims; **derived/deterministic** computed without a model.

| Phase | Required context and output | Optional / retrievable context | Waste, decision and risk |
|---|---|---|---|
| init | Existing repository/configuration, applicable policy, scaffold plan and prerequisites → only missing scaffolding | Language/tool details and remote capabilities on demand | Existing deterministic plan/apply helpers already avoid broad rewriting; preserve them |
| generate / analyze | User demand or resolved issue, source identity, issue discovery vocabulary → issue artifact or analysis | Related issues, repository structure and relevant policies | Full taxonomy remains useful for classification here; do not filter it as if executing a story |
| prd | Issue objective, requirements and constraints → human-readable PRD | Code architecture and related analysis when needed | Keep supplied issue body; remove unrelated publication vocabulary, not requirements |
| plan | PRD, task schema, dependency/size constraints and target path → valid tasks.json | Repository implementation detail needed to split stories | PRD stays inline: replacing a necessary short input with another mandatory read has no demonstrated gain. Schema/dependency errors are deterministic retry feedback |
| execute | Objective, branch mode, current story/criteria, dependency status, pending findings/blocker → checked implementation, story evidence and completion/blocker signal | PRD sections, other stories, code, old decisions and relevant progress entries | Completed descriptions, telemetry and old logs are redundant for selection. Projection supplies current facts; original file remains available and must be preserved on edits |
| acceptance | Declared/discovered commands and expected files, current repository → typed checks/evidence | None for a model: L1 is deterministic | Full logs stay out of ordinary prompts. Failed output is framed diagnostic data. Both phase-boundary runs remain fresh |
| review | Issue/task criteria, current code, current checks and policy → strict PASS/FAIL protocol; L2 uses typed JSON | Evidence path, relevant correction notes, PRD ambiguities | Old PASS claims are stale. Keep fresh verification; L2 now knows which repository and artifacts to inspect |
| correction | Latest findings, requirements, relevant code and prior disposition → focused correction or evidence-backed rejection | Prior detailed logs only to resolve a specific question | Do not replay the whole review conversation. Preserve unresolved feedback and blocker; keep consumed cycle budget |
| pr | Current reviewed diff, branch/base, publication authorization, repository PR vocabulary/templates → published PR identity with confirmed metadata | Plan/PRD/story notes for human summary | Metadata is required here, not everywhere. Existing remote confirmation and partial-retry behavior remain |
| pr-review | PR number, pinned head/base, criteria/policy, report contract → revision-bound report/recommendation | Prior round path/head, changed files and focused diff | Prior report is a comparison aid, never inherited approval. Extra metadata read buys correctness |

Durable knowledge (patterns, decisions and repository docs), execution state
(stories, feedback, cycles), temporary trace (attempts) and tool output retain
different roles. No destructive compaction or LLM summary service was added.
The projection is selection, not truncation: active criteria and all pending
findings are retained without a token cap. A pathological finding list can still
be large, but silently dropping a blocker would be worse.

## 5. Prompt analysis

The main execute prompt now separates objective, workflow/invariants,
correction behavior, completion/blocker contract and dynamic context. Stable
instructions precede the changing execution projection. Other prompts keep
working phase-specific structures; a uniform heading framework would add churn.

| Information removed or moved | Why it is safe to reduce | Protection |
|---|---|---|
| Repeated CLI policy-discovery explanation | Runtime already resolves policy; one common wrapper states precedence and references | Policy precedence/budget tests, generated prompt/override tests |
| Repeated full-plan selection prose and lifecycle field instructions | Eligible story is derived by shared code; CLI owns its phase/timestamp state | Dependency/context tests, engine and ingestion tests |
| Unconditional full PRD/progress rereads | Full criteria arrive with selected story; other content remains retrievable | Standalone helper test, long-progress behavioral scenarios, preserved source JSON |
| Publication taxonomies in execute/plan/PRD/review | No publication decision occurs in those phases | Phase policy tests; PR phases retain the original metadata |
| Broad historical review context | Latest findings retain actionable details; evidence/artifact paths permit inspection | L2 evidence tests, stale-evidence behavior cases |

Completion tags and human-facing PR reports remain compatible. L2 now validates
its existing JSON contract more strictly; permissive extraction of JSON embedded
inside arbitrary text no longer constitutes a review result. The prompt explicitly
requests a single JSON object. Provider-native structured output could improve
reliability later, but is not required for correctness.

Existing few-shot formats for issue review and PR findings remain. No large new
example catalogue was added: the observed defects were mostly deterministic
boundary failures, not missing demonstrations. New examples belong in eval
fixtures until repeated ambiguity justifies permanent prompt tokens.

## 6. Skills analysis

All eleven descriptions already identify tasks and useful near-neighbor
boundaries: generate-issue versus generate-local-issue, PRD versus conversion,
execute versus resolve, and issue review versus PR review. No wording-only
rewrites were justified by the observed sample. Catalogue discovery tests remain
in the corpus; they do not prove native activation on every host.

Entrypoints are small and link directly to bundled references/helpers. Detailed
workflow and formats already use progressive disclosure. Splitting them further
would multiply reads and maintenance. This change adjusts when execute reads
PRD/progress and policy references, rather than creating dozens of new files.

Helpers continue to execute deterministic work instead of loading bundled
JavaScript into the model context. The new `plan --context --json` operation uses
only explicit files and works with the CLI absent. Skill instructions use
capabilities; proprietary permission/tool flags remain in the adapters. No new
frontmatter fields, installed-skill dependency, empty assets directory or host
requirement was introduced.

## 7. Shared architecture

Two concrete sources of divergence were removed within the existing layout:

- `core/task-plan.ts` supplies the same execution facts to the CLI builder and
  bundled portable helper. Selection/shape are shared; lifecycle ownership is not.
- `_shared/cli-repository-policy.md` is composed into all eight CLI templates.
  The identical wrapper has one authored owner. Portable discovery is deliberately
  separate because its tools, fallback and activation responsibilities differ.

Existing schema, evidence, repository-decision, review and publication contracts
remain canonical. Commit/branch naming stays in deterministic convention helpers;
phase instructions reference the resolved result. Acceptance L1 versus semantic
review, CLI completion versus Skill session completion, and publication versus
local preparation remain distinct contracts despite similar vocabulary.

Generated duplication is necessary for standalone installation. Eliminating
those bytes by pointing installed Skills at the source checkout or CLI would
break the architecture. No dependency or runtime package was added.

## 8. Changes implemented

| Component | Main authored files |
|---|---|
| Literal prompt composition | `src/core/prompt-resolver.ts` and regression tests |
| Execution context and completion | `src/core/task-plan.ts`, `artifact-files.ts`, `engine.ts`, `prompts-src/execute.md.in` |
| Agent/state boundary and resume | `src/storage/db/repository.ts`, `src/commands/run/phase-runners.ts` and tests |
| Context selection | `src/policy/placeholders.ts`, phase callers, `_shared/cli-repository-policy.md` |
| Review correctness | `src/verify/{reviewer,evidence,gate,run-issue}.ts`, `src/commands/{review,pr-review}.ts`, review prompt sources |
| Repair feedback | `src/commands/plan.ts` and document-phase tests |
| Portable execution | `skills-src/execute-tasks/workflow.md`, `resolve-issue/workflow.md`, shared plan/policy references, helper entrypoint |
| Measurements/evals | Existing benchmark/eval scripts, corpus, standalone/packed helper tests and `context:measure` npm script |
| Generated distributions | `skills:sync` regenerated affected Skills/helpers and eight packaged prompts |

Paths under `src/`, `prompts-src/` and `scripts/` above are relative to
`packages/issue-flow`; Skill sources are repository-root paths. Documentation was
updated in its canonical owners; this report contains evidence and trade-offs.

## 9. Before / after

[Full static measurements](2026-09-05-context-static.json) are reproducible with
`npm run context:measure -- 24662d3` from the package directory. Bytes, characters
and lines are **measured** from generated artifacts, including provenance headers;
tokens are **estimated** as `ceil(characters / 4)`, not model tokenization.

| Generated prompt | Before bytes | After bytes | Change |
|---|---:|---:|---:|
| analyze | 2,999 | 2,731 | −8.9% |
| execute | 9,712 | 5,956 | −38.7% |
| generate | 6,924 | 6,656 | −3.9% |
| plan | 5,713 | 5,445 | −4.7% |
| pr-review | 11,953 | 12,111 | +1.3% |
| pr | 10,900 | 10,632 | −2.5% |
| prd | 3,894 | 3,626 | −6.9% |
| review | 6,035 | 6,186 | +2.5% |
| **Total** | **58,130** | **53,343** | **−8.2%** |

| Other metric | Before | After | Interpretation |
|---|---:|---:|---|
| Eleven Skill entrypoints, bytes | 24,718 | 24,718 | Unchanged; 32–54 lines each |
| Authored CLI policy-wrapper copies | 8 | 1 | Eight generated copies remain intentional |
| All distributed Skill Markdown, estimated tokens | 87,351 | 88,408 | +1.2%; available resources are not automatically loaded context |
| Synthetic 20-story discovery input, bytes | 23,349 full plan | 1,086 context envelope | −95.3% for selection only; editing may still require original JSON |
| Same synthetic input, estimated tokens | 5,838 | 272 | Not runtime token accounting |
| Vitest assertions | 2,238 passed | 2,256 passed | Regression suite, not model quality |
| Standalone Skill/tool tests | 41 passed | 42 passed | Structural and deterministic behavior |
| Corpus validation | 76 scenarios | 80 scenarios | No-model check; not 80 live model passes |

[Selected live evidence](2026-09-05-context-live.json) retains statuses, usage,
hashes, versions and rubric assessments without transcripts. Baseline consumed
12 invocations: five Claude attempts failed with HTTP 429/session quota, then
seven Codex cases ran. Candidate consumed nine Codex invocations, including two
additional CLI execute smoke cases without a baseline counterpart. No model was
identified beyond the harness default (`model: null`). Codex was 0.153.4; Claude
was 2.1.261. No failed Claude attempt is scored as a Skill result.

| Paired scenario | Before | After | Input tokens before → after | Duration seconds before → after |
|---|---|---|---:|---:|
| review-fresh-evidence | PASS | PASS | 14,465 → 14,406 | 33.8 → 31.3 |
| execute-invalid-feedback | PASS | PASS | 18,827 → 19,551 | 59.9 → 79.0 |
| execute-current-rule | FAIL | FAIL | 38,079 → 20,896 | 87.8 → 83.0 |
| execute-current-resume-choices | FAIL | FAIL | 22,248 → 21,272 | 83.1 → 93.1 |
| pr-metadata-partial-retry | PASS | PASS | 20,931 → 36,162 | 67.6 → 64.0 |
| cli-review-fresh-context | PASS | PASS | 18,835 → 30,357 | 56.0 → 47.4 |
| execute-long-progress | PASS | PASS | 21,920 → 22,520 | 72.2 → 79.7 |

The paired observed pass rate is **5/7 before and 5/7 after**, not a claim that
five of seven production runs succeed. Both FAIL cases lack required commits;
recorded Git actions failed and the agents reported `.git/index.lock` sandbox
denial. Assertions were preserved. The two extra CLI execute cases passed,
including correction rejection and long-history resumption without installed
Skills. Their explicit no-commit requests isolate context behavior; they do not
certify commit execution.

| Paired runtime metric, seven cases | Before | After |
|---|---:|---:|
| Input tokens excluding reported cache | 155,305 | 165,164 |
| Output tokens | 9,453 | 9,535 |
| Reported cache-read tokens | 1,155,584 | 1,232,384 |
| Sum of evaluator wall time, seconds | 460.4 | 477.6 |
| Observed tool actions | 58 | 60 |

**The sample did not demonstrate runtime savings:** uncached input grew 6.3%
and summed duration grew 3.7%. One run per case, unknown default model, cache
variation and fixture-specific sandbox failures prevent causal attribution.
Some candidate cases ran concurrently with the extra smoke sample. Tool-action
counts reflect available emitted events, not every internal harness call.
Reasoning-token detail, production retries/correction rates and USD costs were
not available as comparable measures; they remain unknown, not zero.

Manual rubrics for long progress and partial PR recovery were inspected against
emitted actions, artifact contents and Git snapshots. The Skill long-progress
case still read the **entire** progress file in both versions. Thus JIT guidance
alone did not establish history-reading savings for Skills. The CLI execute smoke
used head/tail sections and preserved CLI-owned flags, but has no paired runtime
baseline. No cache-saving claim is inferred from either observation.

## 10. Quality impact

The strongest evidence is deterministic: literal user data survives composition;
concurrent CLI-owned state survives ingestion; acknowledged feedback can clear;
new blockers stop completion; resumed runs cannot replenish correction budgets;
invalid or failed L2 responses do not approve work; findings reach the next phase;
and changed PR revisions invalidate recommendations.

Behavioral cases check rejection of stale evidence/invalid feedback, current
branch choices, partial PR metadata recovery and long-history continuation.
The sample is intentionally small and does not measure a production acceptance
rate or convergence improvement. Commit-blocked fixtures remain failures and are
reported separately rather than weakening their assertions.

## 11. Token impact

Static reduction is measured; runtime savings are not guaranteed. The execute
projection removes irrelevant completed-story and telemetry detail from the
initial iteration context. JIT paths may save substantial reading on long tasks,
or may simply move tokens to later tool responses when more context is needed.
All active criteria, mandatory policy paths, unresolved findings and evidence
requirements remain available. Resources grew slightly because explicit guidance
and compatibility are preferable to silently dropping necessary information.

## 12. Latency impact

Fewer unconditional document/history reads and informative repair retries may
reduce latency (**inferred**, not demonstrated by this sample). No new model call,
summary service or discovery round-trip was introduced. PR review adds one
metadata read to detect revision changes; this deliberate cost prevents attaching
approval to an unreviewed diff. Prompt-prefix stability may help a provider cache
(**hypothetical**); no cache hit or dollar saving is attributed to it.

## 13. Trade-offs

- Kept full PRD input for planning, fresh acceptance at both boundaries, actionable
  findings, branch/commit guards, publication verification and strict stop behavior.
- Kept readable unminified helper bundles. Distribution bytes are not automatically
  model-context bytes, and installed code must remain auditable.
- Did not add a prompt DSL, new shared package, provider-specific baseline,
  autonomous compaction, evidence caching or generic prompt-component framework.
- No task schema migration, configuration change or Skill installation migration.
  `--context` is additive and the old inspection output remains valid. Existing
  prompt override placeholders remain supplied; full replacements still own their
  maintenance. Literal interpolation intentionally removes recursive substitution.
- L2's stricter parser and PR revision checks may produce more unverified results
  where older versions accepted insufficient evidence. This is a correctness
  change, not an approval-rate optimization.
- Skills and CLI still cannot resume each other's sessions. Shared data contracts
  are not a promise of shared runtime state.

## 14. Remaining opportunities

Repeat paired behavioral runs with an explicitly identified model, consistent
sandbox permissions and sufficient quota. Measure full pipelines (input/output,
reported cache, tool calls, retries, correction cycles and first-attempt success)
before attributing cost or latency changes. Cover L2 and changing PR revisions
with real harness/GitHub fixtures when authorized, beyond deterministic mocks.

A structured progress sidecar is worth considering only if JIT selection fails
repeatedly; current logs are preserved and no separate memory lifecycle is needed.
The CLI resolves its policy projection once per execute loop; targeted invalidation
when a task changes policy configuration needs its own design and eval, rather
than repeating remote discovery on every iteration.
Large findings may benefit from typed pending/resolved records, but migrating
public state without evidence of a recurring failure is premature. Provider-native
structured output, usage detail and caching belong in optional adapters after a
portable baseline is measured. Native host discovery and remote Skill updates
remain separate compatibility work.

Conceptual references were compared with actual implementation before selecting
changes. [Agent Skills specification](https://agentskills.io/specification)
supports small discoverable entrypoints and bundled on-demand resources.
[Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
informed high-signal selection, JIT retrieval and the decision not to implement
unjustified compaction. [AWS](https://aws.amazon.com/pt/what-is/prompt-engineering/),
[Google](https://cloud.google.com/discover/what-is-prompt-engineering),
[IBM](https://www.ibm.com/br-pt/think/topics/prompt-engineering) and
[OpenAI](https://developers.openai.com/api/docs/guides/prompt-engineering?api-mode=responses)
informed explicit objectives, constraints, output contracts and evaluation.
Their general advice does not override repository-specific failure evidence or
justify provider coupling. This report uses paraphrases, not copied templates.

## 15. Validation

Commands run from `packages/issue-flow`:

| Command | Result |
|---|---|
| `npm run skills:check` before changes | 11 self-contained Skills; sources current |
| `npm run skills:sync` then `npm run skills:check` | 151 resources generated; 11 Skills valid and current |
| `npm run skills:test` | 42 passed, including reproducibility, standalone helpers and fixture/verifier behavior |
| `npm run skills:eval -- --check` | 80 validated scenarios; no model-quality claim |
| `npm run check` | Biome and TypeScript passed |
| `npm test` | 2,256/2,256 passed; local socket tests require execution outside the restrictive sandbox |
| `npm run build` | Skill generation and CLI build passed |
| `npm run skills:install-test` | Discovery, individual installs, copy/symlink targets and local revision refresh passed |
| `npm run skills:cli-test` | Packed CLI independent of Skills; helper parity; 53 pipeline smoke assertions passed |
| `npm run context:measure -- 24662d3` | Static artifact and synthetic projection evidence generated |
| `git diff --check` | Passed |

Global installation was not run: its dedicated disposable-container path was not
used, and personal Skill installations were untouched. Local-source update
observation is not a remote GitHub lifecycle test. No PR, message, package or site
was published. Live evidence and manual rubric conclusions are in section 9; 21 total
invocations stayed within the per-version authorization (12 baseline, 9 candidate).
