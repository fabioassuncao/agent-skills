# Issue Flow Agent Skills

[Project overview](../README.md) · [Compatibility](../docs/skills-compatibility.md) · [Contributing](../CONTRIBUTING.md)

## What Agent Skills do

Agent Skills are the recommended way to use Issue Flow. They package procedures,
references and helpers that your coding agent loads to carry out a development
task in your repository. The agent provides the model, tools and permissions;
the Skill provides the workflow. GitHub can supply the issue and host the PR,
but local issue files are supported too.

Use `resolve-issue` for the full workflow, or select an individual Skill for one
step. Each distributed directory is self-contained: the full workflow needs
neither sibling Skills nor the Issue Flow CLI. Installing the CLI does not
install Skills.

> [!WARNING]
> Skills are recommended among the available interfaces, but the whole project
> is still experimental. Read [Project status](../docs/project-status.md);
> this recommendation does not imply production readiness.

## Before you start

Work in the **consumer repository**: the project whose issue you want to resolve.
You do not need to clone or build Issue Flow to use its published Skills.

- Use a [compatible coding agent](../docs/skills-compatibility.md) with access to
  the repository and the ability to read/edit files and run required commands.
- Have **Node.js ≥22.13.0** for the bundled `.mjs` helpers. They need no external
  packages at execution time. The installation examples use npm's `npx`.
- Have **Git** for repository operations and the project's own toolchain for
  quality checks. File reading and editing alone are enough for drafting.
- For GitHub work, provide authenticated GitHub access through `gh` or an
  available integration. Local-only work requires no GitHub access.
- Choose an issue with a clear problem, scope and observable acceptance criteria.
  Review its context and the repository's instructions before implementation.

Skills follow the host's configuration and the consumer repository's
instructions. `.issue-flow.json`, a global CLI configuration, MCP and subagent
APIs are not prerequisites. Optional policy enrichment is described below.

## Install and run your first workflow

Start in a disposable or easily recoverable consumer repository. The example
uses Codex and GitHub issue `42`; substitute your issue number or full URL.

1. Open the consumer repository in your coding agent. Confirm that its GitHub
   connection can read the issue and that you are in the intended clone.
2. From that repository's terminal, install the complete workflow:

   ```bash
   npx skills add fabioassuncao/issue-flow --skill resolve-issue -a codex
   ```

3. Select or mention the installed Skill in the agent and request planning:

   ```text
   Use resolve-issue for GitHub issue 42 in manual mode.
   ```

4. Inspect `issues/42/prd.md` for requirements and acceptance criteria, and
   `issues/42/tasks.json` for the ordered task plan. The response should identify
   the intended branch, artifact paths and any unresolved decisions.

Manual mode stops here, before implementation. It records an intended branch
without requiring a checkout. Resolve important scope questions and inspect the
plan before continuing.

If the Skill is not available in the agent, check the installed inventory with
`npx skills list --json` and the host's discovery instructions in the
[compatibility guide](../docs/skills-compatibility.md). A successful installer
copy is not proof that the host loaded the Skill.

## From issue to Pull Request

After inspecting the plan, select `resolve-issue` again and ask:

```text
Continue resolving GitHub issue 42 using the existing plan.
Implement the tasks, verify the acceptance criteria and create the Pull Request.
```

The workflow verifies existing artifacts, implements pending tasks, runs the
project's checks and reviews the result against the issue. Findings trigger
bounded correction rounds. PR creation follows a passing issue review and the
existing publication authorization. The response should include the branch,
artifacts, verified work, PR URL when published and any blockers or limitations.

The conceptual sequence is:

```text
Issue → PRD → task plan → implementation and checks → issue review → PR
                                  ↑                      │
                                  └── valid corrections ─┘
```

`resolve-issue` includes all these procedures. Repository initialization,
issue generation and a separate analysis are optional preparation, not mandatory
steps or separately required installations. Request `--pr-review` to add a
whole-PR review after publication. Issue review checks acceptance criteria;
whole-PR review examines the combined diff, architecture, risks and coverage.

