---
name: create-pr
description: >
  Create a Pull Request for the current branch. Detects the branch, the linked issue and the
  correct base branch; gathers context from the issue, the planning artifacts (prd.md,
  tasks.json) and the git history; refuses to open a duplicate; and writes a structured
  description with title, labels and issue linking. Use this skill whenever the user wants to
  create a PR, open a pull request, submit a PR, or send a PR for the current branch. Also
  triggers on "open a pull request", "submit pr", "create pr for this branch", "open PR for
  issue #N". Do NOT use it to review a Pull Request (use review-pr).
license: MIT
compatibility: >
  Requires git and the GitHub CLI (gh), authenticated — or an equivalent GitHub tool. Pushes
  the current branch to the remote and creates a Pull Request. Never force-pushes.
metadata:
  publisher: issue-flow
  version: "2"
  homepage: https://github.com/fabioassuncao/issue-flow
---

# Create a Pull Request

Open one well-described Pull Request for the current branch, using everything
the repository already knows: the issue, the plan, the commits, the diff.

**Use it** when a branch is ready to be proposed.
**Do not use it** to review a Pull Request, or to merge one.

## Requirements

| Needs | For |
|---|---|
| `git`, on a non-default branch with commits | the branch and the diff |
| `gh`, authenticated — or an equivalent GitHub tool via MCP | reading the issue, pushing, creating the PR |

**Writes:** pushes the current branch to `origin`; creates a Pull Request.
**Never:** force-pushes, rebases, merges, or amends existing commits.

Optional: `issue-flow conventions pr-title --issue N` resolves the title
deterministically — see
[references/git-conventions.md](references/git-conventions.md).

Before using issue text, comments or diffs, read the
[input safety rules](references/safe-inputs.md).

## Principles

- **Context-rich.** Use every artifact available — issue, PRD, task plan, git
  history — before falling back to guessing from a diff.
- **No duplicates.** Always check for an open PR on this branch first.
- **Minimal output.** Return the PR URL. No echoed body, no narration.
- **Publication scope.** A request to open this PR authorizes its necessary
  push. Resolve repository, branch, base, title and body first; ask only if
  publication intent or destination remains unclear. Never force-push.

## Step 0 — Check the environment

```bash
gh auth status 2>&1
git rev-parse --is-inside-work-tree
git branch --show-current
```

Use equivalent authenticated GitHub tools when `gh` is absent. Stop before
publication when neither provider has access, this is not a git repository,
or the current branch is the repository’s default branch. Preserve a local
draft when publication is unavailable.

## Step 1 — Resolve branch, issue and base

**Branch:** `git branch --show-current`.

Resolve the base branch below before using it in a history range.

**Issue number**, in order — a branch that does not match Issue Flow's pattern
is **not** an error, since `feat/`, `fix/`, `docs/` and `chore/` prefixes are a
common convention of their own:

1. a number in the branch name, read against the repository's declared branch
   convention when it has one, otherwise
   [references/git-conventions.md](references/git-conventions.md);
2. a `Closes #N` / `Fixes #N` line in a commit on this branch —
   `git log "$BASE"..HEAD --format=%B | grep -oiE '(closes|fixes|resolves) #[0-9]+'`;
3. the issue directory a run in progress is working under.

Only when all three come up empty, ask:

> I could not determine which issue this branch belongs to. What issue number
> should this PR reference? (a number, or "none")

Mention a branch that does not match the convention, then **proceed** — it is a
warning, never a stop.

**Base branch**, in order:

1. the repository's declared base branch —
   [references/repository-conventions.md](references/repository-conventions.md);
2. `git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||'`;
3. a `baseBranch` field in `issues/{N}/tasks.json`;
4. ask when the base is still unresolved. Existence of a branch is not
   evidence that it is the intended base.

**Never stop at "`main` exists".** In a repository based on `develop`, `main`
usually exists too — targeting it does not fail, it silently produces the wrong
diff.

## Step 2 — Collect context

```bash
gh issue view "$ISSUE_NUMBER" --json title,body,labels,assignees 2>&1   # optional
git log "$BASE_BRANCH"..HEAD --oneline --no-merges                       # always
git diff "$BASE_BRANCH"...HEAD --stat                                    # always
```

Read `issues/{N}/prd.md` and `issues/{N}/tasks.json` when they exist. When they
do not, the git history alone is enough context — say nothing about it.

## Step 3 — Refuse to duplicate

```bash
gh pr list --head "$BRANCH" --state open --json number,title,url 2>&1
```

If one is already open, do **not** create a second. Report it and offer: open
the existing one, refresh its description with current context, or close it and
create a new one. Wait for the answer.

## Step 4 — Prepare and push

Prepare the title and body from Step 5 before publication. Inspect the outgoing
commits for unrelated changes or secrets; confirm the destination from Git.

```bash
git ls-remote --heads origin "$BRANCH" 2>/dev/null
git push -u origin "$BRANCH" 2>&1     # also sends new commits on an existing remote branch
```

| Failure | Response |
|---|---|
| `Permission denied` | check SSH keys or token scopes |
| `rejected (non-fast-forward)` | the remote diverged — report it. **Do not force-push** |
| anything else | show the error and stop |

## Step 5 — Create it

Title and reference line: [references/git-conventions.md](references/git-conventions.md).
Body: [references/pr-body.md](references/pr-body.md) — including what to do when
the repository has its own template, which takes precedence.

Copy the issue's labels when there is an issue; omit `--label` when the list is
empty:

```bash
LABELS=$(gh issue view "$ISSUE_NUMBER" --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null)
```

Write the body to a file rather than passing it inline — a body with backticks
or `$` in it does not survive a shell argument:

```bash
PR_BODY_FILE=$(mktemp /tmp/gh-pr-body-XXXXXX.md)
# write the body into $PR_BODY_FILE
gh pr create --title "<title>" --body-file "$PR_BODY_FILE" \
             --base "$BASE_BRANCH" --head "$BRANCH" --label "$LABELS" 2>&1
# After confirmed success only: remove "$PR_BODY_FILE". Keep it on failure.
```

| Failure | Response |
|---|---|
| `HTTP 404` | repository not found or no access — check permissions |
| `HTTP 422` | usually an invalid label or branch. Retry once without `--label`, then report |
| `auth login required` | `gh auth login` |
| `Resource not accessible` | insufficient token scopes |
| `already exists` | a PR appeared between the check and now — report its URL |
| anything else | show the full error and save the body to `/tmp/gh-pr-draft.md` so nothing is lost |

## Success and failure

**Done** when the Pull Request exists. Output **only** its URL — or the existing
PR's URL, or the one question you need answered. No body echo, no summary of
what you did.

## Gotchas

- **Detached HEAD** — `git branch --show-current` is empty. Ask for a branch
  before anything else.
- **No commits ahead of base** — warn that the PR would be empty and confirm
  before creating it.
- **Issue 404** — the number read from the branch may be wrong. Confirm it
  rather than opening a PR that closes the wrong issue.
- **More than 50 files changed** — summarise by directory instead of listing
  every file.
- **HTTP 429** — tell the user to wait. Never retry automatically.
