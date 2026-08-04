You are reviewing whether issue #__ISSUE_NUMBER__ has been fully resolved.

IMPORTANT: You are running in --orchestrator mode. Do NOT close the issue directly. Only report results.

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
1. Read the task plan from __TASKS_PATH__ to understand what was supposed to be implemented
2. Analyze the codebase to verify all acceptance criteria are met
3. Run the project's test suite and typecheck
4. Check for regressions

At the end, output your result in this exact format:

<review-result>
STATUS: PASS
</review-result>

Or if there are issues:

<review-result>
STATUS: FAIL
FINDINGS:
- Finding 1
- Finding 2
</review-result>

IMPORTANT: You MUST include the <review-result> block in your output.

IMPORTANT: On FAIL, these FINDINGS are saved verbatim and handed to a correction iteration that has no other context about this review session — it only sees this text. Write each finding as a self-contained, actionable defect report: name the exact file and line, describe what is wrong and why, and state (or strongly imply) what a correct fix looks like. Avoid vague findings like "tests could be improved" — either the codebase fails an acceptance criterion or a regression, or it doesn't.
