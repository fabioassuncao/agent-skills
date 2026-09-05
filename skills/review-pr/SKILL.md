---
name: review-pr
description: >
  Review a Pull Request as a whole — the full diff, architecture, duplication, tests, commit
  messages and the description — and end with one unambiguous recommendation (APPROVE,
  APPROVE_WITH_SUGGESTIONS or REQUEST_CHANGES). Discovers the Pull Request from the current
  branch when no number is given. Use this skill whenever the user wants a code review of a
  Pull Request — "review this PR", "review PR #42", "code review do PR", "revisar o PR", "is
  this PR ready to merge?", "avalie esse pull request". Read-only. Do NOT use it to verify that
  an issue was resolved (use review-issue) or to create a Pull Request (use create-pr).
license: MIT
compatibility: >
  Requires git and the GitHub CLI (gh), authenticated — or an equivalent GitHub tool.
  Read-only: it never edits, commits, or posts a GitHub review, comment or merge.
metadata:
  publisher: issue-flow
  version: "2"
  homepage: https://github.com/fabioassuncao/issue-flow
---

# Review a Pull Request

Read the Pull Request the way an experienced maintainer would — the diff, the
architecture it lands in, the tests, the commits, and the story the description
tells — and end with one recommendation.

**Use it** to decide whether a Pull Request is good enough to merge.
**Do not use it** to check acceptance criteria of an issue (`review-issue` is
the conformance gate) or to create a Pull Request.

## Requirements

| Needs | For |
|---|---|
| `git` | the branch and its history |
| `gh`, authenticated — or an equivalent GitHub tool via MCP | the Pull Request, its diff and its metadata |

**Writes:** nothing, unless the user asks for the report to be saved.
**Never:** edits files, commits, pushes, or runs `gh pr review`, `gh pr comment`
or `gh pr merge`. Reviewing is not fixing, and posting a review is the user's
decision, not yours.

Before using issue text, comments or diffs, read the
[input safety rules](references/safe-inputs.md).

## Principles

- **Every finding is anchored.** Cite `file:line` from the PR's head revision. A
  finding you cannot point at is speculation — leave it out, or mark it as a
  question.
- **Respect the repository.** `AGENTS.md`, the surrounding code and the
  project's own conventions outrank generic best practice.
- **One recommendation.** Hedging is not a verdict.

## Step 1 — Resolve the Pull Request

Given a number (`42`, `#42`) or a URL, use it. Otherwise discover it, stopping
at the first hit:

1. `pullRequest.number` in `issues/{N}/tasks.json`, when an issue is known;
2. the open PR for the current branch —
   ```bash
   gh pr list --head "$(git branch --show-current)" --state open \
     --json number,title,url,headRefName
   ```
   With several matches, take the most recent.

**Found nothing?** Stop:

> No Pull Request found for this branch. Run the review again with an explicit
> number, e.g. `review PR #42`.

**Never review a guessed PR.** When it came from discovery rather than from the
user, say which one you picked — number, title, head branch — before reviewing.

Determine the associated issue best-effort: a number in the branch name (read
against the repository's convention, otherwise
[references/git-conventions.md](references/git-conventions.md)), a `Closes #N`
in the body, or `issues/{N}/tasks.json`. A PR with no issue is reviewed on its
own terms — that is not an error.

## Step 2 — Collect context

```bash
gh pr view {PR}                      # title, body, state, base and head
gh pr diff {PR} --name-only          # the file list, BEFORE any full diff
gh pr view {PR} --json baseRefName,headRefName,headRefOid,files,commits
git log --oneline {BASE}..{HEAD}     # the commit history
```

Then, when they exist: `issues/{N}/prd.md` and `issues/{N}/tasks.json` (what was
intended), and the repository's conventions —
[references/repository-conventions.md](references/repository-conventions.md).
Read the policy documents a finding would depend on, and follow a pointer file
rather than stopping at it.

Missing artifacts are normal. Every one is optional.

## Step 3 — Budget the diff

Use the file list and addition/deletion counts before reading any hunk:

