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

Create a tasks.json file at __TASKS_PATH__ with this exact structure:

{
  "project": "<repo-name>",
  "issueNumber": __ISSUE_NUMBER__,
  "issueUrl": "__ISSUE_URL__",
  "branchName": "__BRANCH_NAME__",
  "description": "<brief description>",
  "issueStatus": "pending",
  "completedAt": null,
  "lastAttemptAt": null,
  "lastError": null,
  "correctionCycle": 0,
  "maxCorrectionCycles": 3,
  "lastReviewFindings": null,
  "pipeline": {
    "analyzeCompleted": false,
    "prdCompleted": true,
    "jsonCompleted": true,
    "executionCompleted": false,
    "reviewCompleted": false,
    "prCreated": false
  },
  "userStories": [
    {
      "id": "__NEXT_US_NUMBER__",
      "title": "...",
      "description": "As a ..., I want ... so that ...",
      "acceptanceCriteria": ["..."],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}

Rules:
- Each user story from the PRD becomes one entry in userStories
- Priority should order stories by dependency (build foundations first)
- Story ids MUST start at __NEXT_US_NUMBER__ and increase sequentially — never
  restart at US-001 when __NEXT_US_NUMBER__ says otherwise
- acceptanceCriteria must name relevant checks from the repository toolchain; include
  typechecking only when the project has a typechecker
- issueUrl is already resolved above: a GitHub URL when the source is `github`,
  the path of the local issue file when the source is `local`. Use it verbatim
  and never derive it yourself
- Get the repo name from the repository itself (package name, directory name)
- If __ISSUE_NUMBER__ is not a number, keep it as a JSON string in issueNumber
- branchName is already resolved: use __BRANCH_NAME__ verbatim. Do not invent a branch.

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

Use the repository's applicable issue template instead of layering another body template over it. Fill required fields; ask when two templates fit equally. Keep the PR template's sections, explaining non-applicable ones briefly.

Use existing label casing. Never create a label unless explicitly opted in by issues.allowLabelCreation and the action is authorized. Drop labels known to be absent; report lost classification. When the registry is unavailable, report that validation could not be performed rather than claiming the label does not exist. Local metadata labels are free-form and should reuse the local vocabulary.

Prefer native fields over labels and textual prefixes. Do not reintroduce a type prefix when the repository uses native Issue Types unless its declared title convention requires it. Defaults apply only to undeclared choices; obtain the fallback taxonomy from the bundled conventions helper where supplied.
<!-- /if -->

## Branch naming

`branchName` is `__BRANCH_NAME__`. Copy it exactly. The CLI computed it from the
repository convention; do not slugify the title yourself.

## Evidence before completion

Use fresh evidence from the revision being delivered. Read the repository's test/build instructions and execute the relevant checks after the final meaningful change. Record commands, results and material coverage limits. An earlier green run, a checked checkbox or another agent's claim is not current verification.

If a required check fails or cannot run, report the failure or unverified criterion. Do not mark that criterion passed or emit a completion/approval signal. Discover checks appropriate to the stack; do not require TypeScript checks in a project without TypeScript. For UI acceptance, use an available browser capability and record what was exercised; missing browser verification remains pending when required.

For bug fixes, reproduce the defect with a focused check before correcting it when the repository and environment permit. Follow existing testing conventions; do not impose universal TDD or tests that merely restate the implementation.

Evaluate review feedback against the code and requirements before applying it. Reproduce valid defects where feasible. Record why an incorrect or inapplicable finding was rejected, with evidence, rather than changing code just to satisfy its wording. Re-review after valid fixes.
