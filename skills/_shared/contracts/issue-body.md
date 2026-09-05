# Issue body structure

**When the repository has an Issue Template or Issue Form, it wins.** Pick the
one that fits the request by its name and description, and write the body to
*its* structure, filling every field it marks as required. Do not stack the
sections below on top of it: a repository whose quick-capture form has one
required field does not want a twelve-section architectural document, and
forcing one turns a two-minute idea into a chore.

If two templates fit equally well, ask the user which one. Choosing the kind of
issue is the author's call, not the generator's.

**The structure below is the default for a repository with no template.** Every
section must be present and substantive — no placeholders, no one-liners.

```markdown
## Context and Motivation

[Why does this matter? What business or technical need drives this?]

## Current State Diagnosis

[What exists today? How does the current implementation work? Be specific — reference files, patterns, and architecture.]

## Identified Problems

[Concrete problems with the current state. Use a numbered or bulleted list.]

## Objectives

[What should be true when this is done? Clear, measurable goals.]

## Proposed Solution

[The recommended approach. Be specific about what to change, where, and how. Reference actual files/modules when possible.]

## Alternatives Considered

[At least one alternative approach and why it was not chosen.]

## Pros and Cons

### Pros
[Benefits of the proposed solution]

### Cons
[Tradeoffs, costs, or downsides]

## Execution Plan

[Step-by-step implementation plan. Order matters — list dependencies between steps. Use checkboxes.]

- [ ] Step 1
- [ ] Step 2
- [ ] ...

## Risks and Precautions

[What could go wrong? Migration risks, breaking changes, performance concerns, data loss scenarios.]

## Acceptance Criteria

[How do we know this is done? Specific, testable criteria.]

- [ ] Criterion 1
- [ ] Criterion 2

## Expected Outcome

[Paint the picture of success. What does the system look like after this is complete?]

## Related Issues / Notes

[Links to related issues, PRs, or external references. Use `#number` for cross-references. If none, say "None."]
```

## Rules

- **Language.** The headings above are templates. Write them, and the whole body,
  in the human language chosen for the issue — matching the repository's existing
  issues. A backlog written in two languages is harder to search than one written
  in the "wrong" one.
- **Quality bar.** The issue must be detailed enough that an experienced
  developer, or an agent, can start immediately without asking questions.
  Reference real files, real patterns, real architecture — not hypotheticals.
- **File references.** Use paths relative to the repository root
  (`src/auth/middleware.ts`), and verify the file exists before naming it.

## Title

Check the repository's own convention first (see
`references/repository-conventions.md`):

- **A declared title convention** — follow it, and ignore the default below.
- **The repository has Issue Types** — write the title with **no textual
  prefix**. It removed `[Bug]`/`[Enhancement]` precisely because that
  information moved into a structured field; reintroducing it is a regression.
- **Neither** — use the default below.

Default format:

```text
[<Type>] <concise description>
```

- Prefix is one of `[Bug]`, `[Refactor]`, `[Enhancement]`, `[Investigation]`,
  `[Architecture]`
- Max 80 characters total, including the prefix
- No trailing punctuation, no redundant words ("Implement implementation of…")

Examples:

- `[Bug] Login fails silently when session token expires`
- `[Refactor] Extract payment processing into dedicated service`
- `[Enhancement] Add bulk export for user analytics`
- `[Investigation] Intermittent 502 errors on /api/webhooks`
- `[Architecture] Migrate queue system from Redis to SQS`
