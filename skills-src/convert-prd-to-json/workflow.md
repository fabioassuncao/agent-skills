# Convert requirements to a task plan

Read execution-options, the supplied PRD and plan-format. Resolve default input/output through `scripts/artifacts.mjs resolve <id> --json`; use `paths.prdFile` and `paths.tasksFile`. Resolve explicit paths against the consumer project. If no PRD is supplied or discoverable, ask for it; do not invent the demand.

Inspect an existing plan and progress log before writing. Preserve existing IDs and verified state for unchanged stories. Allocate new IDs above the maximum in local project plans. Do not reset execution or archive a different branch's work without authorization. A fresh plan starts pending with all new stories passes=false.

Translate each story into the canonical plan format with observable criteria and dependencies. Flag substantive ambiguities; split oversized stories only where the PRD supports the split. Carry the accepted choices from the PRD/request. For a fresh current-mode plan capture the attached current branch as branchName and set noBranch=true; retain an existing plan's recorded branch on resume instead of silently recapturing it; in new mode preserve the agreed intended branch and set noBranch=false. Apply the resumption/rebinding rules in execution-options to an existing plan. This conversion never switches or creates a branch.

Set pipeline.prdCompleted=true only after confirming the PRD exists; set jsonCompleted=true after writing and validating the plan. Other new phase flags start false. Run the bundled artifacts helper in plan mode. On validation failure repair the plan before reporting it ready. Reconcile the issue after the final valid write so the CLI sees the same state.

Return plan path, story IDs/priorities, checks required and remaining uncertainties. Standalone use ends here. When called as a phase, return the same artifact/result to the caller; no special tool or mandatory return message is required.
