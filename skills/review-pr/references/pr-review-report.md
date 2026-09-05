# Pull Request review report

The question this report answers is broader than conformance: **is this Pull
Request, as a whole, good enough to merge?**

Write it in the same human language as the Pull Request.

## Structure

Keep every heading, in this order. A section with nothing to report gets
`_None._` — never delete the heading.

```markdown
## Executive summary
## Strengths
## Issues found
## Suggested improvements
## Architectural observations
## Risks identified
## Required before merge
## Final recommendation
```

Under **Issues found** and **Required before merge**, write every item on one
line, in exactly this format, so a reader — human or machine — can index it:

```text
- [severity] path/to/file.ts:123 — Short title of the problem
```

- `severity` is one of `blocker`, `high`, `medium`, `low`
- `path/to/file.ts:123` is the file and line in the PR's **head** revision; omit
  `:123` when the finding is about the file as a whole
- the title is one line — the explanation goes in the lines below the item

Finish with the `<pr-review-result>` block — see `references/pr-review-result-block.md`.

## Verdict criteria

| Recommendation | When |
|---|---|
| `APPROVE` | nothing blocking; at most trivia |
| `APPROVE_WITH_SUGGESTIONS` | improvements worth making, none of them blocking |
| `REQUEST_CHANGES` | at least one blocker: a defect, a missing test for changed behaviour, a convention the repository states as mandatory, a risk the author has not addressed |

A blocker is something a maintainer would refuse to merge over. Style
preferences are not blockers.

## Anchoring

Every finding cites `file:line` from the **head revision of the Pull Request**.
A finding you cannot point at is speculation — leave it out, or mark it clearly
as a question.

## Read-only

Reviewing is not fixing. Never edit files, commit, push, or run `gh pr review`,
`gh pr comment` or `gh pr merge`. Shell access is for inspection.
