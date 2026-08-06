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
2. Review the git log for this branch: git log main..HEAD --oneline
3. Review the diff: git diff main...HEAD --stat
4. Create a well-structured PR using gh pr create

The PR should:
- Have a clear, concise title (under 70 characters)
- Include a summary of changes
- Include a test plan
- Cite where the demand is described: the reference above (`__ISSUE_URL__`)

Issue reference line(s):
- Include the following verbatim in the PR body, each entry on its own line:
```
__ISSUE_CLOSES__
```
- When it is empty, the issue has no GitHub counterpart: do NOT invent a
  "Closes #" reference, and cite `__ISSUE_URL__` in the body instead

__MULTI_ISSUE_CONTEXT__

Use this command format:
gh pr create --title "..." --body "..." --base main

IMPORTANT: Output the PR URL after creation so it can be parsed.
