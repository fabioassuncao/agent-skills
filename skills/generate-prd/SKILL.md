---
name: generate-prd
description: >
  Generate a structured Product Requirements Document (PRD) from an issue, producing
  issues/{ISSUE_NUMBER}/prd.md with ordered user stories, verifiable acceptance criteria and
  functional requirements. Use this skill to plan the implementation of an issue before any
  code is written, or when an orchestrator delegates PRD generation. Triggers on: "generate
  prd", "create a plan for this issue", "write requirements", or any request to produce a
  structured implementation plan from an issue. Do NOT use it to implement (use execute-tasks)
  or to convert an existing PRD into a task plan (use convert-prd-to-json).
license: MIT
compatibility: >
  Requires a writable working directory. Works with a GitHub issue (gh) or a local issue file,
  and needs neither network nor GitHub access once the issue text is available.
metadata:
  publisher: issue-flow
  version: "1"
  homepage: https://github.com/fabioassuncao/issue-flow
---

# Generate a PRD

Turn an issue into a plan whose every unit of work is small, ordered and
verifiable. The PRD is what the task plan is derived from, so a vague criterion
here becomes an unverifiable story later.

**Use it** to plan an issue before writing code.
**Do not use it** to implement, to convert a PRD into JSON, or to review.

## Requirements

| Needs | For |
|---|---|
| a writable working directory | `issues/{ISSUE_NUMBER}/prd.md` |
| the issue text — from `gh issue view`, `issues/{N}/issue.md`, or the user | the source of the requirements |

**Writes:** `issues/{ISSUE_NUMBER}/prd.md` only.
**Never:** touches source code, commits, or the issue itself.

**Resolving the repository's conventions.** When `issue-flow` is on the PATH,
`issue-flow policy --json --scope "$(git rev-parse --show-prefix)"` returns them
resolved in one call. Otherwise read them yourself: `.github/ISSUE_TEMPLATE/`,
`.github/PULL_REQUEST_TEMPLATE*`, `AGENTS.md` (following a pointer file such as
`CLAUDE.md` rather than stopping at it), `gh label list`, and
`git symbolic-ref --short refs/remotes/origin/HEAD` for the base branch. Two
rules hold either way: **never assume `main`** — in a repository based on
`develop`, `main` usually exists too, so assuming it does not fail, it silently
uses the wrong branch — and **never create a label**. Neither step may block:
when nothing answers, continue with this skill's documented defaults.

## Step 1 — Ask, only when the issue is ambiguous

Ask only about ambiguities the issue actually has. Guessing a goal is more
expensive than one question; asking about something the issue already answers is
friction for nothing.

Worth asking about: the problem being solved, the key behaviours, what is
explicitly out of scope, how anyone will know it is done.

Make answering cheap:

```text
Before I write the plan, I need to clarify a few things:

1. What is the primary goal of this change?
   A. [option drawn from the issue]
   B. [option drawn from the issue]
   C. Other: [please specify]

2. What should the scope be?
   A. Minimal viable implementation
   B. Full-featured, as described in the issue
   C. Backend only
   D. UI only
```

Short codes like "1A, 2B" are a valid answer.

When an orchestrator invoked this skill, do not stop: record the ambiguity in
**Open Questions** and continue.

## Step 2 — Write the PRD

Follow [references/prd-structure.md](references/prd-structure.md) for the
sections, the story format, the sizing rules and the ordering rules. Read it now
— it is the substance of this skill.

Two rules are worth repeating here, because they are the ones most often broken:

- **A story must fit in one focused session** and be independently verifiable.
  If you cannot describe it in 2-3 sentences, split it.
- **Acceptance criteria must be verifiable.** "Works correctly" is not a
  criterion; "returns 404 when the resource does not exist" is.

## Step 3 — Save

```bash
mkdir -p issues/{ISSUE_NUMBER}
```

Write to `issues/{ISSUE_NUMBER}/prd.md`.

## Success and failure

**Done** when the checklist at the end of
[references/prd-structure.md](references/prd-structure.md) passes and the file
is on disk.

**Do not start implementing.** Producing the plan is the whole job.

**Cannot write the file:** say where and why, and print the PRD so nothing is
lost.

## Gotchas

- **Out of Scope is not optional.** It is the section that keeps the
  implementation from growing, and it is the one most often left empty.
- **Do not renumber someone else's stories.** When a plan already exists for
  this issue, continue its numbering rather than restarting at `US-001`.
- **The issue's own acceptance criteria come first.** Add to them; never quietly
  replace them with your own.
