# Repository conventions

Before any decision that depends on how *this* repository works — labels, Issue
Templates, Issue Types, title format, base branch, branch and commit naming,
Pull Request body — find out what it actually declares. Never assume, and never
impose a default over a convention the repository already made.

## Resolve them, in this order

Stop at the first provider that answers. Each one is optional; the last always
answers.

### 1. The Issue Flow CLI, when it is on the PATH

```bash
issue-flow policy --json --scope "$(git rev-parse --show-prefix)" 2>/dev/null
```

Preferred because it normalises everything below into one payload, resolves the
`AGENTS.md` hierarchy root-first, and versions the result. `--scope` selects the
hierarchy that applies to the directory being worked in; `git rev-parse
--show-prefix` is empty at the repository root, which the command reads as "the
whole repository".

If `issue-flow` is not on the PATH, try `npx --yes issue-flow@latest policy
--json` **once**. Do not retry beyond that, and do not wait long.

The payload is a versioned object; `docs/commands.md` documents it in full. The
fields a skill reads:

| Path | What it holds |
|---|---|
| `schemaVersion` | bumped only when a reader would have to change |
| `enabled` | `false` when the repository turned discovery off |
| `issues.templates` | every Issue Template, with its required fields, labels and type |
| `issues.types` | the organization's Issue Types, when it has any |
| `issues.labels` | the labels that **really exist** |
| `issues.titleConvention` | a declared title format, or `null` |
| `issues.allowLabelCreation` | `false` unless the repository opted back in |
| `pullRequests.template` | the default Pull Request template's content |
| `pullRequests.baseBranch` | what a PR targets, and the left side of every diff |
| `git.branchConvention`, `git.commitConvention`, `git.pullRequestTitleConvention` | declared formats, or `null` |
| `git.issueReference` | how a commit or PR cites its issue |
| `git.typeMap`, `git.allowedTypes`, `git.scopes` | the vocabulary a type or scope must come from |
| `docs[].path` | the policy documents this repository actually has |
| `codeowners` | the CODEOWNERS content |

It may gain fields in a later release: read the ones you need and ignore the
rest.

| Outcome | What to do |
|---|---|
| Valid JSON | use it, and skip step 2 |
| Command not found | go to step 2 |
| Non-zero exit, empty output, unparseable JSON | go to step 2 |
| Takes too long | stop waiting; go to step 2 |
| `"enabled": false` | the repository turned discovery off — go to step 3 |

### 2. Read the repository directly

**This is not a degraded mode.** Everything the CLI resolves is discoverable
from the repository itself, and an agent with file access and `gh` can read it.
Use your own tools:

| What | Where |
|---|---|
| Issue Templates / Issue Forms | `.github/ISSUE_TEMPLATE/*.{yml,yaml,md}` and its `config.yml` |
| Pull Request template | `.github/PULL_REQUEST_TEMPLATE.md`, or `.github/PULL_REQUEST_TEMPLATE/*.md` |
| Conventions and rules | `AGENTS.md` at the root and at each level down to the working directory; `CONTRIBUTING.md`; anything under `docs/` they point at |
| Ownership | `CODEOWNERS` (root, `.github/`, or `docs/`) |
| Labels that really exist | `gh label list --limit 200 --json name,description,color` |
| Issue Types | `gh api orgs/{org}/issue-types --jq '.[].name'` |
| Base branch | `git symbolic-ref --short refs/remotes/origin/HEAD \| sed 's\|^origin/\|\|'` |
| Recent issue titles (for language and title shape) | `gh issue list --limit 10 --state all --json title --jq '.[].title'` |

**Follow a pointer file rather than stopping at it.** A `CLAUDE.md`, `.cursorrules`
or similar whose entire content forwards to `AGENTS.md` is not a repository
without conventions — read what it points at. `AGENTS.md` is the canonical
entry point for any agent of any vendor; a vendor-specific file is a bridge to
it, never a second source.

A more specific `AGENTS.md` wins over the root one.

When a GitHub tool is available through MCP, it serves for the two `gh` rows
above just as well. Neither `gh` nor MCP is required: a repository with no
remote still declares templates, `AGENTS.md` and `CODEOWNERS` on disk.

### 3. The documented defaults

Only when steps 1 and 2 found nothing. Every skill documents its own defaults;
a repository that declares nothing behaves exactly as it did before any of this
existed. That is the compatibility guarantee.

## Never block on this

Treat the whole step as enrichment. **A skill that needs the network to work is
a regression.** Never fail, never stop, and never tell the user to install
anything just to proceed. Say which path you took only when it changed a
decision.

## How to apply what you found

- **Labels** — use only the ones that exist, matching their casing. **Never
  create one.** Labels are governance: a team that deleted `high`/`medium`/`low`
  in favour of a native priority field made a decision, and recreating them
  undoes it silently and repository-wide. The failure is invisible because it
  *succeeds*. `issues.allowLabelCreation` is the only exception, and it is off
  by default. A label that is not on the list is dropped — say so at the end,
  naming the labels and the classification that was lost.
- **Issue Templates** — when the repository has them, the applicable one defines
  the body's structure and its required fields. A skill's own default structure
  is the fallback for a repository with no template, never a floor to stack on
  top of one. Two templates fitting equally well is a question for the user, not
  a coin toss — or pick the more specific and say so.
- **Issue Types** — when the repository has them, pick one and pass `--type`. A
  repository with Issue Types has usually removed the equivalent textual prefix
  from titles (`[Bug]`, `[Enhancement]`) precisely because that information moved
  into a structured field: do not reintroduce it.
- **Base branch** — it is the target of a Pull Request and the left side of every
  `git log`/`git diff` range. **Never assume `main`**: in a repository based on
  `develop`, `main` usually exists too, so assuming it does not fail — it
  silently produces the wrong diff.
- **Branch and commits** — follow the declared conventions. When none are
  declared, the default is `{type}/{N}-{slug}` for a branch and Conventional
  Commits for a message; a skill that actually names branches or commits carries
  the full rules in its own `git-conventions` reference. A branch that does not
  match is worth a warning, never a stop.
- **Pull Request body** — when there is a template, keep every one of its
  headings and answer the sections that do not apply with one line saying why.
  Deleting a section is what makes automated review read it as unanswered.
- **Documents** — the paths you found are pointers. Read the ones a decision
  depends on.
- **Never restate a repository rule as your own standard**, and never invent one
  it does not declare. Cite the document and section behind every rule you
  invoke — a rule without a citation is an opinion the author cannot check.