Read the changes and evidence before merging. Creating a PR does not itself
authorize immediate issue closure. A failed check, unresolved review finding or
failed required publication must be reported rather than presented as success.

## Choose a Skill

Install individual Skills when you want to invoke one responsibility directly.
Selecting a Skill does not grant permission for unrelated work or publication.

| Stage | Skill | When to use it and its boundary |
|---|---|---|
| Complete workflow | [`resolve-issue`](resolve-issue/SKILL.md) | Plan, implement, review/correct and deliver within the selected mode and authorization |
| Preparation | [`init-repository`](init-repository/SKILL.md) | Plan/create missing conventions while preserving existing policy |
| Preparation | [`generate-issue`](generate-issue/SKILL.md) | Draft/deduplicate a GitHub issue; publish when authorized using actual repository labels |
| Preparation | [`generate-local-issue`](generate-local-issue/SKILL.md) | Create an offline issue with body, hash and metadata; no unsolicited remote lookup |
| Investigation | [`analyze-issue`](analyze-issue/SKILL.md) | Investigate scope, completeness, impact and risks; stop before implementation |
| Planning | [`generate-prd`](generate-prd/SKILL.md) | Produce requirements and observable acceptance criteria; no execution |
| Planning | [`convert-prd-to-json`](convert-prd-to-json/SKILL.md) | Convert a PRD into the task-plan JSON; no checkout or implementation |
| Implementation | [`execute-tasks`](execute-tasks/SKILL.md) | Implement pending stories and verified findings with fresh checks; no unrequested PR |
| Verification | [`review-issue`](review-issue/SKILL.md) | Verify acceptance criteria; comments and closure require authorization |
| Delivery | [`create-pr`](create-pr/SKILL.md) | Prepare/publish the authorized PR against the actual base; confirm remote success |
| PR review | [`review-pr`](review-pr/SKILL.md) | Report whole-PR findings and recommendation; no implementation changes or unrequested remote review |

## Other ways to work

`resolve-issue` defaults to `auto`, which continues through authorized phases.
It still respects unresolved material questions and the host's permissions.
Use `manual` whenever the requested outcome is a PRD and plan only.

For local input, supply an issue file or local identifier explicitly. You can
create one with `generate-local-issue`. A local `issue.md` starts with an H1
title followed by its body; metadata is optional when reading an existing issue.

```text
Use resolve-issue for local issue 42 in manual mode.
Use resolve-issue for issues/42/issue.md, without publication.
Use analyze-issue to analyze issues/42/issue.md; do not implement it.
Use convert-prd-to-json for issues/42/prd.md and stop after creating tasks.json.
Use review-issue to verify local issue 42. Return the report only.
```

A verified local-only workflow can complete without a PR when publication was
excluded. Specify GitHub or local input when identifiers could be ambiguous.

Use natural language or the host's explicit invocation. For example, Claude Code
supports `/review-issue ...`; Codex supports selecting/mentioning the Skill.
Invocation syntax and discovery are host-specific; see
[compatibility](../docs/skills-compatibility.md).

## Configure an invocation

