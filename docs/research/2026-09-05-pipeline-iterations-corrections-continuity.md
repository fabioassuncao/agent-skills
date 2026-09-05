# Pipeline phases, execution iterations, correction cycles and surface continuity

> **Research document.** Investigated on **2026-09-05** for
> [#107](https://github.com/fabioassuncao/issue-flow/issues/107), at commit
> [`557bcec`](https://github.com/fabioassuncao/issue-flow/commit/557bcec93bb0c637461af430b40d527c86b66e5f).
> This document records observed behaviour and decision evidence; it changes no
> runtime behaviour. Re-check code and versions before using its numbers as a
> later baseline.

## Executive summary

The four mechanisms are real, but the evidence does not support attributing the
reported hours to orchestration alone.

1. A normal successful pipeline opens one isolated harness invocation for each
   of `prd`, `plan`, `review` and `pr`, plus one per execution iteration. With
   `N` stories and the current effective batch size of one, the minimum is
   **`N + 4` model invocations**. The Issue is resolved only once by the CLI,
   but its body, derived artifacts and repository context cross several prompt
   boundaries.
2. Execution has no session continuity. `storiesPerIteration` exists in the
   engine and prompt, defaults to `1`, but has no CLI, environment or JSON
   configuration input at this commit. For users it is therefore not an
   available grouping option yet.
3. Every non-zero `review` result enters the same correction loop. Only the LLM
   conformance review and the optional independent review persist actionable
   `lastReviewFindings`; contract failures and operational harness failures do
   not. The loop is consequently well connected for review findings, but too
   coarse for the other failure classes.
4. Skills and CLI do not share a live state store. There is, however, a
   **one-time conditional handoff from skills to CLI**: legacy artifacts are
   copied to global storage and structured state is imported into SQLite when
   the global destination is absent. Later skill writes are not synchronized,
   and CLI state is never exported back to the repository tree.

The current paid benchmark cannot answer the comparison requested by #107: its
live runner always calls the pipeline, including for corpus entries marked
`strategy: direct`, and experiment arms other than `L2` change tuple metadata
without changing the actual invocation. A paid campaign now would produce rows
that look comparable but do not implement the declared direct/pipeline or
`strict-mcp` contrast. Historical #79 measurements remain context, not proof of
the current version.

## Evidence and method

### Evidence levels

| Level | Meaning |
|---|---|
| `VERIFIED_CODE` | Read in `557bcec`, with a fixed source link below |
| `VERIFIED_TEST` | Existing focused tests executed locally at that commit |
| `VERIFIED_EXPERIMENT` | Reproduced in disposable repositories on 2026-09-05 |
| `HISTORICAL` | Measurement from #79, useful as context but not current proof |
| `HYPOTHESIS` | Plausible explanation that still needs a valid controlled campaign |

Environment:

| Component | Version |
|---|---|
| macOS | `26.5.2` (`25F84`) |
| Node.js | `v22.22.1` |
| npm | `10.9.4` |
| Claude Code | `2.1.261` |
| Codex CLI | `0.153.4` |
| Issue Flow source | `557bcec` |

The investigation used four sources:

- static tracing from phase runner to agent subprocess and persisted state;
- existing unit/integration tests for execution, review, resume, migration and
  the benchmark;
- the free synthetic benchmark, repeated after a warm-up;
- two disposable-repository handoff experiments: skills → CLI and CLI → skills.

No real paid campaign was run. This is not a missing sample represented as zero:
the current runner does not implement the controlled contrasts #107 asks for,
so spending on it would not turn the result into valid evidence.

### Current synthetic observation

After `npm run build`, `issue-flow bench --mode synthetic` completed. A warmed
run of 1,000 reducer samples, 1,000 schema-parse samples and 400 corpus rows
gave:

| Operation | p50 | p95 | n |
|---|---:|---:|---:|
| Reduce scripted session | 0.007 ms | 0.009 ms | 1,000 |
| Parse session snapshot | 0.015 ms | 0.021 ms | 1,000 |
| Synthetic corpus overhead | 0.023 ms | 0.029 ms | 400 |

`VERIFIED_EXPERIMENT`, but deliberately narrow: the synthetic corpus measures
the reducer and snapshot schema around a fixed mocked harness duration. It does
**not** measure provider startup, prompt reconstruction, filesystem/Git work,
quality commands or the five pipeline phases. It confirms only that these two
in-process projections are not a measurable contributor here.

## 1. Separate PRD, plan, execute, review and PR phases

### Current behaviour

`VERIFIED_CODE`: `buildInstrumentedPhaseRunners()` constructs distinct runners
for [`prd`, `plan`, `execute`, `review` and `pr`](https://github.com/fabioassuncao/issue-flow/blob/557bcec93bb0c637461af430b40d527c86b66e5f/packages/issue-flow/src/commands/run/phase-runners.ts#L225-L263).
Each document phase calls `runHeadless`; the execution loop calls the harness
once per iteration. `runHeadless` states and implements that
[each invocation is isolated](https://github.com/fabioassuncao/issue-flow/blob/557bcec93bb0c637461af430b40d527c86b66e5f/packages/issue-flow/src/core/headless.ts#L171-L177).

For a successful run with `N` stories and batch size `B`, excluding `init` and
any retry/L2/PR-review call, the lower bound is:

```text
1 prd + 1 plan + ceil(N / B) execute + 1 review + 1 pr
= 4 + ceil(N / B) isolated model invocations
```

At the effective default `B = 1`, this is `N + 4`. `init` performs environment
checks but is not another model session.

The CLI does avoid one suspected duplication: it
[resolves the Issue once and passes the same object to every phase](https://github.com/fabioassuncao/issue-flow/blob/557bcec93bb0c637461af430b40d527c86b66e5f/packages/issue-flow/src/issues/context.ts#L48-L74).
The phase prompts still deliberately repeat or derive context:

| Boundary | Context carried forward |
|---|---|
| Issue → PRD | Issue body in the prompt; agent explores the repository and writes `prd.md` |
| PRD → plan | Issue body plus the whole PRD embedded in the prompt; agent writes `tasks.json` |
| plan → execute | Absolute paths to `tasks.json` and `progress.txt`; each isolated agent reads both and repository policy documents as needed |
| execute → review | Acceptance commands run, then a fresh read-only agent receives the Issue and task-plan path and re-examines the tree |
| review → PR | A fresh agent receives Issue and task-plan context and inspects Git history/diff before calling `gh` |

The artifact boundaries have observable benefits: deterministic phase resume,
human-readable requirements, an ordered execution contract, independent review
and recovery without provider session state. They also make PRD and plan
mandatory even when a small Issue already contains complete acceptance
criteria. There is no current complexity gate or issue-to-execute fast path.

### Cost finding

- `VERIFIED_CODE`: the number of isolated invocations and repeated artifact
  reads above.
- `HISTORICAL`: #79 observed 304 s for `prd`, 155 s for `plan`, and 494–541 s
  for sampled execute iterations with a different Claude Code version. It also
  estimated process/Git/sleep orchestration at about 1.3% of a 22-story run.
- `HYPOTHESIS`: small, already specified issues may not recover enough value
  from separate PRD and plan generations to pay for two extra model sessions.
  No valid current direct/pipeline row exists to quantify that trade-off.

### Conclusion

**Investigate a specific change; keep the boundaries until measured.** First fix
the real benchmark so it executes both strategies. Then compare the existing
pipeline with a proportional path for a fully specified trivial/small issue.
The experiment must preserve acceptance and review; it tests whether PRD and
plan generation can be combined or skipped, not whether verification can be
removed.

## 2. One story per iteration and context continuity

### Current behaviour

`VERIFIED_CODE`:

- the engine selects the highest-priority pending story, rebuilds the prompt and
  invokes the harness inside each loop
  [iteration](https://github.com/fabioassuncao/issue-flow/blob/557bcec93bb0c637461af430b40d527c86b66e5f/packages/issue-flow/src/core/engine.ts#L420-L500);
- `runHeadless` does not accept a prior provider session id. Provider runners
  may report a session id for telemetry, and Codex/Cursor/Antigravity advertise
  a resume capability, but the orchestrator never feeds that id into the next
  invocation;
- the prompt reads `tasks.json` and `progress.txt`, runs related quality checks,
  commits, updates the plan and appends progress on every iteration;
- [`storiesPerIteration` defaults to `1`](https://github.com/fabioassuncao/issue-flow/blob/557bcec93bb0c637461af430b40d527c86b66e5f/packages/issue-flow/src/config/engine.ts#L17-L31)
  and is interpolated into the prompt, but repository-wide search finds no CLI
  option, environment variable or configuration schema that can set it.

The #89 wording that grouping “already exists” therefore needs a qualification:
the engine has the internal field and prompt contract, while the released user
surface does not expose it. In a normal CLI run the effective value is always
one.

Retries are fresh sessions too. They re-read the plan, republish iteration
state and rebuild the prompt; retry attempts do not consume the iteration
budget, but they do repeat the context setup.

### Cost finding

The exact repeated work is confirmed; its current wall/token cost is not.
Provider prompt caching can reduce input computation, but it is not session
continuity and does not retain tool state. The historical #79 `cacheRead`
numbers show caching was active in that campaign, so “fresh process” must not
be translated into “all input tokens charged cold”.

### Conclusion

**Investigate a specific change.** Compare `1` against small bounded batches of
related stories after exposing the knob through the real configuration ladder.
Keep one commit per coherent change even when a session handles more than one
story. Treat provider-session resume as a separate experiment: it trades away
the current file/Git isolation boundary and needs crash, failover and stale
session tests before any latency claim matters.

## 3. Review → execute → review correction cycles

### What triggers a cycle

`VERIFIED_CODE`: the phase runner enters its correction loop for
[every `runReview()` exit code different from zero](https://github.com/fabioassuncao/issue-flow/blob/557bcec93bb0c637461af430b40d527c86b66e5f/packages/issue-flow/src/commands/run/phase-runners.ts#L115-L162).
`runReview()` returns `1` for four materially different outcomes:

| Outcome | Actionable findings persisted? | What correction execution sees |
|---|---|---|
| Fatal acceptance check failed | No; only `lastError`/verification evidence | All stories may already pass and `lastReviewFindings` is null |
| L2 independent review failed | Yes, claims joined into `lastReviewFindings` | Findings, but no affected-story mapping |
| Conformance LLM returned `FAIL` | Yes, verbatim `FINDINGS` | Findings, but no affected-story mapping |
| Review harness/parse/operational failure | No | No correction-specific context |

The persisted bridge is
[`lastReviewFindings`](https://github.com/fabioassuncao/issue-flow/blob/557bcec93bb0c637461af430b40d527c86b66e5f/packages/issue-flow/src/commands/review.ts#L131-L173).
The execute prompt gives that field priority over pending stories and asks the
agent to clear it only after resolving every finding. It does not reset or
select affected stories. In a correction pass where all stories already pass,
the active story id is absent and the agent receives the whole findings string.

### Repeated verification

For a correction that reaches the agent and then review again:

1. the correcting agent runs checks covering its changed paths;
2. the end of `execute` runs the full acceptance contract;
3. the start of `review` runs the full acceptance contract again;
4. L2, when enabled, adds an independent model invocation;
5. the conformance review adds another model invocation.

The double full-contract execution is intentional and documented, but its cost
must be separated from correction inference. A fatal contract failure at the
end of the correction execute returns non-zero immediately, so that path stops
as “Correction execution failed” rather than completing all configured review
cycles. Conversely, an operational review failure can cause a no-op execute
followed by another review until the correction budget is exhausted.

### Conclusion

**Keep review/fix/re-review, but investigate failure-specific routing.** Only a
review verdict with actionable findings should enter the current correction
path. Contract failures need diagnostic evidence handed directly to a fixer;
authentication/configuration/provider failures belong to resilience or human
action, not code correction. Add affected story ids when they can be derived,
and record cycle reason, duration and outcome separately from normal story
iterations.

## 4. Continuity between skills and CLI

### Storage map

| Surface | Reads/writes during normal operation | Authority |
|---|---|---|
| Skills / `resolve-issue` | `<projectRoot>/issues/{N}/` | Repository-local files |
| CLI, JSON driver | `~/.issue-flow/projects/<project-id>/issues/{N}/` | Global files |
| CLI, SQLite driver (default) | `~/.issue-flow/issue-flow.db` plus global compatibility projections | SQLite for structured state |

`VERIFIED_CODE`: when a global project or individual issue directory is absent,
the resolver
[copies the legacy repository tree without overwriting](https://github.com/fabioassuncao/issue-flow/blob/557bcec93bb0c637461af430b40d527c86b66e5f/packages/issue-flow/src/storage/resolve.ts#L340-L382).
On the same resolution it imports structured global artifacts into SQLite. If
the global destination already exists, it wins; the local tree is not polled or
merged again.

### Reproduction

Two clean temporary Git repositories used different isolated
`ISSUE_FLOW_HOME` directories.

#### Skills → CLI

The fixture wrote `issues/107/{prd.md,tasks.json,progress.txt,session.json}` as a
skill would, with `prdCompleted=true`, `jsonCompleted=true` and
`executionCompleted=false`.

Observed:

- four files were copied; the local source remained byte-present and untouched;
- two structured artifacts were imported into SQLite;
- `PipelineManager.getNextPhase()` over the imported plan returned `execute`;
- Markdown was available in global storage;
- the copied live `session.json` remained a file, but live snapshots are not
  adopted as canonical SQLite state;
- after first adoption, changing the local `tasks.json` was invisible to the
  CLI: the imported description remained `from skills`, not the later edit.

Result: **initial task-plan handoff works when the global issue destination is
absent; ongoing alternation does not.** Default import also excludes the legacy
event journal unless `issue-flow db import --with-events` is used, so an exact
in-flight execution reconstruction is not part of this handoff.

#### CLI → skills

The second fixture created and saved issue `108` through the CLI storage
resolver. The global compatibility projection existed; the path the skills
would read, `<projectRoot>/issues/108/tasks.json`, did not.

Result: **there is no reverse handoff.** Re-invoking a skill cannot discover a
CLI-only plan without an explicit export/copy supplied by the operator, and
such a copy would still not reproduce SQLite executions, journal ownership or
session semantics.

### Loss classification

| Dimension | Skills → CLI initial adoption | Skills → CLI after adoption | CLI → skills |
|---|---|---|---|
| Location | Automatically copied if destination absent | Global destination wins; local edit ignored | No reverse copy |
| Task-plan format | Valid plans import and phase flags resume | Two independent files can diverge | Skill sees no file |
| Markdown (`prd`, progress) | Copied | Not synchronized | Not exported |
| Execution telemetry | Existing structured rows may import | New local rows ignored | SQLite rows unavailable |
| Live snapshot / ownership | Not a resumable live session | Independent | Unavailable |
| Journal | Not imported by default | Independent | Unavailable |

### Conclusion

**Document the one-time handoff; investigate an explicit protocol rather than
shared implicit writes.** A safe design needs a command that declares direction
and checks divergence, plus a state mapping that names what cannot be preserved.
Blind file copying is insufficient once SQLite owns structured state. Until
that exists: skills → CLI is supported only as initial legacy adoption, then the
issue must stay on the CLI; CLI → skills is unsupported.

## Benchmark limitation discovered during the investigation

The real corpus is a useful scaffold, not yet the instrument #107 needs:

- corpus entries carry `strategy: direct | pipeline`, but
  [`createLiveRepeatRunner()` always calls `runPipeline()`](https://github.com/fabioassuncao/issue-flow/blob/557bcec93bb0c637461af430b40d527c86b66e5f/packages/issue-flow/src/benchmark/live.ts#L29-L45);
- `baseline` and `strict-mcp` alter the comparability tuple, but the live runner
  applies no corresponding agent configuration; only `L2` changes execution;
- the CLI command pins the tuple's strategy to `pipeline` before the corpus
  task overwrites only metadata, not the runner;
- synthetic rows cannot substitute because they measure reducer/schema work,
  not process or phase orchestration.

This is a validity problem, not merely missing repetitions. A follow-up must
make every declared arm change the real invocation and must add a real direct
harness runner before publishing p50/p95 comparisons.

## Decisions and follow-up boundaries

| Mechanism | Decision | Follow-up boundary |
|---|---|---|
| Separate phases | Keep now; test proportional path | Benchmark first, then compare combined/skipped PRD+plan for fully specified small issues; never skip verification |
| Story iterations | Investigate bounded grouping | Expose the existing internal value through configuration and measure `1` vs related-story batches; session resume is separate |
| Correction cycles | Keep concept; split failure routing | Findings → correction; contract diagnostics → fixer; operational failures → resilience/human action |
| Skills/CLI continuity | Initial skills → CLI handoff only | Explicit directional handoff with divergence checks; no implicit two-writer synchronization |
| Measurement | Evidence insufficient for current wall/token conclusions | Repair direct runner and arm application before any paid campaign |

These follow-ups refine #79/#89 rather than reopening their delivered work:
instrumentation, quick wins, acceptance checks and the default of one story stay
intact. No optimization is implemented by #107.

## Validation record

Executed locally at `557bcec`:

```text
npm run build
node dist/cli.js bench --mode synthetic
vite-node disposable interop experiment (skills → CLI, CLI → skills)
```

The focused automated suites used for the final documentation gate are listed
in the Pull Request test plan. Temporary experiment files and repositories live
outside the checkout and are not part of the change.
