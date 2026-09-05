# Portable task plan

Read when creating, executing or resuming a task plan. The JSON contract is validated by the bundled `scripts/artifacts.mjs plan <tasks.json>`, compiled from the CLI's canonical schema. The script is read-only. Preserve unknown fields during updates; never replace a plan with the validator's parsed output.

```json
{
  "project": "example",
  "issueNumber": 42,
  "issueUrl": "",
  "branchName": "fix/42-session",
  "description": "Handle expired sessions",
  "issueStatus": "pending",
  "completedAt": null,
  "lastAttemptAt": null,
  "lastError": null,
  "correctionCycle": 0,
  "maxCorrectionCycles": 3,
  "lastReviewFindings": null,
  "pipeline": {
    "prdCompleted": true,
    "jsonCompleted": true,
    "executionCompleted": false,
    "reviewCompleted": false,
    "prCreated": false
  },
  "userStories": [{
    "id": "US-001",
    "title": "Handle expiry",
    "description": "Reject expired sessions with a useful response",
    "acceptanceCriteria": ["Expired sessions receive 401", "Relevant regression test passes"],
    "priority": 1,
    "passes": false,
    "notes": ""
  }]
}
```

issueNumber may be a non-empty string for a local identifier. Use a real GitHub URL only for GitHub issues; otherwise use a local reference or an empty string. Each story has a unique US-NNN ID and numeric priority. Allocate new IDs above those already present in the project's local plans; retain IDs of existing stories. Order by actual dependencies, then document order; do not split a coherent story just because it spans layers.

New stories start passes=false. Set prdCompleted/jsonCompleted only after their artifacts exist and validate. A standalone conversion does not create a branch or authorize execution. Preserve an existing branchName or use the actual intended branch.

lastError is null or {message, at, category}; at is an ISO timestamp. lastReviewFindings is null or the unresolved review findings. Non-null findings prevent completion even if every story passes. correctionCycle counts attempted correction rounds, maxCorrectionCycles defaults to 3.

Standalone execute may mark its plan completed when every story is verified. When called by resolve-issue, keep issueStatus=in_progress until every requested review/publication phase succeeds. pipeline flags record phase results, not evidence substitutes. Persist pullRequest only after a confirmed PR exists, using {number,url,headBranch,createdAt} as returned by GitHub.
