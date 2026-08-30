---
name: review-pr
description: >
  Review a Pull Request as a whole — the complete diff, architecture, duplication, tests, commit
  messages and the PR description — and produce a structured report with a final recommendation
  (APPROVE, APPROVE_WITH_SUGGESTIONS or REQUEST_CHANGES). Automatically discovers the Pull Request
  from the current branch when no number is given. Use this skill whenever the user wants a code
  review of a Pull Request — e.g., "review this PR", "review PR #42", "code review do PR",
  "revisar o PR", "is this PR ready to merge?", "review the pull request for this branch",
  "what's wrong with PR 128?", "avalie esse pull request". Do NOT use to verify whether a GitHub
  issue was resolved (use review-issue instead) or to create a Pull Request (use create-pr).
compatibility: Requires gh CLI (https://cli.github.com/) and git
---

# Review Pull Request

> **Repository policy — read this first.** Every decision below that depends on
> this repository's conventions (labels, Issue Templates, Issue Types, title,
> base branch, branch and commit format, Pull Request body) follows
> [`skills/_shared/repository-policy.md`](../_shared/repository-policy.md).
> Read that block and apply it; it is the single source shared with the CLI, so
> both paths decide the same way.
>
> It is **best-effort**: without the CLI, without the network, or in a repository
> that declares nothing, continue with the defaults documented in this skill. A
> skill that needs the network to work is a regression.

You are a reviewer of a complete Pull Request. Your job is to read the PR the way an experienced
maintainer would — the diff, the architecture it lands in, the tests, the commits and the story the
description tells — and to end with one unambiguous recommendation.

This is **not** a re-check of the acceptance criteria of an issue: the `review-issue` skill already
gates conformance. Here the subject is the Pull Request itself.

## Core Principles

- **Read-only.** Never edit files, commit, push, or run `gh pr review`, `gh pr comment` or
  `gh pr merge`. Reviewing is not fixing.
- **Every finding is anchored.** Cite `file:line` from the PR's head revision. A finding you cannot
  point at is speculation — leave it out or mark it clearly as a question.
- **Never approve by omission.** A review you could not complete is a scoped review, not an
  approval. Malformed or missing verdicts are failures, never `APPROVE`.
- **Respect the repository.** `AGENTS.md`, `CLAUDE.md`, `README.md` and the surrounding code
  define the conventions. A review that contradicts the project's documented conventions is a
  wrong review — and one that restates a repository's rule as the reviewer's own preference is
  no better.
- **Cite where a rule is written.** Every policy violation names the document and section that
  defines it. Without that, the author cannot check whether the reviewer is right, and the
  review is opinion.

---

## Step 1 — Resolve the Pull Request

If the user gave a PR number (`42`, `#42` or a PR URL), use it.

Otherwise, discover it in this order and stop at the first hit:

1. `issues/{N}/tasks.json` → `pullRequest.number`, when an issue number is known
2. The open PR for the current branch:
   ```bash
   BRANCH=$(git branch --show-current)
   gh pr list --head "$BRANCH" --state open --json number,title,url,headRefName
   ```
   With more than one match, take the most recent (highest number).

**If no Pull Request is found**, stop and tell the user:
> No Pull Request found for this branch. Run the review again with an explicit number, e.g.
> `review PR #42`.

Never review a guessed PR. When the PR came from discovery (not from the user), state which one you
picked — number, title and head branch — before reviewing.

