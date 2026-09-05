---
name: analyze-issue
description: >
  Fetch and analyze a GitHub or local issue to extract context, scope, affected areas, and complexity
  before planning implementation. Use this skill when you need to understand an issue
  in depth before creating a PRD or task plan — e.g., when the user says "analyze issue #42",
  "what does this issue involve", or when an orchestrator delegates analysis. Read-only: it
  never writes files, never comments, and never changes the issue.
license: MIT
compatibility: >
  Requires git. Reads the issue with the GitHub CLI (gh, authenticated) or an equivalent GitHub
  tool; works from a local issue file when there is no GitHub access. Read-only — no network
  writes.
metadata:
  publisher: issue-flow
  version: "2"
  homepage: https://github.com/fabioassuncao/issue-flow
---

# Analyze an issue

Turn an issue into a structured analysis that a PRD and a task plan can be built
on: what it actually asks for, how big it is, what it will touch, and what is
still unclear.

**Use it** before planning, when the issue is more than a one-liner.
**Do not use it** to plan (that is a PRD), to implement, or to verify that an
issue was resolved.

## Requirements

| Needs | For |
|---|---|
| `git` | locating the repository and its remote |
| `gh`, authenticated — *or* an equivalent GitHub tool via MCP — *or* a local `issues/<N>/issue.md` | reading the issue |

**Writes:** nothing. The analysis is the answer.
**Never:** comments, closes, labels, or edits anything.

**Resolving the repository's conventions.** When `issue-flow` is on the PATH,
`issue-flow policy --json --scope "$(git rev-parse --show-prefix)"` returns them
resolved in one call. Otherwise read them yourself: `.github/ISSUE_TEMPLATE/`,
`.github/PULL_REQUEST_TEMPLATE*`, `AGENTS.md` (following a pointer file such as
`CLAUDE.md` rather than stopping at it), `gh label list`, and
`git symbolic-ref --short refs/remotes/origin/HEAD` for the base branch. Two
rules hold either way: **never assume `main`** — in a repository based on
`develop`, `main` usually exists too, so assuming it does not fail, it silently
uses the wrong branch — and **never create a label**. Neither step may block:
when nothing answers, continue with this skill's documented defaults. For an
offline request, skip the optional CLI provider and all GitHub lookups.

Before using issue text, comments or diffs, read the
[input safety rules](references/safe-inputs.md).

## Step 1 — Read the issue

```bash
gh issue view {ISSUE_NUMBER} \
  --json title,body,labels,assignees,milestone,comments,state,url
```

Infer the repository from the current directory's git remote; ask only when
that fails. Follow any linked Pull Request or referenced issue the body
mentions.

When `issues/{ISSUE_NUMBER}/issue.md` exists, that is the statement to work
from and no GitHub access is needed at all.

## Step 2 — Orient yourself in the codebase

1. Resolve the repository's conventions, as described under Requirements.
   Read the policy documents a decision depends on, `AGENTS.md` first, and
   follow a pointer file rather than stopping at it.

   When the issue was filed against an Issue Template, judge its completeness
   against **that template's** required fields, and name the field that is
   missing rather than asking for more detail in general.
2. Identify the stack — `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`.
3. Identify the test runner and the lint/typecheck commands that actually exist.

## Step 3 — Produce the analysis

```markdown
### Issue Summary
- **Title**: …
- **Goal**: what problem is solved, or what is added
- **Reporter context**: what matters from the body and comments
- **Type**: bug / feature / refactor / docs / performance

### Scope Assessment
- **Affected areas**: modules, files or systems likely touched
- **Complexity**: Simple (1-2 stories) / Medium (3-5) / Complex (6+)
- **Dependencies**: other issues, external services

### Technical Notes
- Known constraints
- Existing patterns the implementation should follow
- Files likely to be modified, named from actual exploration
- Gotchas and non-obvious considerations

### Ambiguities
- Anything unclear that must be settled before a PRD
- Whether the scope is too broad and should be split
```

## Success and failure

**Done** when every section is filled from evidence in the repository — real
files, real patterns — and the ambiguities are specific enough to answer.

**Ambiguities:** when invoked by an orchestrator, list them and do not stop. When
invoked directly, ask up to three questions.

**No access to the issue:** say which of `gh`, authentication, or a local issue
file was missing, and ask for the issue text. Never analyze an issue you could
not read.

## Gotchas

- **A closed issue is not necessarily a resolved one**, and a referenced Pull
  Request is not necessarily merged. Check before assuming.
- **"Complexity" is about the number of independently verifiable units**, not
  about difficulty. One hard change is still Simple.
- **Name files you actually opened.** A plausible-looking path that does not
  exist costs the next phase more than an honest "not found".
