---
name: convert-prd-to-json
description: >
  Convert a PRD markdown file (issues/{N}/prd.md) into a structured JSON task plan
  (issues/{N}/tasks.json) that an autonomous execution loop can work through story by story.
  Splits oversized stories, validates dependency order, and initialises execution state. Use
  this skill when a PRD exists and needs to become a machine-readable plan, or when an
  orchestrator delegates task-plan creation. Triggers on: "convert prd to json", "create a task
  plan from the prd", "turn the PRD into tasks". Do NOT use it to write the PRD itself (use
  generate-prd) or to implement the stories (use execute-tasks).
license: MIT
compatibility: >
  Requires git, a writable working directory and an existing PRD. Needs no network and no GitHub
  access. Archives a previous plan rather than deleting it.
metadata:
  publisher: issue-flow
  version: "2"
  homepage: https://github.com/fabioassuncao/issue-flow
---

# Convert a PRD into a task plan

Read `issues/{ISSUE_NUMBER}/prd.md` and write
`issues/{ISSUE_NUMBER}/tasks.json` — the plan an execution loop works through
one story at a time.

**Use it** when a PRD exists and implementation is next.
**Do not use it** to write the PRD, or to implement.

## Requirements

| Needs | For |
|---|---|
| `issues/{ISSUE_NUMBER}/prd.md` | the source of the stories |
| a writable working directory | the plan and its archive |
| `git` | reading the current branch |

**Writes:** `issues/{ISSUE_NUMBER}/tasks.json`, and
`issues/{ISSUE_NUMBER}/archive/` when an unrelated plan was already there.
**Never deletes anything.** A previous plan and its progress log are moved, not
removed.

Optional: when the Issue Flow CLI is on the PATH, `issue-flow conventions branch
--issue N` resolves the branch name deterministically — see
[references/git-conventions.md](references/git-conventions.md). Without it, read
the repository's own convention from `AGENTS.md` and the documents it points at,
and fall back to the defaults in that reference. **Never assume `main`** as the
base: in a repository based on `develop`, `main` usually exists too, so assuming
it does not fail — it silently records the wrong branch.

## Step 1 — Archive an unrelated plan

A `tasks.json` may already exist for a **different** feature. Compare its
`branchName` with the branch in play.

When they differ, preserve every existing plan and progress log, even if the
log is empty. Create a fresh, uniquely named directory under
`issues/{ISSUE_NUMBER}/archive/` and move the files there. Resolve collisions
before moving, and stop on any move failure. Never reuse an archive filename,
ignore a move error, or overwrite the existing plan before the archive succeeds.

When the `branchName` matches, preserve IDs, passing stories, notes and progress.
Reconcile only requested PRD changes; this is not permission to reset execution
state. Verify and report the existing plan when no conversion is needed.

## Step 2 — Convert

[references/tasks-schema.md](references/tasks-schema.md) is the contract: the
shape, every field rule, the pipeline flags, the story-splitting rules and the
ordering rules. Read it now.

The branch name is not yours to invent — see
[references/git-conventions.md](references/git-conventions.md), and the
repository's own convention when it declares one (Requirements, above).

### Worked example

PRD:

```markdown
### US-001: Add status field to tasks table
**Description:** As a developer, I need to store task status in the database.
**Acceptance Criteria:**
- [ ] Add status column: 'pending' | 'in_progress' | 'done' (default 'pending')
- [ ] Generate and run migration successfully
- [ ] Typecheck passes
```

Plan entry:

```json
{
  "id": "US-001",
  "title": "Add status field to tasks table",
  "description": "As a developer, I need to store task status in the database.",
  "acceptanceCriteria": [
    "Add status column: 'pending' | 'in_progress' | 'done' (default 'pending')",
    "Generate and run migration successfully",
    "Typecheck passes"
  ],
  "priority": 1,
  "passes": false,
  "notes": ""
}
```

## Step 3 — Verify and report

Run the checklist at the end of
[references/tasks-schema.md](references/tasks-schema.md), then confirm the file
parses:

```bash
node -e "JSON.parse(require('fs').readFileSync('issues/{ISSUE_NUMBER}/tasks.json','utf8'))" \
  && echo "valid JSON"
```

Use `python3 -m json.tool` instead when Node is not around, and say so if
neither is — an unvalidated plan is worth flagging.

Then report:

```text
Task plan created: issues/{ISSUE_NUMBER}/tasks.json

{N} user stories:
  US-001 (priority 1): [title]
  US-002 (priority 2): [title]

Stories needing browser verification: US-002, US-003
Estimated complexity: Medium
```

## Success and failure

**Done** when the file exists, parses, and every checklist item holds.

**Handing off:** when an orchestrator invoked this skill, stop at the report and
return control — the decision about whether to start implementing is the
orchestrator's, and taking it here bypasses its confirmation gate. When invoked
directly, present the plan and ask whether to proceed to implementation.

**No PRD:** say which path was missing and offer to generate one, rather than
inventing stories from the issue title.

## Gotchas

- **Never restart numbering at `US-001`** when a starting number was given or a
  previous plan exists for this project — a duplicate ID silently merges two
  different pieces of work in every report that follows.
- **`lastReviewFindings` is not a story.** Non-null means execution is
  unfinished even when every story passes.
- **Do not invent `analyzeCompleted` or `prReviewCompleted` as `false`.** Their
  absence means "never requested"; adding them as `false` makes a resumable
  pipeline re-enter a phase nobody asked for.
