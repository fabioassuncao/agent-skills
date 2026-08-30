---
name: analyze-issue
description: >
  Fetch and analyze a GitHub issue to extract context, scope, affected areas, and complexity
  before planning implementation. Use this skill when you need to understand a GitHub issue
  in depth before creating a PRD or task plan — e.g., when the user says "analyze issue #42",
  "what does this issue involve", or when the resolve-issue skill delegates analysis.
compatibility: Requires gh CLI (https://cli.github.com/) and git
---

# Analyze GitHub Issue

## The Job

Fetch a GitHub issue and produce a structured analysis that will inform the PRD and task plan.

---

## Step 1: Fetch Issue Data

```bash
gh issue view {ISSUE_NUMBER} \
  --json title,body,labels,assignees,milestone,comments,state,url \
  --repo {owner}/{repo}
```

If the repo can be inferred from the current directory's git remote, use it. Otherwise, ask the user.

Also fetch any linked PRs or referenced issues if mentioned in the body.

---

## Step 2: Understand the Codebase Context

Before analyzing the issue, orient yourself in the codebase:

1. Read the repository's declared policy — the single source for its
   conventions, covering every file an ad-hoc read would miss:

   ```bash
   issue-flow policy 2>/dev/null
   ```

   It reports the Issue Templates, labels, Issue Types, base branch and the
   **paths** of the policy documents this repository actually has (`AGENTS.md`,
   `CLAUDE.md`, `CONTRIBUTING.md`, and whatever `AGENTS.md` points at). Read the
   ones a decision depends on — `AGENTS.md` first when it exists, since it is the
   open standard and the primary source in repositories that adopted it.

   When the CLI is not installed, fall back to reading `AGENTS.md` and
   `CLAUDE.md` from the repository root yourself.

   When the issue was filed against an Issue Template, judge its completeness
   against **that template's** required fields, and name the field that is
   missing rather than asking for more detail in general.
2. Identify the tech stack from `package.json`, `pyproject.toml`, `Cargo.toml`, etc.
3. Identify the testing setup: `jest`, `vitest`, `pytest`, `cargo test`, etc.
4. Identify the linting/typecheck commands available

---

## Step 3: Produce Analysis

Generate a structured analysis with these sections:

### Issue Summary
- **Title**: Issue title
- **Goal**: What problem is being solved or what feature is being added?
- **Reporter context**: Any important context from comments or issue body
- **Type**: bug / feature / refactor / docs / performance

### Scope Assessment
- **Affected areas**: Which modules, files, or systems will likely be touched?
- **Complexity**: Simple (1-2 stories) / Medium (3-5 stories) / Complex (6+ stories)
- **Dependencies**: Does this depend on other issues or external services?

### Technical Notes
- Known constraints
- Relevant existing code patterns that should be followed
- Files likely to be modified (best guess based on codebase exploration)
- Potential gotchas or non-obvious considerations

### Ambiguities
- List anything unclear that needs clarification before writing the PRD
- Flag if the issue scope is too broad and should be split

---

## Output

Print the analysis to the user.

If there are critical ambiguities, list them in the Ambiguities section of the output. When invoked from a pipeline (e.g., resolve-issue), do NOT stop to ask — flag them in the output and let the orchestrator decide whether to ask the user. When invoked standalone, you may ask up to 1-3 clarifying questions.
