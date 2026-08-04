# review-pr

Review a Pull Request as a whole — the complete diff, architecture, duplication, tests, commit messages and the PR description — and produce a structured report ending in a single recommendation: `APPROVE`, `APPROVE_WITH_SUGGESTIONS` or `REQUEST_CHANGES`.

## Usage

```
/review-pr #42
```

**Other trigger phrases:**
```
Review this PR
Review the pull request for this branch
Code review do PR #128
Revisar o PR
Is this PR ready to merge?
```

Without a number, the skill discovers the Pull Request from `issues/{N}/tasks.json` or from the open PR of the current branch, and tells you which one it picked before reviewing.

## How It Works

1. **Resolves the PR** — explicit number, `tasks.json`, or `gh pr list --head <branch>`; never reviews a guessed PR
2. **Collects context** — `gh pr view`, `gh pr diff --name-only`, `--stat`, `git log`, plus `prd.md`, `tasks.json`, `CLAUDE.md` and `README.md` when they exist
3. **Budgets the diff** — ranks files by impact, reads the high-impact ones in full, skims the rest; on a very large PR it declares the scope covered instead of failing
4. **Reviews 15 axes** — PR description, issue → PRD → implementation, correctness, code quality, architecture, complexity, readability, duplication, project conventions, regressions, risks, test coverage, documentation, commit messages and simplification opportunities
5. **Emits the verdict** — a report with fixed headings, findings as `- [severity] file:line — title`, and the machine-parseable `<pr-review-result>` block as the last thing in the output

> The skill is **intended to be read-only**: do not edit, commit, push, or run `gh pr review`/`gh pr comment`/`gh pr merge`. Bash may still be used for inspection (`gh`/`git`/`rg`).

## Output

The report uses these headings, in this order:

```
## Executive summary
## Strengths
## Issues found
## Suggested improvements
## Architectural observations
## Risks identified
## Required before merge
## Final recommendation
```

Followed by:

```
<pr-review-result>
RECOMMENDATION: APPROVE_WITH_SUGGESTIONS
BLOCKERS:
- None
</pr-review-result>
```

A malformed or missing block is a failed review — it is never read as an approval.

## Persisting the Report

On request (or when `issues/{N}/pr-review/` already exists), the report is saved in the same layout the CLI uses, with additive rounds:

```
issues/{N}/pr-review/pr-42-round-1.md
issues/{N}/pr-review/index.json
```

## CLI Equivalent

Same axes, same headings, same result block:

```bash
issue-flow pr-review 42     # standalone review
issue-flow run 25 --pr-review   # as the final pipeline phase
```

The CLI adds deterministic exit codes (`0` approve, `2` request changes, `1` failure) and writes the artifacts automatically.

## Requirements

- **GitHub CLI** (`gh`) authenticated with the repository
- **Git**

## Related

- [`review-issue`](../review-issue/) — verifies whether a GitHub *issue* was resolved
- [`create-pr`](../create-pr/) — creates the Pull Request this skill reviews
