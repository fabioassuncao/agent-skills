# Convention-aware behaviour

Issue Flow adapts to the repository it runs in. When that repository already
declares how it works, the tool follows it; when it declares nothing, the tool
supplies a baseline and can write it down.

This document owns the shared repository conventions and explains their CLI
implementation. [Agent Skills](../skills/README.md) discover instructions directly
in the consumer repository; their host's permissions still apply. CLI discovery,
configuration loaders and commands below describe the [experimental CLI](cli.md).
Skills do not require those commands or configuration files.

## The precedence ladder

The CLI policy loader applies this ladder:

```text
Issue Flow defaults
  < conventions discovered in the repository (and in its organization)
  < the "policy" key of .issue-flow.json
  < ISSUE_FLOW_POLICY_* environment variables
  < CLI flags
```

The rungs are applied by `mergeConfigLayers()` and resolved once per process by
`loadRepositoryPolicy()`. Two consequences are worth stating plainly:

- **A declared value beats a discovered one**, so a wrong discovery is corrected
  without having to switch discovery off.
- **An undeclared value stays absent**, never `null`, so an empty configuration
  key can never erase what discovery found.

`policy.enabled: false` returns before a single `stat()` or network call.

### The `resilience` key

Resilience configures the CLI runtime rather than repository conventions. See
[configuration](configuration.md#resilience) for its precedence and fields, and
[Resilience](resilience.md) for retries, failover and failure handling.

#### The `continuous` profile

See [the continuous profile](resilience.md#the-continuous-profile) for expansion,
overrides and retry boundaries. It is not a Skill execution mode.

### Where the organization sits

An organization's conventions arrive through discovery, not through a separate
mechanism, because that is how GitHub serves them:

| Convention | Where it comes from |
|---|---|
| Issue Templates | the repository's `.github/ISSUE_TEMPLATE/`, or the organization's `.github` repository when the repository has none |
| Issue Types | the organization (`gh api orgs/{org}/issue-types`) — they exist nowhere else |
| Labels | the repository's real labels (`gh label list`) |

A repository with no templates of its own still gets the organization's, and
Issue Flow follows them. It never copies them locally: a fork stops tracking the
original the moment either side is edited.

## What is discovered

| Source | Where it is looked for |
|---|---|
| Issue Templates and Forms | `.github/ISSUE_TEMPLATE/**`, `docs/ISSUE_TEMPLATE/**`, the root, and the single-file variant of each |
| Organization templates | the GraphQL `issueTemplates` connection, only when the local tree has none |
| Pull Request template | `.github/PULL_REQUEST_TEMPLATE.md`, the directory of several, `docs/`, the root |
| Labels | `gh label list` — the labels that really exist |
| Issue Types | `gh api orgs/{org}/issue-types` |
| Base branch | `origin/HEAD`, then a local `main`/`master` |
| Agent instructions | `AGENTS.md` and `CLAUDE.md`, from the root down to the scope |
| Governance | `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CODEOWNERS` |
| Referenced documents | the markdown links of `AGENTS.md` and `CLAUDE.md`, followed one level |
| Git conventions (declared) | `commitlint` (config or `package.json`), `release-please`, `semantic-release`, Changesets, `action-semantic-pull-request`, `commitlint` in CI, `.husky/commit-msg`, `commit.template` / `.gitmessage` |
| Git conventions (inferred) | recent commit subjects and existing branch names — reported, never binding; see [`docs/git-conventions.md`](git-conventions.md) |

Everything is best-effort. A repository declaring none of it resolves to an empty
policy, **without an error and without a warning**, and every flow keeps the
behaviour it had before this layer existed. A missing `gh`, or no network,
degrades the same way — and `sources` records the difference between "declares
nothing" and "could not find out".

Inspect the result with:

```bash
issue-flow policy            # human-readable, with the provenance of each value
issue-flow policy --json     # versioned contract for optional Skill enrichment
```

## The default conventions

These apply only where the repository, its organization and your configuration
are all silent. Two rules shaped them.

**Native structure before textual convention.** The order of preference is
native feature > structured field > label > free text. Anything GitHub already
models is not re-implemented as a title prefix or a label, because that creates
a second truth that ages on its own.

**Do not fragment the backlog.** A type per flavour of work makes no query
better and every filter worse.

### Six issue types

| Type | What it is | Authorizes execution? |
|---|---|---|
| **Idea** | A hypothesis, opportunity or perceived problem, not yet analysed | **No** |
| **Research** | An investigation that produces knowledge | **No** |
| **Epic** | An umbrella objective delivered through sub-issues | **No** |
| **Feature** | A new capability or a change to what the product does | Yes, once ready |
| **Bug** | Existing behaviour that diverges from what is expected | Yes, once ready |
| **Task** | Concrete work that is neither a feature nor a bug | Yes, once ready |

`Bug`, `Feature` and `Task` are GitHub's own defaults, so they exist in every
organization. The other three answer a question those cannot: *is this worth
doing*, *what is the answer*, and *what is the umbrella*.

**An open issue is not approved work.** `Idea`, `Research` and `Epic` record
intent and never authorize an agent to start implementing. The multi-issue
queue honours that: an Epic (or any issue with sub-issues) is a `container`
— `issue-flow run <epic> --cascade` executes the children and never a phase
for the umbrella. Without `--cascade` or `--only`, a non-interactive run
of a container fails instead of implementing the document nobody approved.

### What is deliberately not a type

| Concept | Represent it as | Why |
|---|---|---|
| Documentation | `Task` + an existing documentation label | The work is a task; what varies is the area |
| Maintenance, chore | `Task` | That is already what `Task` means |
| Refactor, technical debt | `Task` + an existing refactoring/debt label | A cross-cutting characteristic, not a nature |
| Security | the real type + label `security` | It cuts across every type |
| Spike, investigation | `Research` | The same concept, different name |
| Enhancement | `Feature` | A change to what the product does is a feature |
| Proposal, RFC | `Research`, plus an ADR for the decision | The decision belongs in a document that outlives the issue |
| Question | a Discussion, or `Research` | A question needing no work is not a backlog item |

### Labels

For issues, prefer a small vocabulary for what has no native representation — area, component and
cross-cutting characteristic: `api`, `backend`, `frontend`, `database`, `infra`,
`documentation`, `security`, `tech-debt`, `blocked`, `good first issue`. These are
examples for discovery/fallback, not a requirement to create those names. In this
repository the existing documentation label is `documentation`.

Do not create duplicate priority/status/type/size labels when the project models
those decisions with native Issue Types, Projects fields or other existing
structure. A `type:*` fallback can be proposed for issues when native Issue Types
are unavailable. PRs are classified separately: their applicable labels and
other metadata follow [PR conventions](git-conventions.md#pr-description-and-metadata).
Existing labels are not removed or migrated by this guidance.

**Issue Flow never creates a label.** A suggestion the repository does not have is
dropped with a warning. A team that deleted `high`/`medium`/`low` in favour of a
priority field made a decision, and silently recreating those labels undoes it —
worse than a failure, because it succeeds. `policy.issues.allowLabelCreation: true`
opts back in.

### Branches and commits

Documented in [`docs/git-conventions.md`](git-conventions.md). Default branch:
`{type}/{N}-{slug}`. Commits follow Conventional Commits.

Git artefacts describe **what changed in the software**. Execution telemetry
in `tasks.json` (`plan.executions`) describes **how the change was produced**.
Provider, harness, model, tokens and cost never appear in a branch name, a
commit message, a Pull Request body or a changelog. See
[`src/telemetry/AGENTS.md`](../packages/issue-flow/src/telemetry/AGENTS.md).

## Agent entry points

```text
CLAUDE.md  →  AGENTS.md  →  specialized documentation  →  single source of truth
```

**`AGENTS.md` is canonical.** It is the entry point for any coding agent of any
vendor — an [open convention](https://agents.md), where agents read the nearest
file in the directory tree and the closest one wins. Issue Flow treats it as an
**index**: it names the documents to read and holds no rule of its own.

That neutrality is now load-bearing. The pipeline can run on Claude Code or
Codex CLI (see [`docs/agents.md`](agents.md)); the same `AGENTS.md` is what both
read. A convention written for one vendor would make the other produce a
different result from the same repository.

**`CLAUDE.md` is a bridge.** It exists only as the Claude Code integration and
contains one line:

```markdown
Read and follow the instructions in AGENTS.md.
```

Both conventions allow their own content. Issue Flow deliberately restricts that:
an instruction duplicated in an agent file ages out of sight and starts
contradicting its source without anyone noticing. Any other tool-specific adapter
follows the same rule — a pointer, never a second copy.

### What does not belong in `AGENTS.md`

Anything that can live in a document of its own: build and test commands, code
style, architecture rules, testing strategy, operational procedures. An
instruction that today exists only in an agent file does not stay there — move it
to the right document and leave a reference behind.

Do not create a document just to empty an agent file. Documentation that is too
fragmented costs as much as documentation that is duplicated.

### How Issue Flow reads them

Discovery walks the hierarchy from the root down to the scope, so
`apps/api/AGENTS.md` arrives after — and therefore wins over — the root one. It
also **follows a pointer file rather than stopping at it**: a `CLAUDE.md` whose
whole content forwards to `AGENTS.md` is not a repository without conventions.

## Initializing a repository

For the recommended interactive workflow, use
[`init-repository`](../skills/init-repository/SKILL.md) to inspect the consumer
repository and plan missing conventions. Initialization is optional when the
repository already has the conventions it needs.

The CLI exposes the same capability through these commands:

```bash
issue-flow init                 # prerequisites + what is missing. Writes nothing
issue-flow init --apply         # create the missing files
issue-flow init --json          # the plan, for tooling and for the Agent Skill
issue-flow init --scope apps/api
issue-flow init --check-only    # prerequisites only, as earlier releases did
```

The Skill renders candidates with bundled canonical renderers; consulting an
installed CLI is an optional optimization. The verdicts and preservation rules
below describe the shared scaffold behavior.

### The three verdicts

| Verdict | Meaning |
|---|---|
| `create` | Missing, and the repository has no equivalent |
| `keep` | Something equivalent already exists — left untouched |
| `review` | Present but inconsistent; reported, never rewritten |

**Nothing that exists is ever overwritten**, even when it differs from the
defaults. Adapting to the repository is the point; "initialize" must not become a
euphemism for "replace". Existence is re-checked immediately before each write,
so a file created between planning and writing is skipped rather than clobbered.

**Running it twice writes nothing the second time.** The plan is computed from
what is present, not from what a previous run did.

### What it can create

| File | Tier | Responsibility |
|---|---|---|
| `.github/ISSUE_TEMPLATE/*.yml` | required | One Issue Form per type |
| `.github/ISSUE_TEMPLATE/config.yml` | required | The chooser, with blank issues enabled |
| `.github/PULL_REQUEST_TEMPLATE.md` | required | A body review can rely on |
| `AGENTS.md` | required | The canonical agent entry point, as an index |
| `CLAUDE.md` | recommended | The one-line bridge |
| `docs/conventions.md` | recommended | The source of truth the rest reference |
| `.github/labels.json` | contextual | Only when the repository has no labels at all |

Nothing is created to fill out a structure. A repository whose `CONTRIBUTING.md`
and Issue Templates already document how it works gets no competing conventions
document.

### Behaviour by repository state

| State | What happens |
|---|---|
| No conventions at all | The full baseline is proposed |
| Some templates | Only the gaps are filled; existing files are kept |
| Complete conventions | Nothing to create; the report says what it recognized |
| Conventions differing from the defaults | Preserved. The defaults never apply |
| Templates from the organization | Kept there; no local copy is made |
| `AGENTS.md` already present | Kept; only `CLAUDE.md` may be added |
| Only `CLAUDE.md`, carrying instructions | Reported as `review`. Promoting it to `AGENTS.md` moves text a person wrote, and is never automatic |
| Both, both carrying instructions | Reported as `review`, naming the duplication |
| No Issue Types in the organization | Reported. They are an organization setting; the `type:*` labels are only a fallback |

## How the flows consume all this

Every CLI flow reads the same resolved policy:

| Flow | What it does with the conventions |
|---|---|
| `generate` | Follows the applicable Issue Template, picks an Issue Type, uses only labels that exist, applies the title convention |
| `analyze` | Judges completeness against the template's required fields |
| `plan` | Names the branch by the repository's convention |
| `execute` | Chooses the commit type by the repository's convention |
| `pr` | Diffs and targets the resolved base branch; writes the body to the PR template |
| `review`, `pr-review` | Add policy conformance as an explicit axis, citing the document behind every rule |
| `init` | Reports and fills only what is missing |

Agent Skills discover the consumer repository directly, with optional enrichment
from `issue-flow policy --json`. Shared decisions are authored once under
[`skills-src/_shared/`](../skills-src/_shared/) and materialized into each Skill
and applicable packaged prompts. Pure naming rules are bundled from the CLI's
canonical modules. See [the source/artifact contract](skills.md); installed
Skills never read the Issue Flow source tree.

## Customizing

### Declare what discovery cannot infer

```json
{
  "policy": {
    "issues": { "titleConvention": "[Area] Title", "allowLabelCreation": false },
    "pullRequests": { "baseBranch": "develop" },
    "git": { "branchConvention": "feat/{slug}", "commitConvention": "conventional" },
    "discovery": { "labels": false },
    "contextBudget": 1500
  }
}
```

### Adjust a CLI prompt

CLI policy context is selected by phase. Generation and analysis retain discovery
metadata; PR phases retain publication templates and vocabulary. PRD, plan,
execute and issue review omit publication metadata. Branch/commit conventions
and policy-document paths remain available in every phase. `contextBudget` is a
soft budget for optional sections: it never discards those essential conventions
or paths. Follow document indexes to load the rules relevant to the decision.

Placeholder interpolation happens once, after evaluating template conditionals.
Inserted issue text, diagnostics and other values remain literal, including
`$&` and strings resembling placeholders; they are not another template pass.

| File | Effect |
|---|---|
| `.issue-flow/prompts/<name>.append.md` | Appended to the packaged prompt. **Recommended** |
| `.issue-flow/prompts/<name>.md` | Replaces it entirely |

`append` is recommended because a full replacement makes the repository inherit
that prompt's maintenance: later improvements stop reaching it, silently.
Installed Skills keep their own resources; these overrides affect only the CLI.
Contributor edits to packaged defaults follow the [source/artifact contract](skills.md#source-and-distribution).

### Establish conventions for a whole organization

Put them where GitHub already serves them from, and Issue Flow will find them in
every repository of the organization:

- **Issue Templates and Forms** → the organization's `.github` repository
- **Issue Types** → the organization's settings
- **Shared documents** → linked from each repository's `AGENTS.md`

A repository that needs to differ declares the difference in its own
`.issue-flow.json`, which sits above discovery on the ladder.
