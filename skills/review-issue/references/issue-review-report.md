# Issue conformance report

The question this report answers is narrow: **was this issue actually
resolved?** Not "is the code good" — that is a Pull Request review.

Write it in the same human language as the issue.

## Structure

```markdown
# Code Review — Issue #{number}: {title}

## Status: [APPROVED / REJECTED]

## Summary
Brief description of the overall state.

## Requirements Analysis
| Requirement | Status | Notes |
|-------------|--------|-------|
| ... | Met / Unmet / Partial | ... |

## Implementation Review
- Architecture alignment: ...
- Code quality: ...
- Patterns and conventions: ...

## Tests
- Result: {passed}/{total} passing
- Coverage of changes: adequate / insufficient
- Notes: ...

## Regressions
- {None found / list of concerns}

## Issues Found (if any)
- [ ] ...

## Conclusion
{Clear final decision with justification}
```

Finish with the `<review-result>` block — see `references/review-result-block.md`.

## Verdict criteria

The issue is **resolved** only when all of these hold:

- every acceptance criterion from the issue is addressed in the code;
- the tests pass, with no failure related to the changes;
- no regression was introduced;
- the code follows the project's own conventions.

## Repository policy as a review axis

Alongside the acceptance criteria and the regressions, check the change against
what the repository declares (see `references/repository-conventions.md`):

- the branch and the commits against the declared conventions;
- the change against any rule the policy documents state as **mandatory** — read
  those documents, and follow a pointer file rather than stopping at it;
- paths with a `CODEOWNERS` entry: record who owns them, and never fail on it.

**Cite the document and section behind every rule you invoke.** A violation
without a citation is an opinion the author cannot check.

Only a rule the repository states as **mandatory** — or a required template field
left out, or a wrong base branch — belongs in the findings. A formatting or
naming divergence is worth a mention in the body, never a rejection: a review
that fails on style is a review that gets ignored.

Never restate a repository rule as your own standard, and never invent one it
does not declare.

## Principles

- **Never assume resolved because the issue is closed or a PR was merged.**
  Verify it in the code.
- **A finding you cannot point at is speculation.** Cite `file:line`, or leave
  it out, or mark it explicitly as a question.
- **Anchor everything to the acceptance criteria.** Scope creep in a review is
  as costly as scope creep in an implementation.
