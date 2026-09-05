# Agent Skills architecture and portability audit — 2026-09-05

## Scope and diagnosis

Audited the complete `skills/` tree: ten entrypoints, ten READMEs, all owned and
shared references, and the bundled hash script. Also inspected build/sync/check
scripts, both CI workflows, CLI prompt includes, parity tests, documentation,
the Claude-only orchestrator, and related open/closed issues. Starting checkout:
`0aefe5b` (clean). No live issue, PR, installation or release was mutated.

The architecture already separated Skills from the CLI and composed shared
contracts at build time. It was substantially ahead of its old descriptions,
but several claims exceeded evidence: raw source directories were incomplete;
the advertised publication branch was absent; YAML validation was a custom
approximation; runtime instructions still attempted a CLI download; and review
examples contained invalid GitHub CLI commands. Existing tests mainly checked
the happy path and prose invariants.

The correction is incremental: retain source composition and the existing
contracts, improve instructions and artifact validation, remove automatic CLI
installation, and document what was actually tested. Canonical development
rules live in [Agent Skills](../skills.md); this report records evidence and
limitations rather than creating another policy source.

## Normative baseline

Read the requested [overview](https://agentskills.io/home),
[specification](https://agentskills.io/specification),
[Anthropic platform overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview),
[Microsoft SDK documentation](https://learn.microsoft.com/en-us/agent-framework/agents/skills?pivots=programming-language-csharp),
and [MCP guidance](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-with-agent-skills).
The Microsoft URL initially failed through the web reader; the same document
without its pivot query loaded successfully.

The portable core is a directory with `SKILL.md`, YAML metadata and optional
resources. Neither provider tool names, installation directories, permission
escalation nor slash syntax is universal. The <500-line/<5k-token guidance is a
recommendation that Issue Flow promotes to a project gate. ASCII naming and no
`allowed-tools` are deliberate stricter compatibility choices, not assertions
that the specification prohibits Unicode or experimental fields.

The [capability matrix](../skills-compatibility.md) separates specification,
documented host support, extensions and unknowns across Claude Code, Codex,
OpenCode, Antigravity CLI, Cursor, Copilot CLI, Gemini CLI and Microsoft Agent
Framework. Product documentation alone is not execution evidence.
Antigravity's general application guide documents standard Skill directories,
while its CLI guide describes flat Markdown commands and another global path.
The matrix records this product distinction as unverified CLI compatibility,
not proof that the same directory loads in both surfaces.

## Inventory and conformance matrix

All rows passed the reference metadata validator and isolated artifact checks
after correction. “Portable” here means **the built directory**, not raw
`skills/<name>` from the source checkout. No row needs Issue Flow CLI; `B`
means an optional CLI optimization. Model behavior beyond the smoke below
remains unverified.

| Skill | Responsibility / required capabilities | CLI | Format + isolated refs | Body size (lines, approximately) | Problems found and action |
|---|---|---|---|---|---|
| `analyze-issue` | Scope analysis; Git + remote/local issue text | B policy | PASS | 125 | Description and README excluded local use; include local trigger and offline lookup boundary |
| `generate-prd` | PRD from text; filesystem | B policy | PASS | 125 | README implied another Skill prerequisite; remove it; use applicable project check instead of invented typecheck |
| `convert-prd-to-json` | PRD → plan; Git + filesystem | B naming | PASS | 155 | `mv` examples overwrite archive and suppress errors; preserve plans even with empty log, require unique destination, preserve same-feature progress |
| `execute-tasks` | Implement plan; Git + project tools | B policy/naming | PASS | 197 | Branch switching did not protect existing changes; stale evidence/browser failure could still lead to completion; strengthen evidence and pending-state rules |
| `create-pr` | Publish current branch; Git + GitHub tools | B policy/naming | PASS | 193 | `gh` hard failure contradicted tool alternatives; existing remote branch skipped new commits; base guessed from existence; body deleted on failure; correct all four |
| `generate-issue` | File GitHub demand; Git + GitHub tools | B policy | PASS | 201 | Trigger captured ordinary “fix code”; missing gh blocked equivalent tool; unrelated comments automatic; narrow trigger and authorization; preserve failed draft |
| `generate-local-issue` | Local backlog; files + POSIX shell + Node/Python | B policy/handoff | PASS | 172 | “Never network” contradicted remote lookups; script path unclear; directory collision incomplete; hash fallback drift; offline default, explicit coordination, exclusive directory, tested hash |
| `init-repository` | Fill convention gaps; Git + writable repo | B init | PASS | 162 | General project bootstrap trigger too broad; clarify conventions; keep existing non-overwrite procedure |
| `review-issue` | Conformance; Git + text + tests | B policy | PASS | 182 | Local issue unsupported, comment automatic, `main` fallback despite prohibition; local reading, explicit publication, resolved base |
| `review-pr` | Whole PR review; Git + GitHub tools | B policy/naming | PASS | 214 | Unsupported `gh pr diff --stat` and path filter; checkout/head confusion; existing directory implied write permission; valid operations and explicit saving |

All ten descriptions were reviewed for overlap. Existing coherent boundaries
were retained; broad backlog/bootstrap triggers and missing local-analysis
triggers were narrowed. Instruction revision metadata is now `"2"`. The longest
entrypoint remains below 220 lines. Large schemas/reports/templates already
live in references; creating empty `assets/` folders would add no value.

## CLI dependency classification

| Dependency | Class | Resolution |
|---|---|---|
| `npx --yes issue-flow@latest policy --json` in shared conventions | A unnecessary | Removed; no runtime package download |
| Policy JSON, naming commands, init plan/apply | B optional optimization | Explicit local fallback and unavailable-provider behavior |
| `issue-flow run <id> --local` after local creation | B optional handoff | User can keep using agent/ordinary files |
| `tasks.json`, progress and structured result markers | Shared artifact/protocol contract, not runtime dependency | Retained, bundled and parity-checked; another agent or human can produce/consume them |
| Global SQLite/session/journal/telemetry | CLI/workflow responsibility | Not read/written by canonical Skills |
| `agents/resolve-issue.md`, named tools and bypass-permissions | Optional Claude adapter/workflow | Kept outside `skills/`; not a portable Skill |

There are **no C dependencies** in the ten current Skills. A future capability
that truly requires runtime state must declare it in compatibility and should
first be considered as a CLI operation or structured tool.

## Findings by severity

**Critical for distribution/data preservation**

- Advertised `skills` branch returns 404, and raw source copying leaves shared
  references missing. Local validated build is usable; remote publication is
  not claimed complete. Standardized selection examples on explicit `--skill`.
- Archive instructions could overwrite existing artifacts and hide move errors.
  Replaced them with preservation/unique-destination/error-stop instructions.
- Build accepted arbitrary `--out` then recursively deleted it. It now restricts
  in-repository destinations and replaces only an owned tree, with regression
  tests proving unrelated files survive.

**Important**

- Hidden automatic CLI download, even in a surface advertised as independent.
- Malformed YAML, duplicate keys, typed metadata, anchors, reference-style links,
  nested resources and symlinks could escape the old validator. Replaced YAML
  parsing with `yaml`, Markdown traversal with `marked`, anchors with
  `github-slugger`, and added negative fixtures.
- `gh pr diff --stat` and `gh pr diff PR -- path` are unsupported by installed
  gh 2.98.0 and its [manual](https://cli.github.com/manual/gh_pr_diff).
- Offline/network, gh/alternative-tool and review/publication contradictions.
- Node and Python hash normalization differed on BOM, NEL and control whitespace.
  Reproduced a failing parity test, fixed Python to match ECMAScript trimming,
  then passed Node/Python/CLI cases including Unicode and CRLF.
- Publication could move a release tag and let an old release reset the latest
  channel. Tag pushes are now non-force; only main updates the moving channel.

**Improvements**

- Short human READMEs now point to canonical procedures instead of duplicating
  schemas, old naming examples and side-effect rules.
- Built individual Skills now carry the repository's MIT license text.
- Input handling is one shared, bundled contract. Generated files do not become
  new independently maintained sources.
- Checker success no longer claims complete specification/behavior certification.

## Mature implementations: inspected patterns, not assumed correctness

Public repositories were shallow-cloned and inspected at these commits:

| Project | Revision | Structure/distribution and lessons |
|---|---|---|
| [Specsfy](https://github.com/promovaweb/specsfy/tree/a73aab3b7ad771e2eea2178af85520eca4f6e2ae) | `a73aab3` | 19 entrypoints, 34–319 lines; numbered procedures, Node scripts, references and optional `agents/openai.yaml`; separate CLI installer uses ecosystem `skills` |
| [Superpowers](https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797) | `b36e082` | 14 entrypoints, 63–679 lines; supporting files/scripts, plugin/bootstrap integrations and host-specific tests; verification and pressure scenarios |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec/tree/e062b9572be933564ba3899d059377dfa1393e32) | `e062b95` | 12 entrypoints, 76–560 lines; workflow templates produce Skill and command surfaces, shared path/generation/equivalence tests |

Counts are from each checkout's `skills/*/SKILL.md`, not an ecosystem survey.
None has to satisfy Issue Flow's exact individual-distribution contract.

**Specsfy:** `skills/specsfy-update-spec/SKILL.md` routes detailed classification
to a reference and runs a deterministic script. Its CLI installer and lock-file
code demonstrate delegating installation rather than building another package
manager. However, mandatory `specsfy-setup`, `.specsfy/Spec.md`, cross-Skill
references and installed `.agents/skills/...` paths assume a composed framework.
Useful: scoped descriptions, deterministic helpers, installer reuse. Not
adopted: mandatory bootstrap/whole-framework state for each independent Skill.
Its `skills/templates/` contains output material; no need to reproduce that
layout when Issue Flow already has small annotated references.

**Superpowers:** inspected `using-superpowers`, verification/debugging guidance,
pressure scenarios and host tests. Useful: test observable responses to pressure
and require fresh evidence before completion. Already assigned to #111. Not
adopted: universal forced activation, global bootstrap, mandatory dependent
Skills or provider tool-mapping tables inside every Skill. Some entrypoints
exceed our size gate, so maturity is not proof of compliance with our contract.
Its plugin manifests/releases version the bundle; no equivalent plugin layer
is needed simply to distribute Issue Flow directories.

**OpenSpec:** `src/core/shared/skill-generation.ts` renders common workflow
instructions and metadata; generation/path/equivalence tests guard multiple
surfaces. Reusable: build-time composition with parity. Its generated metadata
explicitly says the OpenSpec CLI is required, and includes `allowed-tools`;
this is honest for runtime-specific workflows, but unsuitable as Issue Flow's
portable default. A full adapter matrix is more machinery than our shared
contracts need. We retain minimal CLI process adapters, not per-harness Skill
forks. All three projects use repository/package revisions; none supplies a
universal Skill dependency resolver that would make sibling imports safe.

## Architectural decisions

- **Skill vs CLI:** Skills own procedural knowledge; optional CLI calls are
  accelerators. The CLI owns runtime state and deterministic orchestration.
- **Skill vs workflow:** sequential instructions remain useful without an engine;
  durable retry/resume/parallel guarantees stay with the engine.
- **Skill vs MCP:** structured external tools complement instructions; no MCP
  requirement or custom MCP distribution service was introduced.
- **Shared rules:** retain composition for schemas, conventions and output
  protocols. CLI prompts include generated contract text; Skills bundle it.
  Unit tests establish byte/structural parity, not model-level equivalence.
- **`_shared`:** development source only, never a runtime sibling dependency.
  Built directories are independently copyable. No generated references are
  committed, respecting the existing repository decision.
- **Distribution:** local build works now. Keep the existing generated-branch
  design, with its limitation clearly visible; no new registry, installer,
  per-provider trees or hosted discovery service.
- **Adapters:** the Claude sub-agent is isolated. Core Skills refer to
  capabilities. Host-specific invocation and restrictions stay outside them.

A default-ref installation remains incomplete by design. Making plain
`npx skills add fabioassuncao/issue-flow` work would require changing the source
layout or committing an assembled tree. That is a separate distribution decision
with compatibility/migration implications; documentation alone does not fix it.

## Changed files and rationale

| Files | Change |
|---|---|
| All ten `skills/<name>/SKILL.md` and `README.md` files | Reviewed triggers and revision metadata; corrected the procedures listed in the inventory; reduced duplicate human documentation |
| `skills/_shared/contracts/{repository-conventions,duplicate-detection,tasks-schema}.md` and new `safe-inputs.md` | Optional CLI/offline behavior, authorization, applicable verification and one bundled input-safety contract |
| `skills/generate-prd/references/prd-structure.md` | Quality gates follow the real project's toolchain |
| `skills/generate-local-issue/references/local-issue-files.md` and `scripts/content-hash.sh` | Exclusive output allocation and consistent Node/Python normalization |
| `scripts/skills-format.mjs`, `validate-skills.mjs`, `skill-contracts.mjs` | Standard YAML/Markdown parsing, strict artifact checks and parser-derived composition |
| `scripts/build-skills-tree.mjs` | Guard output replacement, preserve executables, include individual licenses |
| `.github/workflows/publish-skills.yml` | Install development parsers, correct installer syntax, protect stable tags/current channel |
| `packages/issue-flow/package.json` and lockfile | Add development-only parser dependencies |
| `packages/issue-flow/src/policy/skills-validation.test.ts` and `skills-structure.test.ts` | Thirty regression cases plus accurate checker assertions |
| `docs/skills.md`, `skills-compatibility.md`, `skills-evals.md`, `skills-and-agents.md`, this report, root and Skills READMEs | Canonical development/distribution contract, sourced compatibility, eval catalogue and explicit limitations |

The local `dist/skills/` tree is the validated installable artifact. Generated
files remain ignored; no published branch, tag or release was created here.

## Behavioral smoke

Executed the same explicit-use local analysis prompt against copies of the
built `analyze-issue` directory in a temporary Git fixture. Inputs were
`src/total.js` (quantity × unitPrice), local issue 42 requiring rejection of
negative quantities, and `package.json` with `node --test`. No real remote.
The prompt forbade edits/network and other Skills. This tests instruction use,
not automatic discovery quality.

| Harness | Invocation controls | Result |
|---|---|---|
| Codex CLI 0.153.4 | `exec --ignore-user-config --ephemeral --sandbox read-only --json`, 90s process cap | Exit 0, 42.47s; trace showed project Skill and safe-input reference read, real issue/code inspected, only read commands |
| Claude Code 2.1.261 | `-p --setting-sources '' --strict-mcp-config`, only Read/Glob/Grep, no session persistence, $1 cap, 90s process cap | Exit 0, 37.43s; final result reported the local Skill, correctly scoped negative/zero/positive behavior; no write tools available |

File hashes before/after matched. Both identified real affected code and the
missing tests without implementation. Codex recorded 87,220 input tokens
(75,520 cached) and 692 output; cost was not reported. Claude reported $0.15314
and models `claude-opus-5[1m]` plus a small Haiku auxiliary call. Codex's actual
model was not included in the saved result; it remains unknown. Effort was not
pinned, and installed metadata could still contribute context. Therefore these
rows are **not a model-performance comparison or isolated selection benchmark**.

Claude's JSON result did not contain a full tool trace, so its exact resource
load sequence is self-reported rather than independently traced. Read-only
capabilities and unchanged artifacts are observed. The temporary harness calls
were one-off smoke probes; #111 remains the owner of a reusable eval runner.
No reasoning trace or raw private-session material is committed.

## Tests and validation

The npm commands below run from `packages/issue-flow` (or use
`--prefix packages/issue-flow` from the checkout root).

- `npm run skills:sync`: generated the ten CLI prompt contract includes.
- `npm run skills:check` and `skills:verify`: source and strict artifact gates.
- Reference validator `skills-ref` 0.1.0, source revision
  `69ef37e9424c0a7ea9dd2293b559e43ec8176379`: all ten built Skills PASS.
- New negative artifact fixtures plus existing structure/policy parity tests:
  53 tests passed at the final focused checkpoint (30 new tests). Includes actual individual copies,
  source parity, output preservation and Node/Python hash equivalence.
- `npm run check`: Biome checked 409 files, then TypeScript passed.
  Root build/check scripts also passed Biome using the package's configuration.
- Full `npm test`: 173 files / 2,242 tests passed with localhost access enabled.
  The first sandboxed attempt had 60 failures in five server-related files due
  to `listen EPERM` on 127.0.0.1; the unrestricted rerun passed. Three additional
  validator cases were then added and the final focused 53-test run passed.
- `npm run build`, `node packages/issue-flow/dist/cli.js --help`, and
  `git diff --check`: passed.
- Codex/Claude explicit-use smoke above; no full ten-Skill/two-harness matrix.

## Issues and pending work

Reviewed open and closed issue bodies before implementation:
[#111](https://github.com/fabioassuncao/issue-flow/issues/111) (behavioral evals,
open), [#107](https://github.com/fabioassuncao/issue-flow/issues/107) (continuity,
closed), [#61](https://github.com/fabioassuncao/issue-flow/issues/61) (policy parity),
[#77](https://github.com/fabioassuncao/issue-flow/issues/77) (Git naming),
[#90](https://github.com/fabioassuncao/issue-flow/issues/90) (runtime benchmark).
Also related: #62/#76/#80/#87 (harness layer), #79/#89 (instrumentation), #110
(optional historical context). Existing roadmap is sufficient; **no new issue,
issue comment, issue edit or PR was published**. Work is related here locally.

Next steps: publish this checkout's workflow and verify the generated channel;
make the default-ref distribution decision explicitly; run #111's repeated
selection/pressure cases with unavailable CLI and controlled tool providers;
expand execution coverage to OpenCode, Antigravity, Cursor, Copilot and Gemini.
For Antigravity CLI, first probe directory/resource loading to resolve the
documentation distinction before considering a minimal adapter.
Do not mark those clients failed because they were not run.

## Final assessment

| Axis | Status | Evidence / remaining step |
|---|---|---|
| Agent Skills compliance | PASS for built artifacts | Ten official metadata checks plus stricter local gates |
| Portability | PARTIAL overall | Individual built copies PASS; raw source/default-ref installs incomplete and public channel not yet verified |
| CLI independence | PASS | No required CLI path, removed download, two-harness local smoke |
| Cross-agent compatibility | PARTIAL | One Skill in two harnesses; Antigravity CLI directory support unverified; broader behavioral matrix pending #111 |
| Progressive disclosure | PASS | Small bodies, directly linked resources; human docs no longer duplicate procedures |
| Validation/tests | PARTIAL overall | Deterministic regression/metadata gates pass; repeated selection/pressure eval runner pending #111 |
| Documentation | PASS | Canonical guide and matrices describe implemented behavior and limitations |
