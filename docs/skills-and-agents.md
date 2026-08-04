# Issue Flow: Skills & Sub-Agent Architecture

Issue Flow can also be used interactively within [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via **skills** and the **`resolve-issue` sub-agent**. This document covers that usage model.

> For the CLI-first approach, see the [main README](../README.md).

## Architecture

Issue Flow uses a **sub-agent + skills** architecture:

- **`resolve-issue`** is a Claude Code **sub-agent** (`.claude/agents/resolve-issue.md`) that orchestrates the full pipeline
- All other components are **skills** preloaded into the sub-agent, callable without nesting
- Two execution modes: `auto` (no stops), `manual` (artifacts only)
- Auto-correction loop: review finds issues -> fix -> re-review (up to 3 cycles)
- Pipeline state tracking enables resumption from any phase

### Issue sources

The issue can live on GitHub or in the repository itself (`issues/<N>/issue.md` + `issues/<N>/metadata.json`). Both `generate-issue` / `generate-local-issue` and the `resolve-issue` sub-agent work with either origin: when `issues/{N}/issue.md` exists, it is the statement to work from and `gh` is not needed. The CLI implements the same idea as a provider layer with conflict resolution -- see [Issue Sources](../README.md#issue-sources-providers) for the file format, the flags, and the `issues` key of `.issue-flow.json`.

### Skills vs Sub-agent: how they are invoked

Skills and sub-agents are invoked differently in Claude Code:

| | Skills | Sub-agent (`resolve-issue`) |
|--|--------|---------------------------|
| **Slash command** | `/skill-name` (e.g., `/generate-issue`, `/review-issue`) | Not available -- sub-agents do not use `/` |
| **@-mention** | Not available | `@resolve-issue` + instructions |
| **Natural language** | Claude auto-invokes based on description | Claude auto-delegates based on description |
| **Session-wide** | Not available | `claude --agent resolve-issue` |
| **Headless** | `claude -p "/review-issue #42"` | `claude --agent resolve-issue -p "#42 --mode auto"` |

> **Important**: The `resolve-issue` sub-agent is **not** a skill and cannot be invoked with `/resolve-issue`. Use `@resolve-issue` or natural language instead.

## Components

| Component | Type | Description |
|-----------|------|-------------|
| [`resolve-issue`](../.claude/agents/resolve-issue.md) | **Sub-agent** | Orchestrates the full pipeline end-to-end with mode support and auto-correction loop. |
| [`generate-issue`](../skills/generate-issue/) | Skill | Generates architect-quality GitHub issues from short instructions with duplicate detection and label management. |
| [`generate-local-issue`](../skills/generate-local-issue/) | Skill | Generates architect-quality issues as local files (`issues/<N>/issue.md` + `metadata.json`) with no GitHub involved. |
| [`analyze-issue`](../skills/analyze-issue/) | Skill | Analyzes a GitHub issue to extract context, scope, affected areas, and complexity. Standalone use only -- not part of the default pipeline. |
| [`generate-prd`](../skills/generate-prd/) | Skill | Generates a structured PRD with user stories, acceptance criteria, and functional requirements. |
| [`convert-prd-to-json`](../skills/convert-prd-to-json/) | Skill | Converts a PRD markdown file into a structured JSON task plan for autonomous execution. |
| [`execute-tasks`](../skills/execute-tasks/) | Skill | Iteratively implements user stories from a JSON task plan with quality checks and commits. |
| [`create-pr`](../skills/create-pr/) | Skill | Creates a Pull Request from the current branch with context from issue data, PRD, and git history. |
| [`review-issue`](../skills/review-issue/) | Skill | Reviews whether a GitHub issue has been fully resolved, with structured output for the correction loop. |
| [`review-pr`](../skills/review-pr/) | Skill | Reviews a Pull Request as a whole (diff, architecture, duplication, tests, commits, description) and returns a structured verdict. Optional -- runs after `create-pr` when `--pr-review` is requested. |

## Execution Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `auto` | Full pipeline without stops (default) | Headless / CI / unattended |
| `manual` | Generates artifacts only, no execution | Planning / review before coding |

**Via @-mention (explicit):**
```
@resolve-issue #42
@resolve-issue #42 --mode auto
@resolve-issue #42 --mode manual
```

**Via natural language (Claude auto-delegates):**
```
Resolve issue #42
Resolve issue #42 --mode auto
```

**Via headless CLI:**
```bash
claude --agent resolve-issue -p "#42 --mode auto"
```

## End-to-End Workflow

```mermaid
flowchart TD
    A[Short instruction or bug report] --> B[generate-issue]
    B --> C[GitHub issue created]
    C --> D["resolve-issue (sub-agent)"]
    D --> E{Existing work detected?}
    E -- Yes --> E1["Resume from pipeline state"]
    E1 --> F
    E -- No --> G[Create branch issue/N-slug]
    G --> H[generate-prd<br/>issues/N/prd.md]
    H --> I[convert-prd-to-json<br/>issues/N/tasks.json]
    I --> J{"Mode gate"}
    J -- "auto" --> K[execute-tasks]
    J -- "manual" --> P[Stop and keep artifacts]
    K --> L[Implement one story]
    L --> M[Run checks, commit, update tasks.json]
    M --> N{All stories pass?}
    N -- No --> L
    N -- Yes --> V["review-issue<br/>(structured verdict)"]
    V --> S{PASS or FAIL?}
    S -- PASS --> R["create-pr<br/>Open Pull Request"]
    S -- FAIL --> W{"Correction cycle < 3?"}
    W -- Yes --> X["Reset affected stories<br/>Re-execute + re-review"]
    X --> V
    W -- No --> Y[Stop and report to user]
    P --> Q["Resume later: resolve-issue or execute-tasks"]
    R --> AA{"--pr-review?"}
    AA -- Yes --> AB["review-pr<br/>(structured verdict)"]
    AB --> AC{"REQUEST_CHANGES?"}
    AC -- No --> T["Close issue<br/>Pipeline complete"]
    AC -- Yes --> AD["Keep the issue open<br/>and report the blockers"]
    AA -- No --> T
```

> `review-pr` is **opt-in**: without `--pr-review` the flow ends at `create-pr` + closing the issue, exactly as before.

## Interactive Walkthrough

<details>
<summary><strong>1. Create the GitHub issue with <code>generate-issue</code></strong></summary>

The pipeline can start from a short natural-language request such as "create an issue for adding rate limiting to the API".

`generate-issue` then:
- inspects the repository and stack
- expands the short request into a well-scoped technical issue
- checks for duplicates
- validates labels
- creates the issue with `gh`

Output: a published GitHub issue that is ready to be planned and executed.

With no GitHub access (offline, no remote, or a demand that is not public yet), use `generate-local-issue` instead: it writes `issues/<N>/issue.md` and `issues/<N>/metadata.json`, and the rest of the pipeline is identical.
</details>

<details>
<summary><strong>2. Resolve the issue with the <code>resolve-issue</code> sub-agent</strong></summary>

`resolve-issue` is a **sub-agent** that orchestrates the full pipeline. It runs in an isolated context window with all skills preloaded.

**Planning phases (automatic):**
1. Check for existing work and pipeline state in `issues/{N}/`
2. Create the working branch `issue/{N}-{slug}`
3. Generate PRD with `generate-prd` -> `issues/{N}/prd.md`
4. Convert to task plan with `convert-prd-to-json` -> `issues/{N}/tasks.json`

**Mode-conditional gate:**
- `auto`: skips confirmation, proceeds directly to execution
- `manual`: stops here with artifacts saved

**Execution phases (if proceeding):**
5. Implement stories with `execute-tasks`
6. Validate with `review-issue` (structured verdict)
7. If FAIL: auto-correction loop (reset affected stories, re-execute, re-review -- up to 3 cycles)
8. If PASS: create PR with `create-pr` and close the issue
</details>

<details>
<summary><strong>3. Auto-correction loop</strong></summary>

After execution completes, the sub-agent automatically invokes `review-issue` which produces a structured verdict:

- **PASS**: All requirements met, tests pass, no regressions -> proceeds to create PR
- **FAIL**: Returns findings with affected user story IDs -> enters correction loop

The correction loop:
1. Saves review findings to `issues/{N}/review-findings.md`
2. Resets affected stories in `tasks.json` (`passes: false`)
3. Re-invokes `execute-tasks` to fix the issues
4. Re-invokes `review-issue` to validate the fixes
5. Repeats up to `maxCorrectionCycles` (default: 3) times
6. After 3 failed cycles, stops and reports to the user

This eliminates the need for manual back-and-forth between implementation and review.
</details>

<details>
<summary><strong>4. Pipeline resumption</strong></summary>

The `tasks.json` file tracks pipeline state:

```json
{
  "pipeline": {
    "prdCompleted": true,
    "jsonCompleted": true,
    "executionCompleted": false,
    "reviewCompleted": false,
    "prCreated": false
  }
}
```

When re-invoking `resolve-issue`, the sub-agent reads these flags and resumes from the last incomplete phase. In `auto` mode, this happens without any user interaction.

`prReviewCompleted` joins these flags only when the optional `pr-review` phase runs -- its absence means the phase was never requested, not that it is pending.
</details>

## Reviewing the Pull Request (`review-pr` / `pr-review`)

The `review-issue` skill is a **conformance gate**: it checks the implementation against the acceptance criteria of `tasks.json`. `review-pr` answers a different question -- is this Pull Request, as a whole, good enough to merge? It reads the PR description, the issue/PRD/implementation alignment, the full diff, architecture, complexity, duplication, project conventions, regressions, risks, test coverage, documentation, commit messages, and simplification opportunities.

Both surfaces produce the same verdict from the same axes:

| Surface | Invocation |
|---------|-----------|
| Skill | `/review-pr #184`, or natural language ("review this PR", "revisar o PR") |
| Sub-agent | Step 6b of `resolve-issue`, opt-in via `--pr-review` |
| CLI phase | `issue-flow pr-review [pr]`, or `issue-flow run 42 --pr-review` |

**Pull Request discovery** (both the skill and the CLI resolve it in the same order, and neither ever reviews a guessed PR):

1. The explicit argument (`184`, `#184` or a PR URL)
2. The active session snapshot (`issues/<N>/session.json`) -- CLI only
3. `pullRequest` in `issues/<N>/tasks.json`, written when the PR was created
4. `gh pr list --head <current branch>` -- the most recent PR
5. Failure with an actionable message asking for the number

**Artifacts** are versionable and rounds are additive -- a new round never overwrites an earlier report:

```
issues/42/pr-review/          # issues/pr-184/pr-review/ when there is no associated issue
  pr-184-round-1.md           # the eight canonical report sections
  index.json                  # { schemaVersion, pullRequest, rounds[] } with structured findings
```

**Exit codes** (CLI):

| Code | Meaning |
|------|---------|
| `0` | `APPROVE` or `APPROVE_WITH_SUGGESTIONS` |
| `2` | `REQUEST_CHANGES` |
| `1` | Execution failure: headless run, `gh`, PR not found, invalid options, or an unparseable verdict |

A malformed verdict is never coerced into `APPROVE`: it fails with `1` and the raw output is preserved in the report. `--fail-on <level>` shifts the threshold (`suggestions` also fails on `APPROVE_WITH_SUGGESTIONS`, `none` never fails on a verdict), but it never suppresses code `1`.

The review is **read-only** on both surfaces: no edits, no commits, and no `gh pr review|comment|merge`. On `REQUEST_CHANGES`, the sub-agent and `run` leave the issue open and report the blockers with the report path; `run` itself still exits `0`. See [the CLI reference](../README.md#pr-review----review-a-pull-request) for the flags and the `prReview` key of `.issue-flow.json`.

## Installation (Claude Code)

Issue Flow has two types of components with different installation methods:

| Component | Type | Portable | Claude Code required |
|-----------|------|----------|---------------------|
| `analyze-issue`, `generate-prd`, `convert-prd-to-json`, `execute-tasks`, `create-pr`, `review-issue`, `review-pr`, `generate-issue`, `generate-local-issue` | Skills (`skills/`) | Yes -- works with any tool that supports [Agent Skills](https://agentskills.io) | No |
| `resolve-issue` (orchestrator) | Sub-agent (`agents/`) | **No** -- exclusive to Claude Code | **Yes** |

### Full installation (sub-agent + all skills)

Installs everything: the sub-agent orchestrator + all skills. This is the only way to get the full pipeline with modes, auto-correction loop, and pipeline resumption.

```bash
# Install all skills + sub-agent
npx skills add fabioassuncao/issue-flow
```

This installs all skills into `.claude/skills/` and the sub-agent into `.claude/agents/`.

**Sub-agent only (manual):**

If you only need the sub-agent orchestrator:

```bash
mkdir -p .claude/agents
curl -sSL https://raw.githubusercontent.com/fabioassuncao/issue-flow/main/agents/resolve-issue.md \
  -o .claude/agents/resolve-issue.md
```

The sub-agent also requires the skills it orchestrates to be installed (see below).

### Skills only (any Agent Skills-compatible tool)

If you use a tool other than Claude Code (or prefer to use skills individually without the orchestrator), install only the skills:

```bash
# All skills
npx skills add fabioassuncao/issue-flow

# A specific skill only
npx skills add fabioassuncao/issue-flow --skill generate-issue
```

**Manual:**

1. Download the desired skill folder from `skills/` in this repository.
2. Copy it into your project's `.claude/skills/` directory.

Skills are automatically available in any tool that supports [Agent Skills](https://agentskills.io).

### What works without the sub-agent

Without the `resolve-issue` sub-agent, each skill can still be used independently:

| Capability | Available without sub-agent? |
|-----------|------------------------------|
| Create issues (`generate-issue`) | Yes |
| Create local issues (`generate-local-issue`) | Yes |
| Analyze issues (`analyze-issue`) | Yes |
| Generate PRDs (`generate-prd`) | Yes |
| Convert PRD to JSON (`convert-prd-to-json`) | Yes |
| Execute tasks (`execute-tasks`) | Yes |
| Create PRs (`create-pr`) | Yes |
| Review issues (`review-issue`) | Yes |
| Review Pull Requests (`review-pr`) | Yes |
| **Full orchestrated pipeline** | **No -- requires sub-agent** |
| **Execution modes (auto/manual)** | **No -- requires sub-agent** |
| **Auto-correction loop** | **No -- requires sub-agent** |
| **Pipeline state resumption** | **No -- requires sub-agent** |

Without the sub-agent, you can still run the full workflow manually by invoking each skill in sequence.

## Headless / CI Usage

```bash
# Full pipeline, no stops (sub-agent)
claude --agent resolve-issue -p "#42 --mode auto"

# Planning only (sub-agent)
claude --agent resolve-issue -p "#42 --mode manual"

# Individual skills (headless)
claude -p "/execute-tasks for issue #42"
claude -p "/review-issue #42"
claude -p "/create-pr for issue #42"
claude -p "/review-pr #42"
```

## Quick Start (Interactive)

**Skills (slash command):**
```
/generate-issue Add rate limiting to the API

/review-issue #42

/execute-tasks for issue #42
```

**Sub-agent (@-mention):**
```
@resolve-issue #42

@resolve-issue #42 --mode auto
```

**Sub-agent (natural language -- Claude auto-delegates):**
```
Resolve issue #42

Fix issue #42 in auto mode
```

See each skill's README for standalone usage.
