# Review issue resolution

Read execution-options and apply relevant accepted choices without activating implementation or publication. Read issue-input, repository-policy, evidence and issue-review-result. Accept local/GitHub/supplied content without requiring another Skill. Determine requirements from the actual issue and relevant decisions; do not assume resolution from a closed issue or merged PR.

Inspect relevant implementation, callers, changes and regression risks. Discover checks from the repository and run those necessary to verify acceptance on the reviewed revision. Map each requirement to code and fresh evidence. Distinguish unmet and unverified criteria. Cite declared policy behind conformance findings; personal preferences do not block.

Produce the report and final structured result from issue-review-result. A failed required check or incomplete verification produces FAIL, with actionable findings. Do not modify implementation while reviewing.

By default return the report in the conversation. Save it if requested or when the caller supplied a report path. Reviewing alone never authorizes comments or closure. Only when the request/session explicitly includes closing or commenting, follow publication, verify the result first and perform the authorized action. --orchestrator means report only, leaving publication and state transitions to the caller.
