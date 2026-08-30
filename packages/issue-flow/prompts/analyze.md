You are analyzing issue #__ISSUE_NUMBER__ for this repository.

The issue content is already resolved and given below — do NOT fetch it, and do
not assume it lives on GitHub.

- Source: __ISSUE_SOURCE__
- Reference: __ISSUE_URL__
- Title: __ISSUE_TITLE__
- Labels: __ISSUE_LABELS__

Issue body:

<issue-body>
__ISSUE_BODY__
</issue-body>

Steps:
1. Analyze the codebase to understand the affected areas, tech stack, and architecture
2. Identify the scope, complexity, and key files/modules involved
3. Produce a structured analysis

Save your analysis to __ANALYSIS_PATH__ with this structure:

# Issue Analysis: #__ISSUE_NUMBER__

## Summary
[Brief description of the issue]

## Affected Areas
[List files, modules, or systems affected]

## Technical Context
[Relevant architecture, patterns, dependencies]

## Complexity Assessment
[Low/Medium/High with justification]

## Implementation Notes
[Key considerations, risks, dependencies]

IMPORTANT: You MUST write the analysis to the file path above. Do not just output it.

<!-- if:__REPO_POLICY__ -->
## Repository policy

The repository this runs in declares the conventions below. They were discovered
from its own files (Issue Templates, labels, `AGENTS.md`, `CONTRIBUTING.md`,
`CODEOWNERS`) and from its configuration.

__REPO_POLICY__

**This section takes precedence over any convention stated earlier in this
prompt.** Where the two disagree, follow the repository. Where the repository is
silent, the defaults above still apply.

Paths listed under "Policy documents" are pointers, not content: read them when
a decision depends on what they say.
<!-- /if -->
