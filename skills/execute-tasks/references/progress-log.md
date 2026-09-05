# Progress log

`issues/{ISSUE_NUMBER}/progress.txt` is what the *next* iteration reads before
it starts. It exists so that hard-won knowledge survives a context window.

**Always append. Never replace.**

## Header, written once

```text
# Progress Log — Issue #{ISSUE_NUMBER}

## Codebase Patterns
[filled in as patterns are discovered]

---
```

## One entry per iteration

```text
## [ISO datetime] - [Story ID]: [Story Title]

### What was implemented
[Brief description of the change]

### Files changed
- path/to/file.ts — [what changed]
- path/to/another.ts — [what changed]

### Learnings for future iterations
- [Pattern discovered, e.g. "this codebase uses X for Y"]
- [Gotcha, e.g. "must update Z when changing W"]
- [Useful context, e.g. "the evaluation panel lives in component X"]

---
```

The learnings block is required only when the iteration actually discovered
something reusable. **Do not invent patterns** to fill it.

## Codebase Patterns

When an iteration finds a pattern that future iterations should know, add one
line to the `## Codebase Patterns` section at the **top** of the file:

```text
## Codebase Patterns
- Aggregations use the `sql<number>` template
- Migrations always use `IF NOT EXISTS`
- Types for UI components are exported from `actions.ts`
```

Only general, reusable patterns belong here — never story-specific detail.

Read this section **before** starting an iteration. It is the whole point of the
file.

## Recording a blocker

When an iteration cannot finish:

1. write what was tried in the entry above;
2. put a short explanation in the story's `notes`;
3. record the failure in the plan's top-level `lastError` with a timestamp and a
   short category, and **leave it there** while blocked;
4. ask the user for guidance rather than guessing.
