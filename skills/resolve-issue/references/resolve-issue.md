# Resolve an issue end to end

This workflow runs in the current coding agent. Each phase below is a bundled procedure; load it on demand and perform it directly. No sibling Skill, subagent API, plugin, MCP server or external orchestration engine is required. Installing individual Skills remains useful for invoking just one phase.

Read issue-input and repository-policy. Resolve origin once and pass the same issue context, branch and artifact paths to all phases. Respect explicit local/GitHub selection. A request merely to analyze or review does not activate this whole workflow.

Modes: auto (default) continues through the authorized flow; manual produces PRD and plan and stops before implementation. --pr-review requests the final whole-PR review. Honor a request to work locally without publication. Auto does not override permissions, authorization, material ambiguity or irreversible-action boundaries.

## Resume and plan

Inspect git status, branch, local PRD, tasks, progress, review findings and recorded PR. Validate an existing plan. Missing legacy flags start false; verify claimed phases against their artifacts and Git evidence. Resume the earliest incomplete phase, including missing PRD/JSON and requested PR review after PR creation. Never treat prCreated alone as completion. A new manual invocation stays in planning even if old work exists; it does not resume execution.

Reuse an existing intended branch; otherwise resolve the actual base and create a branch using the bundled conventions helper. Preserve unrelated dirty work. Do not pull, reset or overwrite a branch blindly. For planning-only manual use, record an intended branch without requiring a checkout. Archive/restart requires explicit authorization and a fresh archive destination.

Load generate-prd and convert-prd-to-json procedures. Set flags only after artifacts exist and validate. Analysis is optional when scope needs separate investigation; it is not a mandatory phase. Manual mode returns artifact paths, intended branch and unresolved decisions here.

## Implement, review and correct

Load execute-tasks with the plan and pending findings; keep issueStatus=in_progress until the entire requested flow finishes. After execution's verified completion load review-issue in --orchestrator mode, which must not publish or close anything. Read the structured result; missing/malformed output fails the review.

On FAIL, persist findings in review-findings.md and lastReviewFindings, including GENERAL findings. Before any correction, validate each finding against requirements/code. Record evidence for rejected findings and pass it to the next review. For valid findings, reset affected stories, invalidate execution/review flags and clear completedAt. General findings must be resolved even when no story ID is present.

If correctionCycle has reached maxCorrectionCycles (default 3), stop with preserved work and actionable blockers. Otherwise increment once per attempted correction round, run execution, then re-review. Clear lastReviewFindings only when addressed/rejected with evidence and the fresh review passes. A completion signal alone never bypasses unresolved findings.

## Deliver

After PASS, load create-pr only if publication is part of the authorized flow. Persist a confirmed pullRequest {number,url,headBranch,createdAt}; set prCreated only after remote confirmation. If a PR is required but unavailable, report a blocked publication rather than calling the full flow complete.

When --pr-review was requested, load review-pr after creation (or against the recorded PR on resume). Persist its report. REQUEST_CHANGES or malformed output leaves prReviewCompleted=false and the overall plan incomplete. Return blockers; do not close the issue. APPROVE/APPROVE_WITH_SUGGESTIONS marks that phase complete.

A verified local-only flow may complete without a PR, with prCreated=false and that choice recorded in progress. A published PR does not independently authorize immediate issue closure. Follow the user's explicit closure request, otherwise let the PR's authorized issue reference govern closure on merge. Local metadata closes only when requested.

Finally set issueStatus=completed, completedAt/lastAttemptAt and clear lastError only when every requested phase is complete. Return branch, artifacts, verified stories, correction rounds, PR if any and material limits. This conversational resumption does not provide transactional locks or an independently isolated reviewer; the CLI remains the surface for those runtime guarantees.
