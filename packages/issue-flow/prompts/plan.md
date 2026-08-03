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

Create a tasks.json file at __TASKS_PATH__ with this exact structure:

{
  "project": "<repo-name>",
  "issueNumber": __ISSUE_NUMBER__,
  "issueUrl": "__ISSUE_URL__",
  "branchName": "issue/__ISSUE_NUMBER__-<slug>",
  "description": "<brief description>",
  "issueStatus": "pending",
  "completedAt": null,
  "lastAttemptAt": null,
  "lastError": null,
  "correctionCycle": 0,
  "maxCorrectionCycles": 3,
  "pipeline": {
    "analyzeCompleted": true,
    "prdCompleted": true,
    "jsonCompleted": true,
    "executionCompleted": false,
    "reviewCompleted": false,
    "prCreated": false
  },
  "userStories": [
    {
      "id": "US-001",
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
- acceptanceCriteria must include "Typecheck passes" for code changes
- issueUrl is already resolved above: a GitHub URL when the source is `github`,
  the path of the local issue file when the source is `local`. Use it verbatim
  and never derive it yourself
- Get the repo name from the repository itself (package name, directory name)
- If __ISSUE_NUMBER__ is not a number, keep it as a JSON string in issueNumber
- The branchName should use a short kebab-case slug derived from the issue title

IMPORTANT: You MUST write the tasks.json to the file path above. Do not just output it.
