---
name: create-pr
description: >
  Create a Pull Request for the current branch via GitHub CLI. Automatically detects the branch,
  linked issue number, and base branch; collects context from planning artifacts (prd.md, tasks.json),
  git history, and the GitHub issue; checks for duplicate PRs; and generates a well-structured PR
  with title, description, labels, and issue linking. Use this skill whenever the user wants to
  create a PR, open a pull request, submit a PR, or create a PR for this branch. Also triggers on:
  "create a pr", "open a pull request", "submit pr", "create pr for this branch", "send PR",
  "open PR for issue #N", or any request that implies creating a pull request on GitHub.
compatibility: Requires gh CLI (https://cli.github.com/) and git
---

# Create Pull Request

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

You are an autonomous agent responsible for creating a well-structured Pull Request on GitHub for the current working branch.

## Core Principles

- **Context-rich PRs.** Leverage all available artifacts (issue, PRD, tasks, git history) to write informative PR descriptions.
- **No duplicates.** Always check for existing open PRs on the same branch before creating.
- **Graceful degradation.** Work without planning artifacts — fall back to git log/diff and issue data.
- **Minimal output.** Return only the PR URL. No logs, no body echo, no explanations.
- **Safety first.** Never force-push. Always confirm before pushing to remote.

---

## Workflow

Follow these steps in order. Do not skip any.

### Step 0 — Validate Environment

Before anything else, confirm that the required tools are available:

```bash
gh auth status 2>&1
```

**If `gh` is not installed**: Stop and tell the user:
> `gh` CLI is not installed. Install it from https://cli.github.com/ and run `gh auth login`.

**If not authenticated**: Stop and tell the user:
> You are not authenticated with GitHub. Run `gh auth login` to authenticate.

**If not inside a git repository**: Stop and tell the user:
> This directory is not a git repository. Navigate to a git repository before creating a PR.

**If on the default branch (main/master)**: Stop and tell the user:
> You are on the default branch. Switch to a feature branch before creating a PR.

Only proceed once the environment is confirmed working.

---

### Step 1 — Detect Branch and Issue Number

1. **Get the current branch name:**
   ```bash
   BRANCH=$(git branch --show-current)
   ```

2. **Extract the issue number**, trying each source in turn. A branch that does
   not match Issue Flow's default pattern is **not** an error: repositories that
   use `feat/`, `fix/`, `docs/` and `chore/` prefixes are following a common
   convention, and refusing to open their Pull Requests is the skill's problem,
   not theirs.

   In order:
   1. a number embedded in the branch name, read against `git.branchConvention`
      from [the shared block](../_shared/repository-policy.md) when the repository
      declares one, otherwise `issue/{N}-*`;
   2. a `Closes #N` / `Fixes #N` line in a commit on this branch:
      `git log "$BASE"..HEAD --format=%B | grep -oiE '(closes|fixes|resolves) #[0-9]+'`;
   3. the issue directory the pipeline is working under, if a run is in progress.

   Only when all three come up empty, ask:
   > I could not determine which issue this branch belongs to.
   > What issue number should this PR reference? (Enter a number, or "none" to create without issue linking)

   Mention it when the branch does not match the expected convention, but
   **proceed** — it is a warning, not a stop.

3. **Determine the base branch** using this priority:
   1. `pullRequests.baseBranch` from [the shared block](../_shared/repository-policy.md)
   2. `origin/HEAD`:
      ```bash
      git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||'
      ```
   3. Check `issues/{N}/tasks.json` for a `baseBranch` field (if the file exists).
   4. Check if `main` exists: `git show-ref --verify refs/heads/main 2>/dev/null`
   5. Check if `master` exists: `git show-ref --verify refs/heads/master 2>/dev/null`
   6. Check if `dev` or `develop` exists.
   7. If none found, ask the user which branch to target.

   Never stop at "`main` exists": in a repository based on `develop`, `main`
   usually exists too, and a Pull Request opened against it carries the wrong
   diff without failing.

Store `BRANCH`, `ISSUE_NUMBER`, and `BASE_BRANCH` for use in subsequent steps.

---

### Step 2 — Collect Context

Gather all available context to build a rich PR description.

#### 2a — Issue Data (if issue number is available)

```bash
gh issue view $ISSUE_NUMBER --json title,body,labels,assignees 2>&1
```

Store the issue title and labels. If the command fails (404, no permissions), note that issue data is unavailable and continue.

#### 2b — Planning Artifacts (if they exist)

Check for and read these files if they exist:

- `issues/{N}/prd.md` — Extract the summary, goals, and user stories
- `issues/{N}/tasks.json` — Extract user story titles, IDs, and pass/fail status

If these files don't exist, that's fine — skip this sub-step.

#### 2c — Git History and Diff

```bash
# Commits on this branch not in base
git log $BASE_BRANCH..HEAD --oneline --no-merges

# File change summary
git diff $BASE_BRANCH...HEAD --stat
```

These are always available and form the minimum context for PR generation.

---

### Step 3 — Check for Duplicate PRs

Before creating a new PR, check if one already exists for this branch:

```bash
gh pr list --head "$BRANCH" --state open --json number,title,url 2>&1
```

**If an open PR already exists:**
Tell the user:
> A PR already exists for this branch:
> - #[number] — [title]
> - URL: [url]
>
> Would you like to:
> A. Open the existing PR (no action needed)
> B. Update the existing PR description with fresh context
> C. Close the existing PR and create a new one

Wait for the user's choice. Do NOT create a duplicate PR.

**If no open PR exists:** Proceed to Step 4.

---

### Step 4 — Push Branch to Remote

Check if the branch has been pushed to the remote:

```bash
git ls-remote --heads origin "$BRANCH" 2>/dev/null
```

**If the branch is not on the remote**, push it:

```bash
git push -u origin "$BRANCH" 2>&1
```

**If the push fails:**

| Error | Action |
|-------|--------|
| `Permission denied` | Tell the user to check their SSH keys or token permissions. |
| `rejected (non-fast-forward)` | Tell the user the remote branch has diverged. Do NOT force-push. |
| Any other error | Show the error and stop. |

---

### Step 5 — Generate and Create the PR

#### 5a — Build the PR Title

Use this format:
```
[Issue #N] <issue title>
```

If an issue title is available from Step 2a, use it. Otherwise, derive a title from the branch name slug.

**Rules:**
- Max 70 characters
- No trailing punctuation
- If no issue number, omit the prefix and use a descriptive title from the commits

#### 5b — Build the PR Description

Use this template. Include sections conditionally based on available data:

```markdown
## Summary

[1-3 sentence summary of what this PR does and why. Derived from the issue description or PRD goals.]

## Changes

[List of commits or grouped changes. Use git log output from Step 2c.]

- commit message 1
- commit message 2
- ...

## Files Changed

[File change summary from git diff --stat]

## User Stories Implemented

[Only include if tasks.json exists and has user stories]

- [x] US-001: [title] — ✅ Passing
- [x] US-002: [title] — ✅ Passing
- [ ] US-003: [title] — ❌ Not passing

## Review Checklist

- [ ] Code follows project conventions
- [ ] Changes are focused and minimal
- [ ] No sensitive data committed
- [ ] Quality checks pass (lint, typecheck, tests)

---

Closes #N
```

**Graceful degradation rules:**
- No issue data → Skip the `Closes #N` line and derive summary from commits
- No PRD/tasks.json → Skip the "User Stories Implemented" section
- No user stories → Skip the "User Stories Implemented" section
- Always include: Summary, Changes, Files Changed, Review Checklist

#### 5c — Collect Labels

If an issue number is available, copy its labels to the PR:

```bash
LABELS=$(gh issue view $ISSUE_NUMBER --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null)
```

#### 5d — Create the PR

Write the PR body to a temporary file and create the PR:

```bash
PR_BODY_FILE=$(mktemp /tmp/gh-pr-body-XXXXXX.md)
# Write the body content to $PR_BODY_FILE

gh pr create \
  --title "<title>" \
  --body-file "$PR_BODY_FILE" \
  --base "$BASE_BRANCH" \
  --head "$BRANCH" \
  --label "$LABELS" 2>&1

rm -f "$PR_BODY_FILE"
```

**Handle errors:**

| Error | Action |
|-------|--------|
| `HTTP 404` | Repository not found or no access. Tell user to check repo permissions. |
| `HTTP 422 (Validation Failed)` | Usually invalid labels or branch. Retry without labels, then report. |
| `auth login required` | Tell user to run `gh auth login`. |
| `Resource not accessible` | Insufficient permissions. Tell user to check token scopes. |
| `already exists` | A PR was created between our check and creation. Show the existing PR URL. |
| Any other error | Capture the full error, present it to the user, and save the PR body to `/tmp/gh-pr-draft.md` so nothing is lost. |

---

### Step 6 — Return the Result

Output ONLY one of:
- The URL of the created PR
- A message that an existing PR was found (with the PR URL)
- A question to the user (if duplicate or missing info)

Nothing else. No PR body echo, no intermediate output, no "here's what I did" summary.

---

## Edge Cases

- **Detached HEAD**: If `git branch --show-current` returns empty, stop and tell the user to check out a branch first.
- **No commits ahead of base**: If there are no commits on the branch that aren't in the base, warn the user that the PR will be empty and ask for confirmation.
- **Branch with no remote tracking**: Push the branch first (Step 4), then create the PR.
- **Issue not found (404)**: The issue number from the branch may be wrong. Ask the user to confirm the issue number.
- **Very large diffs**: If `git diff --stat` shows more than 50 files changed, summarize by directory instead of listing every file.
- **Rate limiting**: If `gh` returns HTTP 429, tell the user to wait and retry. Do not retry automatically.