Supply choices in the request, in ordinary language or an optional text block.
These are Issue Flow conventions interpreted by the agent, not formal Agent
Skills parameters, frontmatter fields or commands. The same request works after
selecting the Skill in any compatible host; see the
[standard and host differences](../docs/skills-compatibility.md#invocation-options).
The installed [execution choices reference](resolve-issue/references/execution-options.md)
is the source of truth for defaults, propagation and resumption.

```text
Use resolve-issue to resolve GitHub issue #123 on the current branch,
following this project's commit conventions.

Use resolve-issue for docs/problem.md. Create a dedicated branch following
this project's conventions and use its commit convention.

Use resolve-issue for this demand: normalize null and undefined strings to
an empty string, retaining trimming for strings and rejecting numbers.
Stay on the current branch and use Issue Flow's commit convention.
```

The optional structured spelling of the first request is:

```text
Use resolve-issue.
source: github
input: 123
branchMode: current
commitConvention: project
delivery: local
```

| Choice | Values / default |
|---|---|
| source | auto (default), github, local, inline |
| input | Number, URL, issue/document path, story/specification, full text, or a list |
| branchMode | new (fresh-plan default), current |
| commitConvention | auto (default), project, issue-flow |
| mode | auto (default), manual |
| delivery | local or pr; current defaults to local, new follows the authorized request |
| prReview | false (default), true for an authorized PR delivery |

Explicit base branch, dedicated branch name, artifact paths and correction limit
are also supported. A concrete commit message rule/example overrides the strategy.
Conflicting options are clarified before the affected action. Local inputs do not
require remote probes; input source and publication are independent choices.

`current` captures the branch and never creates or switches one, including during
corrections. A changed branch or detached HEAD blocks execution. An explicitly
requested PR may use that same branch if it is a valid head distinct from the
base/default; the agent will not change branches to make publication possible.
The CLI's `--no-branch` couples branch choice with no PR; Skills keep these choices
separate. `new` safely checks out the dedicated planned branch before editing,
reusing it on resume. Manual planning and conversion never switch branches.

Commit discovery follows explicit request, declared project convention, clearly
established project practice, then Issue Flow defaults. The agent reads applicable
instructions, documentation and configuration, using recent history when needed.
`auto` falls back when evidence is insufficient. `project` asks for guidance before
committing if there is no clear convention. `issue-flow` explicitly chooses the
bundled format. Custom conventions govern the entire message, without automatic
Issue Flow headers or story trailers. Required hooks are never bypassed.

### Documents and multiple demands

A generic problem file needs no issue metadata or H1. Complete inline text is also
accepted. Planning preserves the source and creates a local representation under
a safe descriptive identifier when necessary. The PRD records the selected input
and options so the run can resume without relying on chat history.

For multiple demands, the agent first examines relationships and dependencies.
It proposes a shared plan when grouping reduces duplicate work or makes related
changes more consistent, and waits for approval before consolidating. Independent
demands run separately and sequentially, ordered by dependencies. Failure stops
the sequence while preserving earlier results. Linked issues are not added to
scope without authorization.

An approved group keeps one local plan with source-to-story mappings; logical
changes remain separate commits. GitHub references and completion are evaluated
per member, never inferred from the group's local identifier. In current mode all
units use the captured branch; in new mode separate units use dedicated branches
and must resolve unmerged dependencies before starting dependent implementation.

## Artifacts, resumption and limits

Default artifacts live under `<consumer-project>/issues/<id>/`: PRD, task plan,
progress and review reports, plus `issue.md` and optional metadata for local
issues. Explicit artifact paths are supported. Paths refer to the consumer
project, not the installed Skill directory. Inspect the consumer repository's
ignore and contribution policy before deciding which artifacts to commit.

Resume by asking `resolve-issue` to continue the same issue. It verifies artifacts
and Git evidence, then resumes the earliest incomplete phase, including a
requested PR review after a PR already exists. Accepted choices are recorded in
the PRD and append-only progress entries; branchName/noBranch in tasks.json retain
the branch decision. New explicit choices override prior choices only after
ownership checks; existing implementation is never silently moved between plans
or branches. Artifact history alone does not authorize publication. A new manual invocation stays in
planning. Corrections are bounded to three rounds by default; invalid findings
must be rejected with evidence.

This runs in the current agent. It does not provide transactional locks or an
independently isolated reviewer. Those runtime capabilities belong to the
[experimental CLI](../docs/cli.md).

**A run cannot be transferred or resumed between Skills and the CLI.** CLI-owned
SQLite data, sessions, locks and telemetry are separate from Skill artifacts.
Do not point Skills at CLI-managed state. The CLI's legacy migration is not a
Skill session transfer mechanism. See [CLI storage](../docs/storage.md).

## Installation options and compatibility

From the consumer project's directory:

```bash
# Discover the repository's Skills before installing
npx skills add fabioassuncao/issue-flow --list

# One independent Skill
npx skills add fabioassuncao/issue-flow --skill review-issue -a codex

# A selected set
npx skills add fabioassuncao/issue-flow --skill analyze-issue generate-prd -a claude-code

# All eleven, targeting several agents
npx skills add fabioassuncao/issue-flow --skill '*' -a claude-code codex opencode

# The full workflow alone; sibling Skills are not required
npx skills add fabioassuncao/issue-flow --skill resolve-issue -a codex

# User scope, available across projects
npx skills add fabioassuncao/issue-flow --skill resolve-issue -a codex -g

# Installed inventory and updates
npx skills list --json
npx skills list -g --json
npx skills update -p -y
npx skills update -g -y
```

These are the [Vercel Skills](https://github.com/vercel-labs/skills) conventions, exercised with version **1.5.23**. Add `--copy` for independent copies instead of installer-managed symlinks; `-y` accepts the selected installation without prompts. Omit `-a` for the installer's agent selection. `npx skills find issue-flow` searches the ecosystem index; index presence/ranking is not guaranteed by committing a repository. Direct repository discovery needs no index registration.

The repository's committed `skills/` is the distribution. A GitHub repository/tree URL or a local checkout can be an installation source. To test unpublished edits, use an absolute checkout path in place of `fabioassuncao/issue-flow`. Users of the GitHub command receive the revision actually published there. Local-path installations do not prove GitHub update behavior; the current installer does not register them as remotely updateable packages. In the disposable `file://` Git test, `update` failed while rerunning `add` successfully installed the changed revision. Do not infer that this tests GitHub updates.

To install manually, copy the **whole** `skills/<name>/` directory into the agent's Skill directory, keeping its name and all resources. No source tree, build, sibling Skill, Node package installation or CLI setup is needed. See the [compatibility matrix](../docs/skills-compatibility.md) for directories and host-specific invocation.

The installer does not install files under `agents/`. It also has no structural `validate` command in the tested version. Repository contributors use `skills:check`; the standard's separate [skills-ref validator](https://github.com/agentskills/agentskills/tree/main/skills-ref) validates format metadata.

## Optional integrations and contributing

### Optional CLI enrichment

Skills can consult an already installed CLI for relevant policy or scaffold
decisions; they never download it automatically. The bundled optional helper
probes `policy --json` or `init --json`, checks the schema and times out. Absence,
failure, timeout or incompatible JSON returns `null`, and the Skill discovers
policy directly instead. No fallback invokes `npx issue-flow`.

Shared naming, parsing, hashing, schemas and renderers are bundled from canonical
sources. Details of each integration ship with the installed Skill's
`references/cli-integration.md`.

### Optional Claude subagent adapter

[`agents/resolve-issue.md`](../agents/resolve-issue.md) is a small Claude-specific adapter that preloads the portable `resolve-issue` Skill. Install that Skill first, then manually copy the adapter to `.claude/agents/resolve-issue.md` (or `~/.claude/agents/`). The adapter contains no second workflow and does not bypass permissions. You can then use Claude's subagent selection, including `claude --agent resolve-issue -p "local issue 42 --mode manual"` where supported by your installed version. The portable Skill alone provides the full workflow on other agents.

### Contribute to Skills

Start with [Contributing](../CONTRIBUTING.md), then read
[Authoring and distributing Skills](../docs/skills.md) for editable sources,
generation and validation. The installed `SKILL.md` and its bundled resources
remain the execution instructions; this guide is for human onboarding.

See [behavioral evals](../docs/skills-evals.md),
[compatibility](../docs/skills-compatibility.md) and the
[dated audit](../docs/research/2026-09-05-skills-portability.md) for evidence and
its limits.