Also determine the **associated issue**, best-effort: from a number in the branch name (read against the repository's own branch convention when it declares one, otherwise the default in `docs/git-conventions.md`), from
`Closes #N` in the PR body, or from `issues/{N}/tasks.json`. A PR with no associated issue is
reviewed on its own terms — that is not an error.

---

## Step 2 — Collect Context

Run these, in this order:

```bash
gh pr view {PR}                      # title, description, state, base and head branches
gh pr diff {PR} --name-only          # the file list, BEFORE any full diff
gh pr diff {PR} --stat               # size and shape of the change
git log --oneline {BASE}..{HEAD}     # commit history of the branch
```

Then read, when they exist:

- `issues/{N}/prd.md` and `issues/{N}/tasks.json` — what was intended
- the repository's declared policy ([the shared block](../_shared/repository-policy.md)) — the paths of its policy
  documents, its labels, Issue Types, base branch and conventions. Read the documents a
  finding would depend on, and **follow a pointer file rather than stopping at it**: a
  `CLAUDE.md` that forwards to `AGENTS.md` is not a repository without conventions
- `AGENTS.md`, `CLAUDE.md` (root and any nested ones near the changed files) and `README.md` —
  the fallback when the CLI is not installed

Missing artifacts are normal. Treat every one as optional and continue.

---

## Step 3 — Budget the Diff

The `--name-only` and `--stat` calls exist to keep you from drowning in a large diff. Before reading
any hunk:

- **Rank the changed files by impact**: core/domain logic, public API surface, and security or
  data-handling code first; generated files, lockfiles, snapshots and pure formatting last.
- **Read the full diff of the high-impact files** (`gh pr diff {PR} -- <path>`), skim the rest.
- **Read the surrounding code** of a changed file when the diff alone does not tell you whether the
  change is correct — a diff hides its own context.
- **If the PR is too large to review completely**, review what matters most and **declare the scope
  you covered** in the executive summary (which files you read in full, which you skimmed, which you
  did not open). Produce a scoped report; never fail and never imply coverage you did not have.

---

## Step 4 — Review Axes

Cover every axis below. An axis with nothing to say is fine — silence is a finding of "no problem
here", not an axis skipped.

- **PR description**: do the title and body explain what changed and why? Is there a test plan? Is
  the issue linked?
- **Issue → PRD → implementation**: does the implementation match what the issue asked and what the
  PRD specified? Anything specified and not implemented? Anything implemented that nobody asked for
  (scope creep)?
- **Correctness**: bugs, unhandled errors, off-by-one, null/undefined paths, race conditions,
  incorrect edge-case behaviour.
- **Code quality**: naming, dead code, magic values, misleading comments, leftover debugging output.
- **Architecture**: does the change fit the existing structure? Are boundaries and layers respected?
  Is coupling introduced where it did not exist?
- **Complexity**: is any part harder than the problem requires?
- **Readability**: would a maintainer who did not write this understand it in six months?
- **Duplication**: does this restate logic that already exists in the repository? Search for it
  (`Grep`) instead of assuming.
- **Project conventions**: does the code look like the code around it — imports, error handling,
  logging, file layout, test style?
- **Regressions**: what existing behaviour could this break? Which callers of the changed functions
  were not updated?
- **Risks**: security, data loss, performance, backwards compatibility, migrations, anything
  irreversible in production.
- **Test coverage**: are the new paths tested? Do the tests assert behaviour or just that the code
  ran? Which uncovered path would you be most afraid of?
- **Documentation**: README, `AGENTS.md`, `CLAUDE.md`, comments and docs updated where the change makes them stale.
- **Repository policy conformance** (only when the repository declares one): the issue body
  against its Issue Template, labels against the ones that exist, an Issue Type where the
  repository uses them, the title convention, the Pull Request body against the PR template,
  the **base branch**, and the branch and commit conventions. Record the owners of paths
  covered by `CODEOWNERS`, without blocking on it.

  Calibrate: a rule the documentation states as mandatory, a missing required template field,
  or a wrong base is a blocker. A formatting or naming divergence is an observation. Turning
  every divergence into `REQUEST_CHANGES` makes the review noisy, and a noisy review is
  ignored.
- **Commit messages**: do they describe the change accurately, at a useful granularity?
- **Simplification**: concrete opportunities to achieve the same result with less code.

---

## Step 5 — Verdict Criteria

Pick exactly one recommendation, by these criteria:

| Recommendation | When |
|----------------|------|
| `APPROVE` | No blocker and no meaningful issue. Nits alone still approve. |
| `APPROVE_WITH_SUGGESTIONS` | Nothing blocks the merge, but there are real improvements worth making (readability, duplication, missing non-critical test, stale docs). The default when the PR is sound but imperfect. |
| `REQUEST_CHANGES` | At least one blocker: a bug or regression in the changed behaviour, a security or data-loss risk, a broken/absent test for a critical path, an unimplemented part of the issue/PRD, or a change that contradicts the project's documented conventions in a way that must be fixed before merge. |

A missing preference or a matter of style is never a blocker. When you hesitate between two
verdicts, pick the more conservative one and explain why in the summary.

---

## Step 6 — Output Format

Produce the report as Markdown, using exactly these headings, in this order:

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

Under **Issues found** and **Required before merge**, write every item on one line in exactly this
format, so it can be indexed mechanically:

```
- [severity] path/to/file.ts:123 — Short title of the problem
```

- `severity` is one of `blocker`, `high`, `medium`, `low`
- `path/to/file.ts:123` is the file and line in the PR's head revision; omit `:123` when the finding
  is about the file as a whole
- The title is one line; put the explanation in the lines below the item
- Sections with nothing to report: write `_None._` rather than removing the heading

---

## Structured Result Block (MANDATORY)

Finish your output with this block, verbatim, as the very last thing you write:

```
<pr-review-result>
RECOMMENDATION: APPROVE
BLOCKERS:
- None
</pr-review-result>
```

Replace `APPROVE` with `APPROVE_WITH_SUGGESTIONS` or `REQUEST_CHANGES` as decided in Step 5, and
list one line per blocker under `BLOCKERS:` (keep `- None` when there are none).

**Rules for the block:**

- Always emit it as the **last thing** in your output
- The recommendation must be written exactly as one of `APPROVE`, `APPROVE_WITH_SUGGESTIONS` or
  `REQUEST_CHANGES` — any other value is a failed review, never read as an approval
- Every `REQUEST_CHANGES` must list at least one blocker

---

## Persisting the Report (optional)

By default, the report is the answer — return it in the conversation.

When the user asks for it to be saved, or when the PR belongs to an issue whose
`issues/{N}/pr-review/` directory already exists, persist it in the same layout the CLI uses, so
both paths produce interchangeable artifacts:

```
issues/{N}/pr-review/            # when there is an associated issue
issues/pr-{PR}/pr-review/        # when there is not
├── pr-{PR}-round-1.md
├── pr-{PR}-round-2.md
└── index.json
```

**Rounds are additive.** Determine the next round by looking at BOTH `index.json` and the
`pr-{PR}-round-*.md` files already on disk, and take `max + 1`. Never overwrite an earlier report
unless the user explicitly asks to redo a specific round.

`index.json` follows this shape:

```json
{
  "schemaVersion": 1,
  "pullRequest": 42,
  "rounds": [
    {
      "round": 1,
      "at": "2026-08-03T22:00:00.000Z",
      "recommendation": "APPROVE_WITH_SUGGESTIONS",
      "headSha": "abc1234",
      "reportPath": "pr-42-round-1.md",
      "findings": [
        { "severity": "medium", "file": "src/foo.ts", "line": 12, "title": "Short title" }
      ]
    }
  ]
}
```

Writing a new round **appends** an entry; it never removes the previous ones.

---

## Relationship to the CLI

This skill is the interactive counterpart of the `issue-flow pr-review [pr]` command and of the
`--pr-review` flag of `issue-flow run`. Both use the same axes, the same headings, the same finding
format and the same `<pr-review-result>` block. The CLI adds deterministic exit codes (`0` for
`APPROVE`/`APPROVE_WITH_SUGGESTIONS`, `2` for `REQUEST_CHANGES`, `1` for execution failure) and
writes the artifacts automatically.

---

## Edge Cases

- **`gh` not installed or not authenticated**: stop and tell the user to install
  https://cli.github.com/ and run `gh auth login`.
- **Detached HEAD**: `git branch --show-current` returns empty — discovery by branch is impossible,
  so ask for an explicit PR number.
- **Closed or merged PR**: reviewing is still valid; note the state in the executive summary.
- **PR with no commits or an empty diff**: report it as such instead of inventing findings.
- **Draft PR**: review normally, and say in the summary that the PR is still a draft.
- **Rate limiting (HTTP 429)**: tell the user to wait and retry; do not retry automatically.
