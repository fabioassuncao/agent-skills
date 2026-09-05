# Agent Skills and the CLI

Issue Flow offers two independent surfaces. The CLI runs a persistent pipeline with its own packaged prompts, verification engine, storage and agent adapters. Agent Skills teach the current coding agent to perform the same issue workflow directly. Neither surface requires the other to be installed.

Use the CLI for unattended execution, transactional state, locks, telemetry, queues, independent reviewer routing and recovery. Use Skills for interactive work, a single phase, or the portable `resolve-issue` workflow. Skills can consult an already installed CLI for optional policy discovery; they never download it automatically.

## Install Skills

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

To install manually, copy the **whole** `skills/<name>/` directory into the agent's Skill directory, keeping its name and all resources. No source tree, build, sibling Skill, Node package installation or CLI setup is needed. See the [compatibility matrix](skills-compatibility.md) for directories and host-specific invocation.

The installer does not install files under `agents/`. It also has no structural `validate` command in the tested version. Repository contributors use `skills:check`; the standard's separate [skills-ref validator](https://github.com/agentskills/agentskills/tree/main/skills-ref) validates format metadata.

## Available capabilities

| Skill | Use it for | Stops before |
|---|---|---|
| `analyze-issue` | Investigate issue completeness, scope, implementation impact and risks | Implementation |
| `generate-prd` | Turn an issue into requirements and observable acceptance criteria | Task execution |
| `convert-prd-to-json` | Convert a PRD into the canonical task-plan JSON | Branch checkout or implementation |
| `execute-tasks` | Implement pending stories and address verified findings with fresh checks | Unrequested PR publication |
| `create-pr` | Prepare and publish the authorized PR against the actual base | Inventing a remote PR when publication fails |
| `review-issue` | Verify resolution against issue acceptance criteria | Comments and closure unless authorized |
| `review-pr` | Review the whole PR and report findings and a recommendation | Implementation changes or unrequested remote review |
| `generate-issue` | Draft/deduplicate a GitHub issue and publish when authorized | Inventing labels or unavailable remote evidence |
| `generate-local-issue` | Create an offline issue with body, canonical hash and metadata | Remote lookup unless requested |
| `init-repository` | Plan/create missing conventions while preserving existing files | Overwriting or migrating existing policy without authorization |
| `resolve-issue` | Plan, implement, review/correct and deliver an issue end to end | Phases outside the selected mode or authorization |

## Use without the CLI

Use natural language or your agent's explicit Skill invocation. For example:

```text
Use analyze-issue to analyze issues/42/issue.md; do not implement it.
Use convert-prd-to-json for issues/42/prd.md and stop after creating tasks.json.
Use review-issue to verify local issue 42. Return the report only.
Use resolve-issue for local issue 42 in manual mode.
Use resolve-issue for GitHub issue 42 through implementation, review and PR creation.
Use resolve-issue for local issue 42, without publication.
```

In Claude Code the explicit form is `/review-issue ...`; Codex supports selecting/mentioning the Skill. Descriptions guide automatic selection, but selecting a Skill does not grant permissions. Remote publication follows the user's existing authorization and the agent's permission system.

File reading and editing capabilities are enough for drafting. Git operations require Git; repository verification requires the project's own toolchain. Bundled `.mjs` helpers require **Node.js ≥22.13.0**, with no external packages at execution time. GitHub work requires an authenticated GitHub capability, such as `gh` or an available integration; local-only work needs no GitHub access. MCP, specific tool names, subagent tools and proprietary frontmatter are not requirements.

`resolve-issue` runs in the current agent. `auto` continues through the authorized phases. `manual` writes the PRD and task plan, then stops. `--pr-review` requests a final whole-PR review. It resumes from verified artifacts, including a pending PR review after a PR already exists. Review corrections are bounded (three rounds by default); invalid findings must be rejected with evidence. It does not claim the CLI's transactional recovery or independent reviewer isolation.

## Artifacts and optional CLI integration

Skills default to `<consumer-project>/issues/<id>/` for `issue.md`, optional `metadata.json`, PRD, task plan, progress and reports. Explicit paths are supported. This is distinct from the [CLI's global storage](storage.md), including SQLite, sessions and telemetry. **A run cannot be transferred or resumed across surfaces.** Choose the surface for a run; do not point Skills at CLI-managed database or session files. Existing legacy CLI migration remains a CLI compatibility mechanism, not a Skill session transfer API.

Every Skill includes `references/cli-integration.md`. When enabled for a relevant decision, its bundled `scripts/optional-cli.mjs` probes an installed executable for `policy --json` or `init --json`, checks the supported schema and times out. Absence, failure, timeout or incompatible JSON returns `null`; the Skill performs direct discovery instead. Nothing invokes `npx issue-flow`. Shared naming, issue hashing, parsing, schemas and scaffold renderers are already bundled from canonical sources.

## Optional Claude subagent adapter

[`agents/resolve-issue.md`](../agents/resolve-issue.md) is a small Claude-specific adapter that preloads the portable `resolve-issue` Skill. Install that Skill first, then manually copy the adapter to `.claude/agents/resolve-issue.md` (or `~/.claude/agents/`). The adapter contains no second workflow and does not bypass permissions. You can then use Claude's subagent selection, including `claude --agent resolve-issue -p "local issue 42 --mode manual"` where supported by your installed version. The portable Skill alone provides the full workflow on other agents.

Contributor architecture and validation: [Authoring Skills](skills.md). Evidence and limits: [Evals](skills-evals.md), [compatibility](skills-compatibility.md), [dated audit](research/2026-09-05-skills-portability.md).
