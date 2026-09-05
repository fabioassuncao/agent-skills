---
name: review-issue
description: >
  Verify whether an issue was actually resolved — trace the implementation, map every
  acceptance criterion to real code, run the project's tests, and check for regressions before
  giving a verdict. Use this skill whenever the user wants to validate, verify or review
  whether an issue was properly resolved — "review issue #42", "validate issue 15", "is issue
  #7 done?", "close issue #5 if it's done", "revisar issue", "validar issue". Standalone, it
  closes the issue on approval and comments on rejection. Do NOT use it to analyze an issue
  before implementation (use analyze-issue) or to review a Pull Request as a whole (use
  review-pr).
license: MIT
compatibility: >
  Requires git and the GitHub CLI (gh), authenticated — or an equivalent GitHub tool. Runs the
  project's test suite. Outside orchestrator mode it closes or comments on the issue, so it
  writes to GitHub.
metadata:
  publisher: issue-flow
  version: "1"
  homepage: https://github.com/fabioassuncao/issue-flow
---

# Review whether an issue was resolved

Closing an issue should mean the problem is solved — not that someone pushed
code and moved on. This is the gate: fetch the requirements, trace them through
the code, run the tests, and only then decide.

**Use it** to decide whether an issue can be closed.
**Do not use it** to plan, to implement, or to review a Pull Request as a whole
— that is a different question, and `review-pr` answers it.

## Requirements

| Needs | For |
|---|---|
| `git` | tracing the implementation |
| `gh`, authenticated — or an equivalent GitHub tool via MCP | reading the issue; closing or commenting |
| the project's test runner | running the suite |

**Writes:** nothing in the repository. Outside orchestrator mode it **closes the
issue** on approval, or **comments** on it on rejection.
**Never:** edits code, commits, or fixes what it finds. Reviewing is not fixing.

## Step 1 — Fetch the issue

```bash
gh issue view {ISSUE_NUMBER} \
  --json title,body,labels,assignees,milestone,comments,state,url
```

The comments matter as much as the body: a decision taken in a comment is part
of the requirements. Note any linked Pull Request.

## Step 2 — Learn how this project works

Identify the stack from what is actually there — `package.json`,
`composer.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `Gemfile`,
`pom.xml`/`build.gradle`, `mix.exs`, `Makefile`, `pubspec.yaml`.

Then check what changes *how* commands run: `docker-compose.yml` or a
`Dockerfile` (a container prefix), `.tool-versions`/`.nvmrc`/`.python-version`,
and the CI config (`.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`) — CI
is the most reliable statement of how this project is really tested.

Resolve the repository's conventions —
[references/repository-conventions.md](references/repository-conventions.md) —
and read the policy documents a finding would depend on. **Follow a pointer file
rather than stopping at it.**

Come out of this step knowing: the language and framework, how to run the tests
(with any container prefix), how to run lint and typecheck, and where tests
live.

## Step 3 — Trace the implementation

Not every project links its work the same way, so try several:

```bash
gh pr diff {PR_NUMBER}                    # from a linked PR
gh pr view {PR_NUMBER} --json commits
git branch -a | grep -i "{ISSUE_NUMBER}"  # from branch naming
git log --all --oneline --grep="#{ISSUE_NUMBER}" --since="6 months ago"
```

From the current branch, compare against the **resolved** base branch — never
assume `main`:

```bash
BASE=${BASE:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')}
BASE=${BASE:-main}
git log "$BASE"..HEAD --oneline
git diff "$BASE"...HEAD --stat
```

In a repository based on `develop`, `main` usually exists too — hard-coding it
does not fail, it silently reviews the wrong diff.

Then **read every changed file**, not just the diff. A change is only correct in
context.

## Step 4 — Map criteria to code

For each acceptance criterion: is there code that implements it? For each edge
case the issue names: is it handled? For each decision taken in a comment: does
the code reflect it?

Then: does the implementation match the project's architecture and patterns
(check sibling files)? Is there duplicated logic that should be shared? Was
unnecessary coupling introduced?

**Be fair.** If the issue did not ask for something, its absence is not a
failure. Flag only what contradicts the requirements or violates a convention
the repository actually states.

## Step 5 — Run the tests

Use the command this project really uses — found in Step 2, not assumed. Prefer
the tests covering the changed areas; the full suite is fine when the project is
small or the change is wide.

Record how many passed and failed, whether any failure relates to *this* change,
and whether the changed behaviour is covered at all.

Missing tests for changed behaviour is a finding. **Do not write them** — this
is a review.

## Step 6 — Look for regressions

Beyond the suite: did the change touch shared utilities, base classes, or
configuration? Grep for usages of every modified function, class or constant.
Could it affect a database schema, an API contract, or a public interface?

## Step 7 — Decide, report, act

Verdict criteria and report structure:
[references/issue-review-report.md](references/issue-review-report.md).
End with the `<review-result>` block from
[references/review-result-block.md](references/review-result-block.md).

**Orchestrator mode** — when the invocation contains `--orchestrator`: produce
the report and the block, and **stop**. Do not close the issue, do not comment.
Those are the orchestrator's decisions.

**Standalone** — resolved:

```bash
gh issue close {ISSUE_NUMBER} --comment "{summary of what was validated}"
```

Confirm before closing, unless the user already said to just do it. Closing is
visible to everyone watching the issue and is not yours to undo silently. The
comment goes in the issue's language and states what was validated, that the
tests pass, and that no regression was found.

**Standalone** — not resolved: do **not** close. Comment with what is missing:

```bash
gh issue comment {ISSUE_NUMBER} --body "{what needs attention}"
```

## Gotchas

- **A closed issue, or a merged PR, proves nothing.** Verify it in the code.
- **A finding you cannot point at is speculation.** Cite `file:line`, or leave
  it out, or mark it as a question.
- **The project's own rules win** over generic best practice — `AGENTS.md`, CI
  config, existing conventions.
- **Style is not a failure.** A naming or formatting divergence belongs in the
  body of the report, never in the verdict: a review that fails on style is a
  review that gets ignored.
