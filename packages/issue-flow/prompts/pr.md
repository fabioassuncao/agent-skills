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
1. Check whether this branch already has an open Pull Request:
   `gh pr list --head __BRANCH_NAME__ --state open --json number,url`.
   If it does, do NOT create a second one — report the existing URL and stop.
   The pipeline checks this before invoking you and normally skips this phase
   entirely, so reaching this point with a Pull Request already open means the
   check could not run: it is the last guard against a duplicate, not a
   formality.
2. Read the task plan from __TASKS_PATH__ if it exists
3. Review the git log for this branch: git log __BASE_BRANCH__..HEAD --oneline
4. Review the diff: git diff __BASE_BRANCH__...HEAD --stat
5. Create a well-structured PR using gh pr create

The PR should:
- Use this title verbatim: `__PR_TITLE_CONVENTION__`
- Include a summary of changes
- Include a test plan
- Cite where the demand is described: the reference above (`__ISSUE_URL__`)

Issue reference line(s):
- Include the lines below verbatim in the PR body, each entry on its own line,
  with no surrounding code fence or quoting — GitHub only auto-closes an issue
  when the `Closes #N` line is plain body text:
__ISSUE_REFERENCE__
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

Use the repository's applicable issue template instead of layering another body template over it. Fill required fields; ask when two templates fit equally. Keep the PR template's sections, explaining non-applicable ones briefly.

Use existing label casing. Never create a label unless explicitly opted in by issues.allowLabelCreation and the action is authorized. Drop labels known to be absent; report lost classification. When the registry is unavailable, report that validation could not be performed rather than claiming the label does not exist. Local metadata labels are free-form and should reuse the local vocabulary.

Prefer native fields over labels and textual prefixes. Do not reintroduce a type prefix when the repository uses native Issue Types unless its declared title convention requires it. Defaults apply only to undeclared choices; obtain the fallback taxonomy from the bundled conventions helper where supplied.
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

## Authorized publication

A request to analyze, plan or review does not itself request a remote comment, closure, push or PR. Publish only when the user's request or existing session authorization includes that action. Preparing a concrete draft, diff and verification result comes before asking for any missing authorization. Do not ask again for authorization already granted.

Before creating an issue or PR, check for an existing equivalent item. Reuse a matching open PR instead of creating another. Updating, closing or reopening an existing item requires authorization for that action. On an uncertain publication result, query the remote before retrying to avoid duplicates.

Pass user text as structured tool arguments or a UTF-8 body file, never shell interpolation. Use argument arrays for commands. Verify success before deleting a draft. If publishing fails, preserve the draft and report the failed operation and actionable reason. Never force-push.
