# Execute a task plan

Read plan-format, repository-policy and evidence. Locate the explicit plan or issues/<id>/tasks.json. Read the PRD, append-only progress log and lastReviewFindings. Validate the plan using the artifacts helper. Inspect git status and the current branch. Preserve unrelated work; do not silently switch away from a dirty tree or replace branchName.

For each iteration:

1. Choose the highest-priority unpassed story whose dependencies are satisfied. If pending findings exist, investigate them even when every story passes. Read the code and validate findings technically before changing it.
2. Implement the requested behavior following project conventions. For bugs, reproduce the defect where feasible. Do not reduce acceptance criteria simply to make checks pass.
3. Run relevant checks after the final change, including required browser verification using available capabilities. A missing required check remains unverified; record the blocker instead of marking passes=true.
4. Stage only files belonging to the story and commit after checks pass, using repository conventions and the bundled naming helper as needed. Preserve unrelated user changes.
5. Mark the verified story passes=true, append evidence to notes/progress.txt and update lastAttemptAt. Append a log entry with timestamp, story ID, changes, files, commands/results and useful learnings. Keep reusable patterns at the top without replacing prior entries.
6. Continue immediately to the next eligible story within the authorized task. On a persistent check failure, unavailable capability, dependency cycle or material scope ambiguity, preserve work, set lastError with category/message/at and report the blocker.

Put durable repository knowledge in its existing documentation and link it from AGENTS.md only when appropriate. Do not create duplicate instruction files or append transient story notes to them.

Only when every story is verified and lastReviewFindings has been addressed may executionCompleted become true. Keep issueStatus=in_progress and completedAt=null when called by an orchestrator with remaining phases. Standalone execution may set completed and timestamp. Completion uses the bundled completion-signal reference; never emit it while a required check or finding is unresolved.
