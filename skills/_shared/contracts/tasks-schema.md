# `tasks.json`: the task plan contract

The execution plan for one issue. Written by the PRD→JSON conversion, read and
updated by the execution loop, and read by review and Pull Request creation.

Path: `issues/{ISSUE_NUMBER}/tasks.json`.

## Shape

```json
{
  "project": "<repo name, from package.json or the directory>",
  "issueNumber": 42,
  "issueUrl": "https://github.com/{owner}/{repo}/issues/42",
  "branchName": "feat/42-short-slug",
  "description": "<one-line description, from the PRD intro>",
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
  "userStories": [
    {
      "id": "US-001",
      "title": "<story title>",
      "description": "As a <user>, I want <feature> so that <benefit>",
      "acceptanceCriteria": [
        "Specific verifiable criterion",
        "Another criterion",
        "Typecheck passes"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

## Field rules

| Field | Rule |
|---|---|
| `issueNumber` | a number; keep it a JSON **string** when the identifier is not numeric |
| `issueUrl` | a GitHub URL for a remote issue, the path of `issues/<id>/issue.md` for a local one. Never derive it — use the one already resolved |
| `branchName` | the branch actually in use. Follow the repository's convention (see `references/git-conventions.md`); never slugify a title on your own when a resolved name is available |
| `issueStatus` | `pending` → `in_progress` → `completed` |
| `completedAt` | `null` until **every** story passes |
| `lastError` | a short category plus a timestamp while blocked; cleared after a successful unblocked iteration |
| `lastReviewFindings` | the verbatim findings of the most recent failed review. **Non-null means execution is not done**, even when every story already passes |
| `priority` | dependency order, `1` first |
| `passes` | starts `false` for every story |

## Pipeline flags

`pipeline` records which phases finished, so a run can resume from the first
incomplete one.

| Flag | Meaning |
|---|---|
| `prdCompleted` | the PRD exists |
| `jsonCompleted` | this file exists — set it `true` as soon as you write it |
| `executionCompleted` | every story implemented and committed |
| `reviewCompleted` | conformance review passed |
| `prCreated` | a Pull Request exists |

Two flags are **optional**, and their absence means "never requested", not
"pending":

| Flag | When present |
|---|---|
| `analyzeCompleted` | only when a separate analysis phase ran |
| `prReviewCompleted` | only when the opt-in Pull Request review phase ran |

Never add either as `false`: a resumable pipeline would read that as unfinished
work and re-enter a phase nobody asked for.

## Turning a PRD into stories

1. Every user story in the PRD becomes exactly one entry.
2. IDs are sequential. **Do not restart at `US-001`** when a starting number was
   given — continue from it.
3. `priority` follows dependency order first, document order second.
4. Every story starts `"passes": false` and `"notes": ""`.
5. Every story that changes code carries the project’s applicable quality
   check as its last acceptance criterion. Use `"Typecheck passes"` when the
   project has a typechecker; do not invent one for an untyped project.
6. Every story that changes UI carries a browser-verification criterion.

### Split a story that is too big

Flag and split any story that:

- cannot be described in 2-3 sentences;
- touches more than one layer (schema *and* UI in the same story);
- has more than 6-7 acceptance criteria.

> "Add user notification system" splits into: add notifications table → create
> notification service → add bell icon to header → create dropdown panel →
> mark-as-read.

### Verify the order

Earlier stories must never depend on later ones:

1. schema and migrations
2. backend logic, server actions, API endpoints
3. UI components consuming that backend
4. aggregate and summary views

If the order is wrong, reorder and renumber before writing.

## Before writing

- [ ] every story has `"passes": false` and `"notes": ""`
- [ ] `issueStatus` is `"pending"`
- [ ] `completedAt`, `lastAttemptAt`, `lastError`, `lastReviewFindings` are `null`
- [ ] `correctionCycle` is `0`, `maxCorrectionCycles` is `3`
- [ ] `pipeline.jsonCompleted` is `true`; no optional flag was invented
- [ ] stories ordered by dependency, none depending on a later one
- [ ] oversized stories were split
- [ ] `branchName` matches the branch actually checked out
- [ ] the file parses as JSON
