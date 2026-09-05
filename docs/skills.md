# Agent Skills

The ten Issue Flow Agent Skills are an independent interface: procedural
knowledge and bundled resources for compatible coding agents. They require
neither the Issue Flow CLI, `issue-flow init`, nor an automated pipeline.
GitHub operations require authenticated GitHub access; local work does not.

The [open specification](https://agentskills.io/specification) defines the
package format. It does not define installation paths, slash commands, a
workflow engine, or a universal permission system. Those belong to hosts.
See the [capability matrix](skills-compatibility.md) for documented support and
observed results, and the [dated audit](research/2026-09-05-agent-skills-portability.md)
for findings, tradeoffs, evidence and remaining work.

## Catalogue

| Skill | Responsibility | Required capabilities | Effects |
|---|---|---|---|
| `init-repository` | Fill missing repository conventions | Git, writable repository | Creates missing files only |
| `generate-issue` | File a well-scoped GitHub issue | Git, authenticated GitHub tools | Creates an issue; related comments only when authorized |
| `generate-local-issue` | File a local issue, offline by default | Writable project, Git for discovery, POSIX shell + Node or Python 3 | Creates issue Markdown and metadata |
| `analyze-issue` | Understand a GitHub or local issue before planning | Git, issue text | Returns analysis |
| `generate-prd` | Plan from issue text | Read/write files | Writes PRD |
| `convert-prd-to-json` | Convert a PRD to a task plan | Files, Git; JSON parser recommended | Writes plan; preserves/archives prior progress |
| `execute-tasks` | Implement an existing task plan | Git, project toolchain | Code, commits, plan and progress; never pushes |
| `create-pr` | Prepare and publish a PR | Git push access, GitHub tools | Push and PR |
| `review-issue` | Verify issue acceptance criteria | Git, issue text, project test tools | Report; closure/comment only when explicitly authorized |
| `review-pr` | Review a PR as a whole | Git, GitHub tools | Report; local persistence only when requested |

`gh` commands are examples of GitHub operations; equivalent tools supplied by
the agent work too. MCP is one way to supply them, not a prerequisite.
Descriptions distinguish creating an issue from implementing a fix, planning
from conversion, and issue conformance from whole-PR review.

## Installing

### Build locally, then copy one complete skill

The source checkout intentionally contains no generated references. Build the
installable artifacts first; this requires development tooling, **not installing
or running the Issue Flow CLI**:

```bash
# From the Issue Flow checkout
npm ci --ignore-scripts --prefix packages/issue-flow
npm run skills:verify --prefix packages/issue-flow

# Example: install just one skill into a different project's Codex location
mkdir -p /path/to/project/.agents/skills
cp -R dist/skills/generate-local-issue /path/to/project/.agents/skills/
```

Use the directory your host scans, listed in the [matrix](skills-compatibility.md).
For a personal installation use that host's user-level directory instead.
Copy the entire skill, including `LICENSE`, `references/`, `scripts/` and any
`assets/`. Do not overwrite a locally customized installation without reviewing
its changes. No sibling skill or `_shared` directory is needed at runtime.

### Published repository channel

The publication workflow assembles the same tree into a `skills` branch. Once
that branch exists, the ecosystem installer supports:

```bash
npx skills add fabioassuncao/issue-flow#skills
npx skills add fabioassuncao/issue-flow#skills --skill create-pr
npx skills add fabioassuncao/issue-flow#skills --skill create-pr -g
```

`--skill` selects an individual package; `-g` requests a user installation.
This installer is optional, vendor-independent distribution tooling, not part
of the Agent Skills specification. See its [upstream documentation](https://github.com/vercel-labs/skills).

**Publication prerequisite:** the channel becomes available after the first
successful `Publish skills` workflow on `main`. Confirm discovery with
`npx skills add fabioassuncao/issue-flow#skills --list`; if the channel is absent
or unavailable, use the local build above. The dated audit records the initial
pre-publication state separately from later release verification.

**Do not omit `#skills`.** The default branch holds sources with intentionally
unmaterialized shared references. A raw copy of `skills/<name>` is generally
incomplete. A repository-only installer that cannot select a ref must consume
a locally assembled directory instead. This remains a distribution limitation,
not a runtime dependency on the CLI.

Release builds use `skills-vX.Y.Z` tags, only after those tags are actually
published. Pin a published tag or commit for reproducibility. The moving
`skills` branch is for updates; installer update/check commands follow their
own recorded source. Manual installations update by reviewing and replacing
the complete directory from a newly validated build.

## Using a skill without the CLI

Install a skill, start the agent in the target repository and request its task:

```text
Create a local issue for the expired-session bug. Do not access GitHub.
Analyze the local issue at issues/42/issue.md.
Generate a PRD from that issue.
Convert the existing PRD for issue 42 into a task plan.
Execute the task plan for issue 42.
Review whether issue 42 is resolved; report only.
```

Each request needs only the relevant skill and its declared inputs. Another
skill may produce those inputs, but a human or another tool can produce them
as well. Naming another skill in an exclusion is guidance, not a package
import. A missing required reference is an installation error: report it,
never guess the contract or silently reduce correctness.

Use natural language or the host's invocation syntax. `Read`, `Bash`, `Skill`
and similar tool names are not universal. The host supplies the capabilities
and enforces permissions; a Skill cannot grant itself broader access.

## Using skills with the CLI

All CLI integrations are **B: optional optimizations**:

| Integration | Why use it when available? | Portable fallback |
|---|---|---|
| `issue-flow policy --json` | Normalized repository declarations | Read instructions, templates and permitted GitHub metadata |
| `issue-flow conventions branch/commit/pr-title` | Deterministic naming | Repository convention, then bundled naming reference |
| `issue-flow init --json` / `--apply` | Deterministic plan and non-overwriting writes | Inspect and create missing files using scaffold reference |
| `issue-flow run`, `generate`, `pr-review` | Optional handoff to automation | Continue the requested task with the agent |

The previous automatic `npx issue-flow@latest` download was **A: unnecessary**
and has been removed. No current Skill has a **C: necessary CLI dependency**.
An absent, failing or unavailable optional CLI leads directly to the portable
procedure. An offline request skips remote lookups and CLI discovery that could
make them. It never triggers a package download.

Skills use `issues/<id>/` in the target repository. The CLI owns global storage,
SQLite, telemetry and live execution. Do not write directly to those internals.
The existing initial skills → CLI adoption is one-way, not synchronization;
see [artifact continuity](skills-and-agents.md#where-the-artifacts-go).

The CLI currently consumes packaged **prompt templates with shared contracts**,
not each provider's installed `SKILL.md`. This is a legitimate second surface:
the procedural text can differ, while schemas and result protocols share one
source. CLI provider adapters handle invocation/permissions/output transport;
they do not rewrite the canonical Skill. OpenCode Skill support does not imply
that Issue Flow has an OpenCode CLI runner.

## Skill, script, workflow, CLI or MCP?

| Responsibility | Home |
|---|---|
| Reusable procedural judgement | Agent Skill |
| Small deterministic operation such as content hashing | Bundled script |
| State transitions, locks, retries, queues, telemetry | CLI/workflow engine |
| Remote structured capabilities and resources | MCP or another tool provider |
| Harness invocation and permission differences | Optional adapter outside the Skill |

A workflow described in prose is useful guidance but not a durable engine. Do
not promise crash recovery, parallel coordination or exact resumption from a
Skill alone. The Claude-only [`resolve-issue`](skills-and-agents.md) sub-agent
is an optional orchestrator with its own permissions, outside the portable core.
Do not create a Skill for a deterministic CLI subcommand, every tiny step, an
always-on repository rule, or a capability that should be exposed as a tool.

## Structure and progressive disclosure

```text
skill-name/
  SKILL.md        # metadata, purpose, requirements, steps, resource routing
  LICENSE         # added to the distributed artifact
  README.md       # short human entry point; refers to SKILL.md
  references/     # schemas, criteria and conditional detailed instructions
  scripts/        # small executable helpers
  assets/         # optional templates/files used in output
```

The loading order is metadata → relevant Skill body → resources as needed.
Keep `SKILL.md` below 500 lines and approximately 5,000 tokens; these are our
validation limits based on the specification's recommendations, not mandatory
limits imposed by the format. A small coherent Skill needs no extra directories.
`assets/` is currently unused because no binary or ready-to-copy output resource
is necessary; example schemas and annotated templates remain references.

Link supporting material with its reading condition. Markdown links resolve
relative to the document containing them; inline `references/...` and
`scripts/...` paths in instructions resolve from the Skill root. Resolve an
executable's installed path separately from its project input path; changing
cwd to the Skill directory must not redirect output into the installation.
Name every required reference directly from `SKILL.md`, including those also
mentioned by another reference. This project's direct-link rule makes the full
resource set visible to both agents and the build.

## Shared contracts without runtime coupling

Sources remain DRY:

```text
skills/_shared/contracts/ ──build──> dist/skills/<name>/references/
skills/<owner>/references/ ──sync──> packages/issue-flow/prompts/_contracts/
```

A reference owned by one Skill stays there. Only a second Skill consumer
justifies moving it to `_shared/contracts/`. Six shared contracts currently
cover conventions, naming, issue bodies, duplicate detection, task schema and
input safety. `scripts/skill-contracts.mjs` derives consumers from real links;
there is no manually maintained per-provider copy list.

Do not commit generated references. `skills:build` copies only the contracts
cited by each Skill, and preserves its own files and executable modes.
`skills:sync` generates the contracts included by CLI prompts. Tests check
byte parity and isolated copying; prompt tests check include expansion. These
checks prevent textual drift, not arbitrary semantic disagreement by models.

The build refuses to replace a nonempty output without its ownership manifest,
and refuses unexpected files added at the output root. Use a fresh directory
for an old build without a manifest. The manifest is development bookkeeping
and is removed before publication. No runtime symlinks or sibling paths.

## Validation

From the checkout root:

```bash
npm run skills:sync --prefix packages/issue-flow
npm run skills:check --prefix packages/issue-flow
npm run skills:verify --prefix packages/issue-flow
npm test --prefix packages/issue-flow -- src/policy/skills-validation.test.ts src/policy/skills-structure.test.ts src/policy/policy-parity.test.ts
```

`just check` and `just verify` remain aliases. In the package directory, the
shorter `npm run skills:check` works. The checker uses maintained `yaml`,
`marked` and `github-slugger` parsers as development dependencies, not a
proprietary YAML grammar. None ships inside an individual Skill.

It checks metadata types, unique YAML keys, naming, descriptions, supported
fields, size, Markdown/reference-style links, anchors, nested resources,
missing files, path traversal, symlinks, executable scripts and uncited
references. It rejects known CLI runtime dependencies, dynamic Issue Flow
downloads and provider-specific invocations. Static rules are deliberately
bounded: they cannot prove arbitrary prose safe or inspect every possible
command computed by a script.

Source mode resolves declared shared references virtually; artifact mode has
no fallback. Every Skill is also copied alone and validated, including license
and shared-contract parity. CI runs both modes. Success means structural checks
passed, not cross-agent behavioral certification.

For an independent metadata check, install the specification's recommended
[`skills-ref`](https://github.com/agentskills/agentskills/tree/main/skills-ref)
in a development environment and run `skills-ref validate dist/skills/<name>`
for every package. Pin its revision in recorded audit results. Upstream labels
it a demonstration library, and it does not check our links, shell behavior or
CLI independence; it supplements our checks.

## Behavioral testing

See [Skills evals](skills-evals.md). Positive/negative selection and execution
under pressure are separate from syntax checks. The existing
[issue #111](https://github.com/fabioassuncao/issue-flow/issues/111) owns the
repeatable runner and multi-harness baseline. Fixtures/runners live outside
published packages. Judge observable artifacts, tool calls, safety boundaries
and outcomes; never compare chain-of-thought or exact prose.

## Creating and publishing a Skill

1. Define one coherent capability and its positive and negative examples.
2. Use a lowercase ASCII hyphenated directory and matching `name`, up to 64
   characters. Write a nonempty `description` up to 1,024 characters explaining
   when to load it. Avoid triggering on ordinary implementation requests when
   the Skill publishes a backlog item.
3. State `compatibility`, inputs, effects and unavailable-tool behavior. Use
   only `name`, `description`, `license`, `compatibility`, `metadata`; metadata
   values are strings. Our subset also avoids Anthropic's reserved names/XML.
4. Keep vendor fields and tool restrictions outside the portable core.
   `allowed-tools` is experimental in the spec, so we do not rely on it.
5. Add focused references, scripts and assets only when they improve execution.
   Scripts need explicit interpreters, minimal dependencies and clear failures.
6. Follow the shared-contract rule above; validate sources and isolated artifacts.
7. Add meaningful regression cases and selection/execution scenarios; report
   which harness versions actually ran.
8. Update this catalogue and the human README; use the repository's existing
   release process. The publish workflow validates artifacts before publication.
   Release tags are immutable; an old release must not move the current channel.

Repository releases version the Skill bundle; `metadata.version` denotes an
individual instruction revision, not a package-manager dependency mechanism.
There is no registry-specific implementation, mandatory installer or npm runtime
package for Skills. Publication is a separate action from preparing changes.
