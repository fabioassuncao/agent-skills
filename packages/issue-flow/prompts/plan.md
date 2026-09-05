You are converting a PRD into a structured JSON task plan for issue #__ISSUE_NUMBER__.

The issue is already resolved — do NOT fetch it:

- Source: __ISSUE_SOURCE__
- Reference: __ISSUE_URL__
- Title: __ISSUE_TITLE__
- Labels: __ISSUE_LABELS__

Issue body (the original demand, for the description field):

<issue-body>
__ISSUE_BODY__
</issue-body>

Here is the PRD:

__PRD_CONTENT__

The next available User Story number for this project is __NEXT_US_NUMBER__. This
was already resolved by the CLI (from the project's numbering history, or from an
explicit --continue / --start-us override) — do NOT restart numbering at US-001
unless __NEXT_US_NUMBER__ is itself US-001. Number the first story in this plan
__NEXT_US_NUMBER__ and every subsequent story sequentially from there (e.g. if
__NEXT_US_NUMBER__ is US-016, use US-016, US-017, US-018, ...).

Create a tasks.json file at __TASKS_PATH__ following the contract below.

<!-- include:tasks-schema.md -->

For this run specifically:

- `issueNumber` is __ISSUE_NUMBER__; keep it a JSON string when it is not a number
- `issueUrl` is `__ISSUE_URL__` — already resolved above. Use it verbatim and
  never derive it yourself
- `branchName` is `__BRANCH_NAME__` — already resolved from the repository's
  convention. Copy it exactly; do not slugify the title yourself
- `pipeline.analyzeCompleted` and `pipeline.prdCompleted` are `true`: both
  phases already ran
- Get the project name from the repository itself (package name, directory name)

IMPORTANT: You MUST write the tasks.json to the file path above. Do not just output it.

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

## Branch naming

`branchName` is `__BRANCH_NAME__`. Copy it exactly. The CLI computed it from the
repository convention; do not slugify the title yourself.