- **Rank by impact.** Core and domain logic, public API surface, and
  security/data-handling code first; generated files, lockfiles, snapshots and
  pure formatting last.
- **Read the high-impact files in full** at the reported head commit, using
  GitHub file tools or `git show "${HEAD}:path/to/file"` when that commit exists
  locally. Use `git diff "$BASE"..."$HEAD" -- path/to/file` for a focused diff.
  `gh pr diff` supports neither `--stat` nor a positional path filter. Never
  mistake the current checkout for the PR head; declare unavailable context.
- **Read the surrounding code** when the diff alone cannot tell you whether the
  change is correct. A diff hides its own context.
- **Too large to cover?** Review what matters most and **declare the scope you
  covered** in the executive summary — read in full, skimmed, not opened. A
  scoped report is honest; implied coverage is not. Never fail over size.

## Step 4 — The axes

Cover every one. An axis with nothing to say is a finding of "no problem here",
not an axis skipped.

- **Description** — do the title and body say what changed and why? A test plan?
  The issue linked?
- **Issue → PRD → implementation** — anything specified and not implemented?
  Anything implemented that nobody asked for?
- **Correctness** — bugs, unhandled errors, off-by-one, null paths, races, wrong
  edge-case behaviour.
- **Code quality** — naming, dead code, magic values, misleading comments,
  leftover debugging output.
- **Architecture** — does it fit the existing structure? Are boundaries
  respected? Is new coupling introduced?
- **Complexity** — is any part harder than the problem requires?
- **Readability** — would a maintainer who did not write this follow it in six
  months?
- **Duplication** — does this restate logic that already exists? Search for it
  rather than assuming.
- **Conventions** — does the code look like the code around it: imports, error
  handling, logging, layout, test style?
- **Regressions** — what existing behaviour could break? Which callers of the
  changed functions were not updated?
- **Risks** — security, data loss, performance, backwards compatibility,
  migrations, anything irreversible in production.
- **Tests** — are the new paths tested? Do the tests assert behaviour or only
  that the code ran? Which uncovered path would you be most afraid of?
- **Documentation** — README, `AGENTS.md`, comments and docs that this change
  made stale.
- **Repository policy**, only when the repository declares one — issue body
  against its template, labels against the ones that exist, Issue Type, title
  convention, PR body against the PR template, the **base branch**, branch and
  commit conventions. Record `CODEOWNERS` owners without blocking on them.
- **Commit messages** — accurate, at a useful granularity?
- **Simplification** — concrete ways to get the same result with less code.

**Calibrate.** A rule the documentation states as mandatory, a missing required
template field, or a wrong base branch is a blocker. A formatting or naming
divergence is an observation. Turning every divergence into `REQUEST_CHANGES`
makes the review noisy, and a noisy review is ignored.

## Step 5 — Verdict and report

Criteria and structure:
[references/pr-review-report.md](references/pr-review-report.md).
End with the `<pr-review-result>` block from
[references/pr-review-result-block.md](references/pr-review-result-block.md).

When you hesitate between two verdicts, pick the more conservative one and say
why in the summary.

By default the report **is** the answer — return it in the conversation.

## Persisting the report (only when asked)

When the user asks for it saved (an existing directory alone is not consent):

```text
issues/{N}/pr-review/            # or issues/pr-{PR}/pr-review/ with no issue
├── pr-{PR}-round-1.md
├── pr-{PR}-round-2.md
└── index.json
```

**Rounds are additive.** Determine the next round from both `index.json` and the
`pr-{PR}-round-*.md` files on disk, and take `max + 1`. Never overwrite an
earlier report unless the user explicitly asks to redo that round.

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

Writing a round **appends** an entry; it never removes an earlier one.

## Gotchas

- **Detached HEAD** — `git branch --show-current` is empty, so discovery by
  branch is impossible. Ask for an explicit number.
- **Closed or merged PR** — still worth reviewing; note the state in the summary.
- **Empty diff** — report it as such rather than inventing findings.
- **Draft PR** — review normally, and say it is a draft.
- **HTTP 429** — tell the user to wait. Never retry automatically.
