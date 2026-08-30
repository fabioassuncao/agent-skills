You are creating a pull request for issue #__ISSUE_NUMBER__ on branch __BRANCH_NAME__.

The issue content is already resolved and given below — do NOT fetch it:

- Source: __ISSUE_SOURCE__
- Reference: __ISSUE_URL__
- Title: __ISSUE_TITLE__
- Labels: __ISSUE_LABELS__

Issue body:

<issue-body>
__ISSUE_BODY__
</issue-body>

Steps:
1. Read the task plan from __TASKS_PATH__ if it exists
2. Review the git log for this branch: git log __BASE_BRANCH__..HEAD --oneline
3. Review the diff: git diff __BASE_BRANCH__...HEAD --stat
4. Create a well-structured PR using gh pr create

The PR should:
- Have a clear, concise title (under 70 characters)
- Include a summary of changes
- Include a test plan
- Cite where the demand is described: the reference above (`__ISSUE_URL__`)

Issue reference line(s):
- Include the lines below verbatim in the PR body, each entry on its own line,
  with no surrounding code fence or quoting — GitHub only auto-closes an issue
  when the `Closes #N` line is plain body text:
__ISSUE_CLOSES__
- When nothing follows the line above, the issue has no GitHub counterpart: do
  NOT invent a "Closes #" reference, and cite `__ISSUE_URL__` in the body instead

__MULTI_ISSUE_CONTEXT__

Use this command format:
gh pr create --title "..." --body "..." --base __BASE_BRANCH__

IMPORTANT: Output the PR URL after creation so it can be parsed.

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

<!-- if:__REPO_PR_TEMPLATE__ -->
## This repository's Pull Request template

Write the body to this template. Keep **every** heading it defines, in its order.
A section that does not apply gets one line saying why — never delete it:
automated review and the repository's own checklists key off those headings, so a
removed section reads as an unanswered one.

```
__REPO_PR_TEMPLATE__
```

When the repository has several templates under `.github/PULL_REQUEST_TEMPLATE/`,
pick the one matching the nature of this issue and say in the body which one you
picked. If none clearly fits, ask rather than guess.
<!-- /if -->
