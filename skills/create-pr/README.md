# create-pr

Create a Pull Request for the current branch via GitHub CLI. Automatically detects the branch, linked issue number, and base branch; collects context from planning artifacts, git history, and the GitHub issue; checks for duplicate PRs; and generates a well-structured PR with title, description, labels, and issue linking.

## Usage

```
Create a PR
```

**Other trigger phrases:**
```
Open a pull request for this branch
Submit PR for issue #42
Send PR
Create PR for this branch
Open PR for issue #15
```

## How It Works

1. **Validates environment** — checks `gh` CLI is installed and authenticated, confirms you're in a git repo on a feature branch
2. **Detects branch and issue** — reads the current branch, extracts the issue number (from the repository's branch convention, a `Closes #N` in the branch's commits, or the run in progress), and resolves the base branch from the repository rather than assuming `main`
3. **Collects context** — fetches the GitHub issue via `gh`, reads `issues/{N}/prd.md` and `issues/{N}/tasks.json` if they exist, runs `git log` and `git diff --stat` against the base branch
4. **Checks for duplicates** — looks for existing open PRs on the same branch via `gh pr list --head <branch>`
5. **Pushes the branch** — pushes to remote if not already pushed
6. **Creates the PR** — generates a standardized title, structured description (summary, changes, user stories, review checklist), copies labels from the issue, and links `Closes #N`

> The skill **gracefully degrades** — if planning artifacts don't exist, it falls back to git log/diff and issue data to build the PR description.

## Requirements

- **GitHub CLI** (`gh`) authenticated with the repository
- **Git** configured with push access
