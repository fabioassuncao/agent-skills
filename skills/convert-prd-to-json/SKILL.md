---
name: convert-prd-to-json
description: >
  Convert a PRD markdown file (issues/{N}/prd.md) into a structured JSON task plan
  (issues/{N}/tasks.json) suitable for autonomous iterative execution. Use this skill
  when you have a PRD and need to convert it into a machine-readable task plan with ordered
  user stories, acceptance criteria, and dependency tracking. Triggers on: "convert prd to json",
  "create task plan from prd", or when the resolve-issue skill delegates task plan creation.
---

# PRD → JSON Converter

## The Job

Read `issues/{ISSUE_NUMBER}/prd.md` and convert it to `issues/{ISSUE_NUMBER}/tasks.json`.

---

## Output Format

```json
{
  "project": "[Project name from package.json or repo name]",
  "issueNumber": {ISSUE_NUMBER},
  "issueUrl": "https://github.com/{owner}/{repo}/issues/{ISSUE_NUMBER}",
  "branchName": "<branch, following the repository's convention>",
  "description": "[Feature description from PRD intro]",
  "issueStatus": "pending",
  "completedAt": null,
  "lastAttemptAt": null,
  "lastError": null,
  "correctionCycle": 0,
  "maxCorrectionCycles": 3,
  "lastReviewFindings": null,
  "pipeline": {
    "prdCompleted": false,
    "jsonCompleted": false,
    "executionCompleted": false,
    "reviewCompleted": false,
    "prCreated": false
  },
  "userStories": [
    {
      "id": "US-001",
      "title": "[Story title]",
      "description": "As a [user], I want [feature] so that [benefit]",
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

---

## Conversion Rules

1. **Each user story from the PRD becomes one JSON entry**
2. **IDs**: Sequential (US-001, US-002, …)
3. **Priority**: Based on dependency order, then document order (1 = highest priority, executed first)
4. **All stories start with**: `"passes": false` and `"notes": ""`
5. **branchName**: Use the branch created in Phase 2 of the main skill (current branch name).
   When creating one, follow the repository's convention rather than assuming
   Issue Flow's default:

   ```bash
   issue-flow policy --json 2>/dev/null | jq -r '.git.branchConvention // "issue/{N}-{slug}"'
   ```
6. **Always verify**: Every story has "Typecheck passes" as the last acceptance criterion
7. **Always verify**: UI stories have "Verify in browser using playwright-cli if available; otherwise use the playwright MCP/skill" as acceptance criterion
8. **Initialize issue execution state**: `"issueStatus": "pending"`, `"completedAt": null`, `"lastAttemptAt": null`, `"lastError": null`
9. **Initialize pipeline tracking**: `"correctionCycle": 0`, `"maxCorrectionCycles": 3`, `"lastReviewFindings": null`, and `"pipeline"` object with all flags set to `false`. The pipeline object tracks which phases of the resolve-issue orchestrator have completed, enabling resumption from any point. `lastReviewFindings` holds the verbatim findings of the most recent failed review; non-null means the execute phase must address them before the orchestrator will accept a `<promise>COMPLETE</promise>` signal, even if every story already passes.
10. **Set `pipeline.jsonCompleted` to `true`** immediately after writing tasks.json, since this conversion step itself is the JSON completion phase.

---

## Story Size Validation

Before writing the JSON, validate each story:

**Flag stories that are too big (need splitting):**
- Cannot be described in 2-3 sentences
- Touches more than one distinct layer (e.g., database + UI in the same story)
- Acceptance criteria list is longer than 6-7 items

If you find oversized stories, **split them** before writing the JSON. Follow the naming convention:
- Original: "Add user notification system" (too big)
- Split into: US-001: Add notifications table, US-002: Create notification service, US-003: Add bell icon to header, US-004: Create dropdown panel, US-005: Mark-as-read functionality

---

## Dependency Order Validation

Verify stories are ordered correctly:
1. Schema/migration changes → first
2. Backend/API logic → second
3. UI components → third
4. Integration/summary views → last

If the order is wrong, reorder and renumber.

---

## Example

**Input PRD snippet:**
```markdown
### US-001: Add status field to tasks table
**Description:** As a developer, I need to store task status in the database.
**Acceptance Criteria:**
- [ ] Add status column: 'pending' | 'in_progress' | 'done' (default 'pending')
- [ ] Generate and run migration successfully
- [ ] Typecheck passes
```

**Output JSON entry:**
```json
{
  "id": "US-001",
  "title": "Add status field to tasks table",
  "description": "As a developer, I need to store task status in the database.",
  "acceptanceCriteria": [
    "Add status column: 'pending' | 'in_progress' | 'done' (default 'pending')",
    "Generate and run migration successfully",
    "Typecheck passes"
  ],
  "priority": 1,
  "passes": false,
  "notes": ""
}
```

---

## Archive Check

Before writing `issues/{ISSUE_NUMBER}/tasks.json`, check if one already exists from a **different feature** (different `branchName`):

1. Read existing file if present
2. Compare `branchName` fields
3. If different AND there's content in the progress log:
   - Archive the stale execution artifacts that still belong to the previous branch/feature: `mkdir -p issues/{ISSUE_NUMBER}/archive && cp -f issues/{ISSUE_NUMBER}/tasks.json issues/{ISSUE_NUMBER}/progress.txt issues/{ISSUE_NUMBER}/archive/ 2>/dev/null || true`
   - Remove the stale progress log so the new execution starts clean: `rm -f issues/{ISSUE_NUMBER}/progress.txt`

---

## Output

Save to `issues/{ISSUE_NUMBER}/tasks.json`.

After saving, print a summary for the user:
```
✅ Task plan created: issues/{ISSUE_NUMBER}/tasks.json

{N} user stories:
  US-001 (priority 1): [title]
  US-002 (priority 2): [title]
  ...

Stories with browser verification: US-002, US-003
Estimated complexity: Medium
```

---

## Checklist Before Saving

- [ ] All stories have `"passes": false`
- [ ] All stories have `"notes": ""`
- [ ] `issueStatus` is `"pending"`
- [ ] `completedAt`, `lastAttemptAt`, and `lastError` are `null`
- [ ] `correctionCycle` is `0`
- [ ] `maxCorrectionCycles` is `3`
- [ ] `lastReviewFindings` is `null`
- [ ] `pipeline` object present with `jsonCompleted` set to `true` and all other flags set to `false`
- [ ] Stories ordered by dependency (schema → backend → UI)
- [ ] Every story has "Typecheck passes" as a criterion
- [ ] UI stories have browser verification criterion
- [ ] No story depends on a later story
- [ ] Oversized stories were split
- [ ] branchName matches the current git branch

---

## IMPORTANT: Return Control to Calling Skill

After printing the summary, your work is done. Do NOT present any decision to the user. The calling skill (resolve-issue) has a mandatory user decision gate (Step 2c) that MUST run next.

Your final output line must be exactly:
⏭️ Returning to resolve-issue for user confirmation.
