---
name: execute-tasks
description: >
  Iteratively implement the user stories in issues/{N}/tasks.json — one story per iteration,
  running the project's quality checks, committing, and updating the plan and the progress log
  before moving on. Use this skill when a JSON task plan exists and the stories need to be
  built autonomously, or when an orchestrator delegates implementation. Triggers on: "execute
  tasks", "implement the stories", "start coding the plan", "continue the task plan". Do NOT
  use it to create the plan (use convert-prd-to-json) or to review the result (use
  review-issue).
license: MIT
compatibility: >
  Requires git and the project's own toolchain (test runner, linter, typechecker). Writes code
  and creates commits on the current branch. Never pushes and never force-pushes.
metadata:
  publisher: issue-flow
  version: "1"
  homepage: https://github.com/fabioassuncao/issue-flow
---

# Execute a task plan

Work through `issues/{ISSUE_NUMBER}/tasks.json` one story at a time. Implement,
check, commit, record — then repeat. Every iteration leaves the repository in a
state someone else could pick up.

**Use it** when a task plan exists and the code has to be written.
**Do not use it** to plan, or to decide whether the issue is resolved.

## Requirements

| Needs | For |
|---|---|
| `git`, on the branch the plan names | committing each story |
| `issues/{ISSUE_NUMBER}/tasks.json` | the stories and their acceptance criteria |
| the project's own toolchain | typecheck, lint, tests |

**Writes:** source code, commits on the current branch,
`issues/{ISSUE_NUMBER}/tasks.json`, `issues/{ISSUE_NUMBER}/progress.txt`, and
`AGENTS.md` files when a reusable pattern is worth recording.
**Never:** pushes, force-pushes, rebases, or commits when a check is failing.

Optional: when the Issue Flow CLI is on the PATH, `issue-flow policy --json`
returns the repository's conventions — including its commit convention —
resolved in one call. Without it, read them from `AGENTS.md` and the documents it
points at. Neither path may block: when nothing answers, follow the defaults in
[references/git-conventions.md](references/git-conventions.md).

## Before each iteration

1. **Read the plan** — `issues/{ISSUE_NUMBER}/tasks.json`. Check `issueStatus`,
   `completedAt`, `lastAttemptAt`, `lastError` and `lastReviewFindings`.
   [references/tasks-schema.md](references/tasks-schema.md) is the contract.
2. **Read the progress log** — `issues/{ISSUE_NUMBER}/progress.txt`, its
   `## Codebase Patterns` section first. Those are hard-won learnings from
   earlier iterations; re-deriving them wastes the iteration.
   See [references/progress-log.md](references/progress-log.md).
3. **Read the project's instructions** — `AGENTS.md` at the repository root and
   at every level down to the directory you are about to change; the nearest one
   wins. **Follow a pointer file rather than stopping at it**: a `CLAUDE.md`,
   `.cursorrules` or similar whose whole content forwards to `AGENTS.md` is not
   a repository without conventions.
4. **Confirm the branch** — `git branch --show-current` must match `branchName`.
   If it does not, check it out. When it does not exist, create it following
   [references/git-conventions.md](references/git-conventions.md).

## The iteration

### 1. Pick the work

**`lastReviewFindings` is non-null?** That is the priority, ahead of any pending
story. It describes concrete defects in code already marked `passes: true` — it
is not a new story. Make the smallest correct change that addresses every
finding. Do not re-implement a story from scratch.

Otherwise: the **highest priority** story with `"passes": false`. Priority 1
before priority 2.

### 2. Understand it

Read the story's `description` and its `acceptanceCriteria` — those criteria
*are* the definition of done. Explore the codebase enough to know where the
change goes and which existing patterns it should follow.

### 3. Implement

- Follow the patterns already in the codebase; do not invent new conventions.
- Keep the change minimal and focused. Do not refactor unrelated code.
- If the story turns out to be bigger than planned, implement the minimum that
  satisfies every criterion — and say so in the progress log.

### 4. Check

Run the checks that cover the files you touched. Find the real commands in
`package.json` scripts, `Makefile`, `pyproject.toml`, `Cargo.toml`, the CI
workflow, or `AGENTS.md` — never assume a command exists.

Typical shapes: `tsc --noEmit`, `eslint .`, `npm test`, `vitest run`, `pytest`,
`mypy .`, `ruff check .`, `cargo check && cargo clippy && cargo test`.

**A failing check means no commit.** Fix it first.

### 5. Verify in the browser, when the story changes UI

Use whatever browser automation this environment actually offers — a Playwright
CLI, an MCP browser tool, a browser skill. Start the dev server, exercise the
change, confirm it against the acceptance criteria, and record which tool you
used.

No browser tooling available? Say so in the progress log as "manual browser
verification needed". Never record a verification you did not perform.

### 6. Commit

```bash
git add <the files you changed>
git commit -m "feat: US-002 - Display status badge on task cards"
```

**Never `git add -A` or `git add .`** — it is how a `.env`, a credential or an
unrelated change ends up in history. Name the files.

Follow [references/git-conventions.md](references/git-conventions.md), and the
repository's own convention when it declares one.

### 7. Update the plan

In `issues/{ISSUE_NUMBER}/tasks.json`:

- `passes: true` for the finished story
- anything useful in its `notes`
- `issueStatus: "in_progress"` while stories remain
- `lastAttemptAt` to now; clear `lastError` after a clean iteration
- `lastReviewFindings` back to `null` once every finding is addressed — leaving
  it set means the issue is still considered uncorrected. If a finding was a
  false positive or already fixed, still clear it, and say so in the log.

### 8. Record what you learned

Append to `issues/{ISSUE_NUMBER}/progress.txt` — never replace it. Format and
rules in [references/progress-log.md](references/progress-log.md).

When you discovered something genuinely reusable for future work in a directory,
add it to the nearest `AGENTS.md`: module conventions, non-obvious dependencies
between files, testing requirements, configuration gotchas. Not story-specific
detail, not debugging notes, not anything already in the progress log.

## Stop condition

After each story, ask: is **every** story `passes: true` **and**
`lastReviewFindings` `null`?

**Yes** — set `issueStatus: "completed"`, `completedAt` and `lastAttemptAt` to
now, `lastError` to `null`, `pipeline.executionCompleted` to `true`. Then emit
the completion marker from
[references/completion-signal.md](references/completion-signal.md) and summarise:

```text
Issue #{ISSUE_NUMBER} complete — {N} user stories:
  US-001: [title]
  US-002: [title]
```

**No** — loop straight back to picking the next story. Do not end the turn
between stories, and do not ask whether to continue.

## When you cannot finish

1. Record what you tried in the progress log.
2. Explain the blocker in the story's `notes`.
3. Record it in the top-level `lastError` with a timestamp and a short category,
   and leave it there while blocked.
4. Ask the user for guidance. Do not guess your way past it.

If the story turns out to be fundamentally different from what was planned,
stop before making large changes and propose a revised breakdown.

## Gotchas

- **One story per iteration.** Never batch several into one commit: the plan,
  the log and the review all key off the one-story-one-commit shape.
- **Append to the progress log, never overwrite.** It is the only memory the
  next iteration has.
- **Read `## Codebase Patterns` before starting.** It exists so the same mistake
  is not made twice.
- **`lastReviewFindings` outranks a pending story**, even when every story
  already passes.
