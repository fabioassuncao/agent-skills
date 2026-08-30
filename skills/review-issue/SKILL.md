---
name: review-issue
description: >
  Review whether a GitHub issue has been fully resolved by analyzing the implementation,
  running tests, and checking for regressions. Use this skill whenever the user wants to
  validate, verify, or review if a GitHub issue was properly resolved — e.g., "review issue #42",
  "validate issue 15", "check if issue #7 is done", "review this issue", "is issue #20 resolved?",
  "close issue #5 if it's done". Also trigger when the user says "code review da issue",
  "revisar issue", "validar issue", or any variation that implies verifying an issue's resolution
  status against the actual codebase. Do NOT use for analyzing issues before implementation
  (use analyze-issue instead) or for general PR code reviews unrelated to a specific issue.
compatibility: Requires gh CLI (https://cli.github.com/) and git
---

# Review Issue Resolution

Validate whether a GitHub issue has been completely resolved by examining the actual implementation, running the project's tests, and checking for regressions. If everything passes, close the issue automatically. If not, produce a detailed report of what's missing.

## Why this skill exists

Closing an issue should mean the problem is actually solved — not just that someone pushed code and moved on. This skill bridges that gap by treating every issue closure as a mini quality gate: fetch the requirements, trace them through the code, run the tests, and only then decide.

---

## Step 1: Fetch Issue Context

```bash
gh issue view {ISSUE_NUMBER} \
  --json title,body,labels,assignees,milestone,comments,state,url \
  --repo {owner}/{repo}
```

If the repo can be inferred from the current directory's git remote, use it. Otherwise, ask the user.

Also fetch linked PRs:

```bash
gh pr list --search "issue:{ISSUE_NUMBER}" --json number,title,state,mergedAt,headRefName,files
```

And check for PRs that reference the issue in their body/title:

```bash
gh pr list --search "{ISSUE_NUMBER}" --state all --json number,title,state,mergedAt,headRefName
```

From all collected data, extract:
- The original problem and motivation
- Explicit and implicit acceptance criteria
- Proposed solution (if described)
- Edge cases mentioned in comments
- Decisions made during discussion

**Language detection**: Note the language used in the issue title, body, and comments. All output (the final report, the closing comment if applicable) must be written in that same language.

---

## Step 2: Detect Project Stack

Before making any decisions about how to run tests, lint, or validate code, understand what you're working with. Look at the project root for signals:

- `package.json` → Node.js/JavaScript/TypeScript ecosystem
- `composer.json` → PHP ecosystem
- `go.mod` → Go
- `Cargo.toml` → Rust
- `pyproject.toml`, `setup.py`, `requirements.txt` → Python
- `Gemfile` → Ruby
- `pom.xml`, `build.gradle` → Java/Kotlin
- `mix.exs` → Elixir
- `Makefile`, `CMakeLists.txt` → C/C++
- `pubspec.yaml` → Dart/Flutter

Also check:
- `docker-compose.yml` / `docker-compose.yaml` / `compose.yaml` → services run in Docker
- `Dockerfile` → containerized environment
- `AGENTS.md` and `CLAUDE.md` → project-specific instructions that may override default behavior
- `.tool-versions`, `.nvmrc`, `.python-version` → version managers
- CI config (`.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`) → how tests are run in CI

**Read the repository's declared policy** — the single source for its conventions,
covering every document an ad-hoc read would miss:

```bash
issue-flow policy 2>/dev/null
```

It lists the **paths** of the policy documents this repository actually has
(`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and whatever `AGENTS.md` forwards
to), plus its labels, Issue Types, base branch and conventions. Read the documents
a finding would depend on. When the CLI is not installed, read `AGENTS.md` and
`CLAUDE.md` from the repository root yourself.

**Follow a pointer file rather than stopping at it.** A `CLAUDE.md` whose entire
content is `Read and follow the instructions in AGENTS.md.` is not a repository
without conventions — concluding that discards everything it forwards to.

These instructions may contain critical detail about how commands are executed
(through Docker, a specific test runner, required flags) and take precedence over
any assumption.

From these signals, determine:
1. The primary language and framework
2. How to run tests (and whether commands need a container prefix)
3. How to run linting/formatting checks
4. The test directory structure and naming conventions

---

## Step 3: Trace the Implementation

Find all code changes related to the issue. Use multiple strategies since not all projects follow the same conventions:

### 3a. From linked PRs
If linked PRs were found in Step 1, examine their diffs:

```bash
gh pr diff {PR_NUMBER}
```

And their commits:

```bash
gh pr view {PR_NUMBER} --json commits
```

### 3b. From branch naming conventions
Look for branches that reference the issue number:

```bash
git branch -a | grep -i "{ISSUE_NUMBER}"
```

### 3c. From commit messages
Search for commits that mention the issue:

```bash
git log --all --oneline --grep="#{ISSUE_NUMBER}" --grep="{ISSUE_NUMBER}" --since="6 months ago"
```

### 3d. From the current branch
If the user is on a feature branch, compare it against the repository's base
branch. Resolve it — never assume `main`:

```bash
BASE=$(issue-flow policy --json 2>/dev/null | jq -r '.pullRequests.baseBranch // empty')
BASE=${BASE:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')}
BASE=${BASE:-main}

git log "$BASE"..HEAD --oneline
git diff "$BASE"...HEAD --stat
```

This matters more than it looks: in a repository based on `develop`, `main`
usually **exists** as well, so hard-coding it does not fail — it silently reviews
the wrong diff.

Once you've identified the relevant commits and changed files, **read and understand every changed file**. Don't just look at the diff — understand the context around the changes.

---

## Step 4: Validate Against Requirements

Map each acceptance criterion from the issue to specific code changes:

- For each requirement: is there code that implements it?
- For each edge case mentioned: is it handled?
- For decisions made in comments: does the code reflect them?

Also check:
- Does the implementation align with the project's architecture and conventions?
- Is there duplicated logic that should be shared?
- Are there coupling issues or unnecessary dependencies introduced?
- Does the code follow the project's existing patterns (check sibling files)?

Be thorough but fair — if the issue didn't mention something, don't flag its absence as a failure. Only flag things that contradict the issue's requirements or violate clear project conventions.

---

## Step 5: Run Tests

Based on the stack detected in Step 2, run the project's test suite. Prefer running only tests related to the changed areas when possible, but if the project is small or the changes are wide-reaching, running the full suite is acceptable.

**Examples of test commands by ecosystem** (adapt based on what you actually find in the project):

| Signal | Likely command |
|--------|---------------|
| `package.json` with `test` script | `npm test` or `yarn test` |
| `composer.json` with pest/phpunit | `vendor/bin/pest` or `vendor/bin/phpunit` |
| `go.mod` | `go test ./...` |
| `Cargo.toml` | `cargo test` |
| `pyproject.toml` with pytest | `pytest` |
| `Gemfile` with rspec | `bundle exec rspec` |
| `mix.exs` | `mix test` |

**If CLAUDE.md specifies a different test command or requires Docker, use that instead.**

After running, note:
- How many tests passed/failed
- Whether any failures are related to the changes in this issue
- Whether test coverage exists for the new/changed behavior

If tests are missing for the changed behavior, flag it — but don't write them yourself. This is a review, not an implementation task.

---

## Step 6: Check for Regressions

Beyond the test results, look for indirect impacts:

- Did the changes modify shared utilities, base classes, or configuration?
- Are there other parts of the codebase that depend on the changed code?
- Could the changes affect database schemas, API contracts, or public interfaces?

Use grep/search to find usages of modified functions, classes, or constants across the codebase. If a widely-used component was changed, pay extra attention to downstream consumers.

---

## Step 7: Produce the Verdict

Based on everything above, decide: **resolved or not?**

The issue is considered **fully resolved** only when ALL of the following are true:
- Every acceptance criterion from the issue is addressed in the code
- Tests pass (no failures related to the changes)
- No regressions detected
- Code follows the project's conventions and patterns

### Orchestrator Mode

When the invocation args contain `--orchestrator` (e.g., `/review-issue #42 --orchestrator`):
- **Do NOT close the issue automatically** — the orchestrator controls when to close.
- **Do NOT add comments to the issue** — the orchestrator handles GitHub interactions.
- **Only produce the structured report and the `<review-result>` block** (see below).

**Detection**: Check if the string `--orchestrator` is present in the skill invocation arguments. If present, enable orchestrator mode. If absent, run in standalone mode.

If invoked standalone (no `--orchestrator` flag):
- Follow the standard behavior below (close issue if resolved, comment if not).

### If RESOLVED (standalone mode only):

Close the issue with a comment summarizing what was validated:

```bash
gh issue close {ISSUE_NUMBER} --comment "{closing_comment}"
```

The closing comment should be in the same language as the issue and briefly state:
- What was validated
- That tests pass
- That no regressions were found

### If NOT RESOLVED (standalone mode only):

Do NOT close the issue. Instead, add a comment detailing what needs attention:

```bash
gh issue comment {ISSUE_NUMBER} --body "{review_comment}"
```

---

## Output Format

Always produce a structured report at the end, written in the same language as the issue:

```markdown
# Code Review — Issue #{number}: {title}

## Status: [APPROVED / REJECTED]

## Summary
Brief description of the overall state.

## Requirements Analysis
| Requirement | Status | Notes |
|-------------|--------|-------|
| ... | Met/Unmet/Partial | ... |

## Implementation Review
- Architecture alignment: ...
- Code quality: ...
- Patterns and conventions: ...

## Tests
- Result: {passed}/{total} passing
- Coverage of changes: adequate / insufficient
- Notes: ...

## Regressions
- {None found / List of concerns}

## Issues Found (if any)
- [ ] ...

## Conclusion
{Clear final decision with justification}
```

---

## Structured Result Block (MANDATORY)

**After the human-readable report, ALWAYS emit a machine-parseable result block.** This is used by the resolve-issue orchestrator to determine whether to enter the correction loop.

### If APPROVED:

```
<review-result>
STATUS: PASS
</review-result>
```

### If REJECTED:

```
<review-result>
STATUS: FAIL
FINDINGS:
- [US-XXX] Description of what failed or is missing
- [US-YYY] Another issue found
</review-result>
```

**Rules for the `<review-result>` block:**
- Always emit it as the **last thing** in your output
- Use `STATUS: PASS` only when the verdict is APPROVED
- Use `STATUS: FAIL` for any other verdict (REJECTED, PARTIAL, etc.)
- In the FINDINGS section, prefix each finding with the affected user story ID (`[US-XXX]`) when applicable
- If a finding is not tied to a specific user story, use `[GENERAL]` as prefix
- Each finding must be a single line

---

## Important Principles

- **Never assume resolved just because the issue is closed or a PR was merged.** Validate in the code.
- **Never trust only comments or descriptions** — always verify against the actual implementation.
- **Prioritize practical analysis** (code behavior) over theoretical assessment.
- **Be rigorous but fair** — flag real problems, not style preferences that aren't project conventions.
- **Always justify your decisions** — every "unmet" or "regression" needs evidence pointing to specific code.
- **Respect the project's own rules** — `AGENTS.md`, `CLAUDE.md`, CI config, and existing conventions always take precedence over generic best practices.
- **Report policy conformance as its own axis**, alongside correctness, scope and
  tests, whenever the repository declares a policy. Check the branch and commits
  against its conventions, the changes against any rule its documents state as
  **mandatory**, and record the owners of paths covered by `CODEOWNERS` — without
  ever failing on that last one, since GitHub enforces the approval.

  **Cite the document and section behind every rule you invoke.** A violation with
  no citation is an opinion the author cannot check.

  Only a rule the repository states as mandatory, a missing required template
  field, or a wrong base branch is blocking. A formatting or naming divergence is
  an observation — a review that fails on style is a review that gets ignored.

  Never restate a repository rule as if it were your own standard, and never
  invent one it does not declare.
