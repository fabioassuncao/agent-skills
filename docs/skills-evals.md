# Behavioral Skill evals

[Contributing](../CONTRIBUTING.md) · [Authoring Skills](skills.md)

Structural validity does not prove useful behavior. This development-only runner addresses [issue #111](https://github.com/fabioassuncao/issue-flow/issues/111) using the same Claude, Codex, Cursor and Antigravity adapters as the CLI. Evaluators, harness libraries and scenarios are not shipped in Skills or the npm runtime package.

## Run

From `packages/issue-flow`:

```bash
npm run skills:eval -- --check
npm run skills:eval -- --list
npm run skills:eval -- --agent claude --scenario review-fresh-evidence,convert-standalone
npm run skills:eval -- --agent codex --scenario review-fresh-evidence,convert-standalone
npm run skills:eval -- --agent claude --kind positive
npm run skills:eval -- --agent claude --kind negative
npm run skills:eval -- --agent cursor --split holdout
npm run skills:eval -- --agent claude --kind behavior --timeout 180000
npm run skills:eval -- --agent claude --scenario convert-standalone --baseline 557bcec
npm run skills:eval -- --agent codex --scenario convert-standalone --without-skill
npm run skills:benchmark -- --agents claude,codex,cursor --scenario analyze-local,execute-regression --repeat 2 --baseline 557bcec --without-skill
```

`--output <path>` selects the evidence JSON; the default is ignored `.cache/skills-evals/` in the package. Real runs require the selected harness installed/authenticated and consume its normal tokens. No model is silently selected. Provider/version and reported model/usage are recorded; a null model means the harness default was not identified. Each case gets a temporary Git fixture and copied Skill, removed afterward. Personal Skill installations and home directories are not replaced.

`--check` validates versioned scenarios and coverage without a model. Main CI uses this inexpensive check. Real evals are **on demand**, non-gating until cost and variance have a measured baseline. The CLI invocation is the on-demand mechanism; ordinary contributions need no model credentials.

`skills:benchmark` runs at most one invocation at a time for each selected provider while providers run in parallel. The candidate arm is always present. `--baseline <sha>` adds the generated Skill or CLI prompt from that commit; `--without-skill` adds a no-Skill arm for behavior cases. `--repeat` measures variance and reverses arm order on alternating repetitions to reduce ordering bias. The command writes JSON evidence and a Markdown summary with pass rate, harness/verifier errors, wall time, tool calls and every usage field actually reported by the harness. Missing usage remains `null`; it is never treated as zero. A nonzero exit means at least one run failed or the environment prevented evaluation, while the report still separates those outcomes.
Choose a bounded set with `--scenario` or `--split`; the default safety ceiling is
120 model invocations. An intentional larger run must state
`--max-invocations <n>` explicitly.

## Contracts and interpretation

[`evals/skills/scenarios.json`](../evals/skills/scenarios.json), `schemaVersion: 1`, contains unique IDs, Skill, kind, user prompt, fixture, assertions and rubrics. Every Skill has positive, negative and behavior cases. Selection cases may declare `split: "development" | "holdout"`; omitted means development. Every Skill has an implicit positive and a near-neighbor/overlap negative in holdout so description edits can be checked against prompts that were not used to write them. Pressure cases cover stale evidence, invalid GENERAL findings and regression reproduction before correction.

Positive/negative cases test **catalogue selection** from name/description: positive expects the nominated Skill; negative forbids it while allowing another Skill or none. They do not certify native automatic activation. Behavior cases explicitly load one installed Skill and inspect outcomes in the fixture. Assertions cover created files, JSON, preserved source, actions and final structured results. `manualReview: true` means automated success is only a smoke pass until the rubric is assessed. Required result fields are a machine-readable contract, not an exact-prose comparison. No chain-of-thought is evaluated or saved.

Result schema version 1 records harness/version, arm, baseline SHA, corpus/artifact hashes, duration, usage, final response, tool actions (full command/path fields when emitted), relevant artifacts, failed assertions and rubric. The runner never saves raw streams or thinking events. Only synthetic fixtures belong in the corpus/evidence; never add secrets or customer data.

| Status | Meaning | Next step |
|---|---|---|
| `PASS` | Observable assertions passed | Assess manual rubric where marked; repeat to measure variance |
| `FAIL` | Harness completed but assertions failed | Inspect whether the Skill or the verifier is wrong |
| `VERIFIER_ERROR` | The evaluator itself threw after a harness response | Fix the verifier and rerun; do not score as a Skill failure |
| `HARNESS_ERROR` | Missing binary, unsupported flag, authentication, timeout, process error or absent baseline artifact | Repair environment and rerun; do not score as Skill failure |

Correct defective assertions and rerun the identical case. Do not weaken valid acceptance criteria to improve scores. Older evidence captured abbreviated normalized commands; the current observer retains emitted command/path fields without keeping thinking or unrelated payloads. Ordering claims still need rubric review. Global/enterprise skills and system instructions may remain visible despite project settings; explicit artifact selection is not proof of total host isolation.
Cursor evals use its force mode plus the vendor sandbox only to trust the newly
created disposable workspace; the production permission mapping is unchanged.
Read-only outcomes in this harness are verified by assertions, so these runs do
not certify Cursor's plan-mode permission boundary.

## Add a case

A behavior scenario may declare `cliReview: {issueFile, tasksFile}` or
`cliExecute: {issueFile, tasksFile}` pointing to its fixture files. That case loads
the corresponding generated CLI prompt without installing Skills and binds local
context paths. Review uses read-only permissions; execute uses workspace permissions
and the shared execution projection.
Evidence identifies `surface: "cli-prompt"`; ordinary cases use `"skill"`.
This exercises the prompt's behavior, not the complete CLI lifecycle or L2.
Baseline and candidate use the same fixture and assertions. `execute-long-progress`
isolates context selection without commits; the existing commit cases retain
their real-Git assertions even on harnesses whose sandbox disallows `.git` writes.

`npm run context:measure -- <baseline-sha>` measures generated prompt/entrypoint
bytes, characters and lines, resource sizes, contract consumers and a synthetic
execution projection. Tokens are explicitly estimated as `ceil(characters / 4)`.
These measurements cannot establish runtime savings, native activation quality
or cache hit rates; compare live harness usage separately.

Use a minimal fixture exposing a real boundary. State the user task without embedding the expected answer. Add observable conditions and a rubric explaining their link to intent. Include negative near-neighbors when descriptions change; keep baseline/candidate fixtures identical. Reuse existing adapters for additional harnesses rather than creating provider-specific Skill content.

[Measured runs and limitations](research/2026-09-05-skills-portability.md) are dated evidence, not normative rules. Native cross-agent activation and remote update lifecycle require their own observed runs.

## Git fixture assertions

The development-only runner commits each scenario's source fixture on `main`
before invoking the model. Installed Skills are excluded from source history and
Git status. Optional `git` setup declares `initialBranch`, additional `branches`,
`detached`, recent commit-message `history`, and post-commit `dirty` file contents.
Setup accepts data, not arbitrary shell commands; escaping paths and `.git` files
are rejected. Identity/signing settings are local to disposable fixtures. Existing
execution cases declare their local base explicitly so the branch guard can work
without a remote.

Assertions with `target: "git"` can check `branch`, exact `branches`, `commitCount`,
`commitPattern` for every new commit, `unchangedRefs` and `commitsOnBranch`. The
runner compares actual Git state with its pre-invocation snapshot and saves both
snapshots in evidence. New commits are counted across all refs plus HEAD, excluding
initial history; a claimed commit without a real commit fails. An `unchanged`
file assertion compares with its dirty pre-invocation contents when supplied.

Git state verifies outcomes, not complete operation ordering: temporarily changing
branches and restoring them cannot be disproved by a final snapshot. Invocation
cases therefore also inspect recorded actions and use manual rubrics for checkout
before edits, no transient switch, grouping approval and source-to-story mapping.
`--check` only validates the corpus; deterministic tests validate fixtures and the
verifier. Neither substitutes for an opt-in live-model behavior run.

## PR metadata fixtures

The `pr-metadata-*` scenarios use a synthetic GitHub capability from
[`evals/skills/fixtures/github-pr.mjs`](../evals/skills/fixtures/github-pr.mjs).
It exposes a label registry, a published diff, eligibility, PR creation, additive
updates and remote-state verification without network access. It can retain a
created PR while failing a metadata operation, once or persistently. The fixture
does not classify changes for the agent.

Optional `fixtureFiles` maps scenario destination paths to files under
`evals/skills/fixtures/`. The runner validates containment, expands them before
hashing the corpus, and copies them into each isolated fixture. Inline and shared
fixtures cannot overwrite each other. The published diff supplied by this mock
is authoritative: local fixture branches are snapshots, not simulated remotes.

Cases cover backend corrections, documentation mentioning an API, grouped
architecture/documentation work, consumer vocabularies, stale issue labels,
explicit fields, unavailable labels, adoption, preservation of manual metadata,
and recovery after partial publication. Assertions inspect the persisted PR and
operation counts; a claimed label in an answer or request is insufficient. Manual
rubrics still check discovery order, body quality and duplicate notifications.
Deterministic tests validate this capability and its verifier, not model behavior.
