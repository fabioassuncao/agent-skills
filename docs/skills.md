# Agent Skills

Issue Flow publishes ten [Agent Skills](https://agentskills.io) under
[`skills/`](../skills/). They follow the open specification, they are the
**canonical, public interface** of this project, and they do **not** require the
Issue Flow CLI.

> The CLI is a complementary tool. Where it is installed, a skill uses it for a
> more deterministic or normalised answer. Where it is not, the skill does the
> same job with git, `gh`, the filesystem and the agent's own tools.

For the Claude Code `resolve-issue` sub-agent — which orchestrates these skills
into one pipeline and *is* vendor-specific — see
[Skills & sub-agent](skills-and-agents.md).

## The catalogue

| Skill | What it does | Needs | Writes |
|---|---|---|---|
| [`init-repository`](../skills/init-repository/) | Fills the gaps in a repository's conventions — Issue Forms, PR template, `AGENTS.md` — never overwriting one that exists | `git`; `gh` optional | files that are missing |
| [`generate-issue`](../skills/generate-issue/) | Turns a short instruction into an architect-quality GitHub issue | `git`, `gh` | one GitHub issue |
| [`generate-local-issue`](../skills/generate-local-issue/) | The same, as files in the repository, with no GitHub at all | `git`; `gh` optional | `issues/<id>/` |
| [`analyze-issue`](../skills/analyze-issue/) | Extracts scope, complexity and ambiguities from an issue before planning | `git`, `gh` | nothing |
| [`generate-prd`](../skills/generate-prd/) | Turns an issue into a PRD of small, ordered, verifiable stories | filesystem | `issues/{N}/prd.md` |
| [`convert-prd-to-json`](../skills/convert-prd-to-json/) | Turns a PRD into a machine-readable task plan | filesystem, `git` | `issues/{N}/tasks.json` |
| [`execute-tasks`](../skills/execute-tasks/) | Implements one story per iteration, with checks and a commit each time | `git`, the project's toolchain | code, commits, the plan, the log |
| [`create-pr`](../skills/create-pr/) | Opens one well-described Pull Request for the current branch | `git`, `gh` | a push and a Pull Request |
| [`review-issue`](../skills/review-issue/) | Verifies an issue was actually resolved, and closes it when it was | `git`, `gh`, the test runner | closes or comments on the issue |
| [`review-pr`](../skills/review-pr/) | Reviews a Pull Request as a whole and ends with one recommendation | `git`, `gh` | nothing |

Every `SKILL.md` opens with a **Requirements** section stating exactly what the
skill needs, what it writes, and what it will never do. Read it before
installing — three of these skills change the repository, and two change
GitHub.

## Installing

### Any agent, with `npx skills`

```bash
npx skills add fabioassuncao/issue-flow#skills                       # every skill
npx skills add fabioassuncao/issue-flow#skills --skill generate-issue  # just one
```

**The `#skills` part is not optional.** It names the branch carrying the
assembled tree. The default branch holds *sources*, where the shared contracts
have not been materialised into each skill yet — install from there and the
skills arrive with references pointing at files that are not present. See
[How the skills stay in one piece](#how-the-skills-stay-in-one-piece).

A release also publishes `skills-vX.Y.Z`, so `#skills-v0.19.0` pins a version.

With the GitHub CLI, `--pin` does the same job:

```bash
gh skill install fabioassuncao/issue-flow create-pr --pin skills
```

What the installer does: it finds each directory containing a `SKILL.md`, copies
that whole directory — `references/`, `scripts/` and all — into a canonical
store (`~/.agents/skills/` with `-g`, the project's `.agents/skills/`
otherwise), then links each agent's own skills directory at it. One install,
every linked agent sees it. `--copy` makes independent copies instead of
symlinks.

### By hand

Copy the skill's directory from the
[`skills` branch](https://github.com/fabioassuncao/issue-flow/tree/skills) —
the whole directory, `references/` and `scripts/` included — into the location
your agent scans. Take it from that branch, not from `main`: only there is each
skill complete.

| Agent | User level | Project level |
|---|---|---|
| Cross-agent convention | `~/.agents/skills/` | `<repo>/.agents/skills/` |
| Claude Code | `~/.claude/skills/` | `<repo>/.claude/skills/` |
| Codex CLI | `~/.agents/skills/` | `<repo>/.agents/skills/` |
| Cursor | `~/.cursor/skills/` or `~/.agents/skills/` | `.cursor/skills/` or `.agents/skills/` |
| OpenCode | `~/.config/opencode/skills/` or `~/.agents/skills/` | `.opencode/skills/` or `.agents/skills/` |
| Gemini CLI | `~/.gemini/skills/` or `~/.agents/skills/` | `.gemini/skills/` or `.agents/skills/` |
| Antigravity | `~/.gemini/config/skills/` | `<workspace>/.agents/skills/` |

`~/.agents/skills/` is the emerging cross-client convention and is the one to
prefer. Claude Code is the notable exception: it does not scan it, which is why
`npx skills` symlinks `~/.claude/skills/<name>` at it.

Gemini CLI also has `gemini skills install <repository> --path <subdir>`.
Cursor's "Remote Rule (GitHub)" import is a different feature — it syncs `.mdc`
rules, not skills — so for Cursor, copy the directory.

## Compatibility

Verified against each product's own documentation, in September 2026. "Native"
means the agent discovers a `SKILL.md` on its own, with no adapter.

| Platform | Skills | Bundled `references/` | Bundled `scripts/` | Notes |
|---|---|---|---|---|
| [Claude Code](https://code.claude.com/docs/en/skills) | Native | Yes | Yes, gated by `allowed-tools` | Does not scan `.agents/skills/`. Has many extension fields, none of which these skills use — a skill using them cannot be uploaded to claude.ai |
| [Codex CLI](https://learn.chatgpt.com/docs/build-skills) | Native | Yes | Yes | Scans `.agents/skills` from the cwd up to the repository root, plus `~/.agents/skills` and `/etc/codex/skills`. Duplicate skill names are **not** merged — both appear |
| [Cursor](https://cursor.com/docs/skills) | Native | Yes | Yes | Also reads `.claude/skills` and `.codex/skills` for compatibility; scans recursively |
| [GitHub Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills) | Native, GA since 2026-07-29 | Yes — "all of the files in the skill's directory" | Yes, via `allowed-tools`, otherwise it asks | `.github/skills`, `.claude/skills`, `.agents/skills`; personal `~/.copilot/skills`, `~/.agents/skills`. `gh skill install` is in public preview |
| [Gemini CLI](https://geminicli.com/docs/cli/skills/) | Native | Yes — activating a skill grants **read** access to its directory | Not documented | Four precedence tiers; `.agents/skills` wins over `.gemini/skills` at the same tier. `gemini skills install <repo> --consent` |
| [Antigravity](https://antigravity.google/docs/skills/) | Native | Yes, by relative path | Yes | Its own convention is `examples/`/`resources/`; `references/` works because the skill names the path. Global dir is `~/.gemini/config/skills/` |
| [OpenCode](https://opencode.ai/docs/skills/) | Native | Not documented | Not documented | Accepts **only** `name`, `description`, `license`, `compatibility`, `metadata` — the strictest, and what our frontmatter targets. Unknown fields ignored |
| [Windsurf](https://docs.windsurf.com/windsurf/cascade/skills) | Native | Yes | Not documented | `.windsurf/skills/` plus `.agents/skills/`; reads Claude Code's dirs when enabled |
| [Zed](https://zed.dev/docs/ai/skills) | Native | Yes | Yes | `.zed/skills/`, `~/.zed/skills/`. Notably, the agent cannot edit a `SKILL.md` or its resources without explicit authorisation, even in a trusted project |
| [Goose](https://goose-docs.ai/docs/guides/context-engineering/using-skills/) | Native | Yes | Yes | Discovers `~/.config/goose/skills/`, `.goose/skills/`, `.agents/skills/`, `.claude/skills/` |
| [Cline](https://docs.cline.bot/customization/skills) | Native | Yes (`docs/`, `scripts/`) | Yes | `.cline/skills/`, `~/.cline/skills/`. On a name collision the **global** skill wins — the inverse of everyone else |
| [Devin](https://docs.devin.ai/product-guides/skills) | Native | Not documented | Not documented | `.agents/skills/<name>/SKILL.md`; injects the whole body as a system instruction on invocation |
| [Amp](https://ampcode.com/news/agent-skills) | Native, **self-described experimental** | Not documented | Via a dedicated sandbox skill | `.agents/skills/`, `~/.config/agents/skills/`, plus Claude Code's dirs |
| [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/agents/skills) | Native (SDK) | Yes | Yes, via a script runner | Reads `references/` and `assets/` "per the agentskills.io specification", two levels deep inside each skill. Its MCP-based skill source is **experimental** in both C# and Python |
| Aider | **No evidence** | — | — | Reads `AGENTS.md`; no source found showing native `SKILL.md` discovery |

**Not verified:** the exact script-execution permission model for Codex CLI,
Cursor, Gemini CLI, Antigravity and Amp — each documents that `scripts/` exists
and runs, without describing the approval or sandbox model the way Claude Code
and Copilot do. And every product not in the table: the
[client showcase](https://agentskills.io/clients) lists many more, and absence
above means we did not check, not that it fails.

**Two dialects of one description rule.** The open specification recommends
imperative phrasing — "Use this skill when…" — while Anthropic requires the
third person and rejects "I can help you…" or "You can use this to…". These
descriptions satisfy both: they open with a verb describing the capability, then
list triggers with "Use this skill when…", and never speak as or to the user.
Anthropic additionally rejects XML tags anywhere in `name` or `description`, and
the words "anthropic" or "claude" in a `name` — both enforced by
`npm run skills:check`.

### What the skills deliberately do not use

- **No `allowed-tools`.** The specification marks it experimental and says
  support varies. A skill that needs it is a skill that breaks on half the
  agents that read it.
- **No vendor frontmatter** — no `model`, `paths`, `disable-model-invocation`,
  `argument-hint` or anything else outside the open specification. The
  frontmatter is exactly `name`, `description`, `license`, `compatibility` and
  `metadata`, which is the intersection every listed agent accepts.
- **No reference outside the skill directory.** Enforced by CI; see
  [Validation](#validation).

## Agent Skills and MCP are not the same thing

They solve different problems and neither replaces the other.

- **Agent Skills** are instructions and resources: *what to do, and how*.
- **MCP** is a protocol for tools and data: *what the agent can call*.

The MCP documentation's own
[Build with Agent Skills](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-with-agent-skills)
page uses skills to *build MCP servers*, and its installation advice is to clone
the skill directories into your agent's skills location. It defines no MCP
mechanism for distributing or discovering skills.

So: **no skill here depends on MCP.** Where a skill reads or writes GitHub, an
equivalent GitHub tool exposed over MCP works just as well as `gh`, and each
skill says so. That is a provider choice, never a requirement.

## When the Issue Flow CLI helps

Every skill works without it. Where it is installed, it offers a more
deterministic answer for things a skill would otherwise have to derive:

| Capability | Command | Fallback without it |
|---|---|---|
| Resolve the repository's conventions in one normalised payload | `issue-flow policy --json --scope <dir>` | Read `.github/`, `AGENTS.md`, `gh label list`, `gh api orgs/{org}/issue-types` directly |
| Compute a branch name, commit message or PR title from the convention | `issue-flow conventions branch\|commit\|pr-title` | The documented defaults in each skill's `references/git-conventions.md` |
| Plan and apply repository initialisation | `issue-flow init --json` / `--apply` | The baseline in `init-repository/references/repository-scaffold.md` |

Each of those is a **preferred provider**, not a prerequisite. A skill that
needed the network — or this CLI — to work would be a regression, and the rule
is stated in the contract every skill carries.

`init-repository` is the only skill where the CLI adds enough to be worth
mentioning first; the other nine treat it as an optimisation.

## Where the artifacts go

The skills write to `<repo>/issues/{N}/`, inside the repository the session is
already working in. The CLI writes to
`~/.issue-flow/projects/<project-id>/issues/{N}/` and keeps structured state in
SQLite. There is a **one-way adoption bridge** — skills → CLI, once — and no
synchronisation after that. Pick one surface per issue. Details and the loss
matrix: [Skills & sub-agent](skills-and-agents.md#where-the-artifacts-go).

Add `/issues` to `.gitignore` unless you want those artifacts committed. For a
local issue created by `generate-local-issue`, you probably do: the demand
itself lives there.

## How the skills stay in one piece

**The working tree holds no generated file at all.** Each skill owns its own
references; the five contracts cited by more than one skill live once, in
`skills/_shared/contracts/`. The tree users install is *assembled* from those:

```text
main / develop  — sources, hand-written
  skills/_shared/contracts/*.md      5 shared contracts
  skills/<name>/SKILL.md
  skills/<name>/references/          the skill's own

        │  scripts/build-skills-tree.mjs --out dist/skills
        ▼

branch `skills`  — force-pushed by CI, never merged
  <name>/SKILL.md
  <name>/references/                 its own + the shared ones, materialised
```

This is possible because the installer accepts a ref. From its own tests:

```ts
it('parses github shorthand with #branch', () => {
  const result = parseSource('vercel-labs/agent-skills#feature/install');
  expect(result).toEqual({ url: '…/agent-skills.git', ref: 'feature/install', … });
});
```

**A contract cited by one skill has no shared copy at all** — it simply lives in
that skill's `references/`, hand-written. Its only other reader is a CLI prompt,
and that side is a build artifact (`prompts/_contracts/`, generated by
`prebuild`/`pretest`, not versioned).

| Owner | Contract |
|---|---|
| `skills/generate-prd/` | `prd-structure.md` |
| `skills/create-pr/` | `pr-body.md` |
| `skills/review-pr/` | `pr-review-report.md`, `pr-review-result-block.md` |
| `skills/review-issue/` | `issue-review-report.md`, `review-result-block.md` |
| `skills/execute-tasks/` | `progress-log.md`, `completion-signal.md` |

**Nothing is listed by hand.** The build reads each `SKILL.md`, sees which
`references/*.md` it cites, and materialises exactly those. Adding a citation is
the only action needed; a shared contract nobody cites fails validation, as does
a reference nothing points at.

**Why not symlinks.** Three reasons, in order of how badly each bites:

- **One major installer refuses them outright.** `vercel-labs/skills` rejects
  every symlink and hard link entry in a downloaded archive —
  `throw new Error('Archive links are not supported')` in
  `src/providers/wellknown.ts`.
- **Git corrupts them silently on Windows.** Its own `core.symlinks`
  documentation: *"If false, symbolic links are checked out as small plain files
  that contain the link text."* The agent would read the path string as the
  contract. No error, wrong answer.
- **Nobody does it.** Across 185 skills installed on a real machine there is not
  one symlink inside a skill directory, and the specification does not mention
  them.

**Why not a shared skill the others depend on.** There is nothing to depend on:
"skill A uses skill B" is an open, unresolved gap in the specification
([agentskills#100](https://github.com/agentskills/agentskills/issues/100)). The
one pattern that works is prose — the `hyperframes` family and Google's 31
`gke-*` skills point at each other **by name**, sharing pointers, not content.

Copying is what the ecosystem does when it must: Anthropic's own `docx`, `xlsx`
and `pptx` carry byte-identical copies of the same OOXML toolkit, with nothing
keeping the three in step. What this repository adds is the part they lack — a
single source, a generator, and a CI gate that assembles the tree and validates
it before publishing.

```bash
just check     # validate the sources
just verify    # assemble the publishable tree and validate it strictly
just build     # just assemble it, into dist/skills
```

**The path not taken, yet.** The ecosystem has a mechanism designed for exactly
this: a publisher serves `/.well-known/agent-skills/index.json`, and each entry
carries a `url` and a mandatory `sha256` digest. The
[discovery RFC](https://github.com/cloudflare/agent-skills-discovery-rfc) is
explicit that *"the `url` field allows skills to be hosted at any location (e.g.,
on a CDN or at a versioned path)"*, and `type: "archive"` takes a `.tar.gz`. That
would let a plain `npx skills add <url>` install the generated tree with no ref
at all, closing the footgun below — it needs somewhere to host the index, which
this project does not have yet.

Worth knowing which way the wind blows: the pattern most repositories document
is generating *and committing* the per-agent trees in the same repository
(`FavioVazquez/sprang`, `antonbabenko/terraform-skill`). Publishing a generated
tree to a branch is less trodden — sanctioned by the discovery spec, but not
common. If it turns out to cost more than it saves, committing the assembled
tree under a second directory is the fallback, and `build-skills-tree.mjs`
already produces it.

## Validation

`npm run skills:check` enforces, as errors:

- `SKILL.md` exists and its YAML frontmatter parses
- `name` and `description` present and non-empty
- `name` ≤ 64 characters, lowercase alphanumerics and single hyphens, matching
  the directory name
- `description` ≤ 1024 characters, `compatibility` ≤ 500
- `metadata` is a map of strings to strings
- no frontmatter field outside the open specification, and no `allowed-tools`
- nothing that parses as an XML tag in `name` or `description`, and no
  `anthropic`/`claude` in a `name` — Anthropic rejects both outright
- `SKILL.md` under 500 lines and ~5000 tokens
- **every relative reference resolves inside the skill directory** — in
  `SKILL.md`, in `README.md` and in every file under `references/`
- **no reference chain**: a file reachable only through another reference, and
  never named by `SKILL.md`, is an error. The specification says to keep
  references one level deep, and a chain is also how a link to a file that was
  never shipped hides
- **no dead reference**: a file under `references/` that `SKILL.md` never cites
  is an error, and so is a shared contract no `SKILL.md` cites. Neither is
  broken, so nothing else catches them — they are just weight every reader and
  every editor pays for

It runs in two modes, because the working tree and the published tree are not
the same thing. Over the sources (`npm run skills:check`) a cited reference may
be absent when `_shared/contracts/` holds it — the build will supply it. Over an
assembled tree (`npm run skills:verify`) nothing may be missing: that is the
artifact a user installs, so a reference that is not there is a dangling link in
the field. **CI runs both on every pull request**, and the publish workflow runs
the strict one again before pushing.
- every file in `scripts/` is executable
- every generated contract copy is byte-identical to its source

The ecosystem's own
[`skills-ref validate`](https://github.com/agentskills/agentskills/tree/main/skills-ref)
is a useful extra check, but it is a Python package that describes itself as
"for demonstration purposes only, not production use", and it does not verify
links or contract sync — which are the two things that actually broke here.

## Contributing a skill

1. **One coherent capability.** Too narrow forces several skills to load for one
   task; too broad makes activation imprecise.
2. **Write the `description` for discovery.** It is all an agent sees before
   deciding. Say what the skill does *and when to use it*, include the phrases a
   user would actually type, and say when **not** to use it — naming the skill
   that should be used instead.
3. **Keep `SKILL.md` under 500 lines.** Move long templates, schemas and
   reference material into `references/`, and say *when* to load each one.
4. **State Requirements and side effects.** Binaries needed, what it writes,
   what it will never do.
5. **Never reference anything outside the skill directory.** Put a reference the
   skill owns in its own `references/`, hand-written — most belong there. Only
   when a **second skill** needs the same text does it move to
   `skills/_shared/contracts/`; cite it as `references/<name>.md` from both
   `SKILL.md` files and the build works out the rest. Never commit a generated
   copy: `just check` fails on one.
6. **Describe a capability, not a command.** Say what has to happen and let the
   agent use the best provider available — its own tools, git, `gh`, MCP, or the
   Issue Flow CLI. If a CLI is genuinely better, say why, how to detect it, what
   it returns, how to handle its failure, and what the fallback is.
7. **No vendor assumptions.** `AGENTS.md` is the canonical entry point; a
   `CLAUDE.md` or `.cursorrules` is a pointer to follow, never the source. No
   vendor frontmatter, no orchestrator-only steps.
8. **Prefer a script for a deterministic operation.** Something with one right
   answer — a hash, an identifier — belongs in `scripts/`, not in prose.
9. **Run `npm run skills:check`.**

## Known limitations

- **OpenCode** does not document bundled-resource reading or script execution.
  The skills degrade gracefully — a reference that cannot be opened costs
  detail, not correctness — but this is untested there.
- **Antigravity** conventionally uses `examples/` and `resources/`. Our
  `references/` works because every skill names the path explicitly, but it is
  not what that product auto-discovers.
- **The `resolve-issue` sub-agent is Claude Code only.** It also runs with
  `permissionMode: bypassPermissions`, which means it does not ask before
  writing or running commands. That is a deliberate trade for unattended runs,
  it is not part of the skills, and you should not install it unless you want
  that behaviour. See [Skills & sub-agent](skills-and-agents.md).
- **`skills/` is not published to npm.** Shipping a second installable copy
  inside the package would be a source of drift.

- **Installing needs a ref, and not every installer accepts one.** Two do:
  `npx skills add …#skills` (the `#ref` fragment is parsed for any git-like
  source, verified in `source-parser.ts` and its tests) and
  `gh skill install fabioassuncao/issue-flow <skill> --pin skills` (`--pin`
  takes a tag, a commit SHA or a branch, verified in `cli/cli`'s
  `pkg/cmd/skills/install/install.go`). So does any `git clone --branch`.

  `gemini skills install <url>` documents `--path` for a subdirectory but **no**
  flag for a branch or tag — from it, and from any agent that only takes a
  repository, install by copying a skill directory out of the
  [`skills` branch](https://github.com/fabioassuncao/issue-flow/tree/skills) by
  hand. This is the price of keeping generated files out of the source tree, and
  it is a real one.

- **`npx skills add fabioassuncao/issue-flow`, with no ref, installs sources.**
  The skills arrive with references pointing at files the default branch does
  not carry. The installer has no way to warn about it, so the only defence is
  documentation — hence the repetition here and in `skills/README.md`.
