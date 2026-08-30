# generate-issue

Generates detailed, architect-quality GitHub issues from short instructions. Analyzes the project's actual stack, architecture, and codebase before writing. Detects duplicate issues, applies existing labels (never creates them unless `issues.allowLabelCreation`), and publishes via `gh` CLI.

## Usage

```
Create an issue for adding rate limiting to the API
```

**Other trigger phrases:**
```
Open an issue about the broken auth flow
File a bug: login fails when session expires
Add this to the backlog: refactor the payment module
We need to fix the auth flow
```

## What It Does

1. **Validates environment** — checks `gh` CLI is installed and authenticated
2. **Discovers the project** — scans the repo for stack, architecture, and conventions
3. **Detects project language** — matches the language used in existing issues/README
4. **Analyzes the request** — expands the short instruction into a technical analysis
5. **Controls scope** — splits overly broad requests into separate issues (with user approval)
6. **Writes the issue** — produces a structured issue with context, diagnosis, solution, execution plan, risks, and acceptance criteria
7. **Checks for duplicates** — multi-strategy search (keywords, area, labels) to avoid duplicate issues
8. **Validates labels** — uses only labels the repository already has; never creates them unless `issues.allowLabelCreation`
9. **Publishes** — creates the issue via `gh` CLI with error handling
10. **Cross-references** — links related issues bidirectionally

## Issue Structure

Each generated issue includes:

- Context and Motivation
- Current State Diagnosis
- Identified Problems
- Objectives
- Proposed Solution
- Alternatives Considered
- Pros and Cons
- Execution Plan (with checkboxes)
- Risks and Precautions
- Acceptance Criteria (with checkboxes)
- Expected Outcome
- Related Issues / Notes

## Requirements

- **GitHub CLI** (`gh`) authenticated with the repository
- **Git** configured inside a repo with a GitHub remote
