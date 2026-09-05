# Pull Request body

**When the repository has a `PULL_REQUEST_TEMPLATE`, it wins.** Keep **every**
heading it defines, in its order. A section that does not apply gets one line
saying why — never delete it: automated review and the repository's own
checklists key off those headings, so a removed section reads as an unanswered
one. When there are several templates under `.github/PULL_REQUEST_TEMPLATE/`,
pick the one matching this change and say in the body which one you picked; if
none clearly fits, ask rather than guess.

**The structure below is the default for a repository with no template.**

```markdown
## Summary

[1-3 sentences: what this PR does and why. Derived from the issue description or the PRD goals.]

## Changes

[Grouped commits or changes, from `git log <base>..HEAD --oneline --no-merges`.]

- commit message 1
- commit message 2

## Files Changed

[Summary from `git diff <base>...HEAD --stat`.]

## User Stories Implemented

[Only when a task plan exists.]

- [x] US-001: [title] — passing
- [x] US-002: [title] — passing
- [ ] US-003: [title] — not passing

## Test plan

[How a reviewer verifies this. Commands run and their result, plus anything that still needs a human.]

## Review Checklist

- [ ] Code follows project conventions
- [ ] Changes are focused and minimal
- [ ] No sensitive data committed
- [ ] Quality checks pass (lint, typecheck, tests)

---

Closes #N
```

## Graceful degradation

| Missing | Effect |
|---|---|
| Issue data | drop the reference line, derive the summary from the commits |
| Task plan | drop "User Stories Implemented" |
| No user stories | drop "User Stories Implemented" |

**Always present:** Summary, Changes, Files Changed, Test plan, Review Checklist.

## The reference line

Put it in the body as **plain text**, on its own line, with no code fence and no
quoting — GitHub only auto-closes an issue when the line is plain body text.

| Situation | Line |
|---|---|
| Every story passing and no outstanding review findings | `Closes #N` |
| Partial delivery | `Refs #N` |
| The issue has no GitHub counterpart (local issue) | no `Closes #`; cite the issue file path instead |

Never invent a `Closes #` for an issue that does not exist on GitHub.

## Title

See `references/git-conventions.md`. Max 70 characters, no trailing
punctuation. When there is no issue number, drop the reference prefix and write
a descriptive title derived from the commits.
