# Create a Pull Request

Read repository-policy, git-conventions and publication. Publication must be included in the request/session. Read branch/status; detached HEAD and the actual default branch require choosing an appropriate working branch before publication.

Resolve the target repository, head and base before collecting the diff. Take an explicit issue first, otherwise use plan context, the declared/legacy branch convention or Refs/Closes/Fixes footers. Missing issue linkage is allowed; ask only when needed to avoid a wrong association. Local numeric IDs are not GitHub issue numbers.

Gather optional PRD/tasks and verified issue context plus git log base..HEAD and git diff base...HEAD. Build a concrete body following the repository PR template; without one use summary, changes and test evidence, plus limitations. Do not claim unchecked criteria passed. Use a descriptive conventional title from the naming helper when no convention is declared.

Query open PRs for the head branch before creating. If one exists reuse it. Continue any authorized push needed to bring its head up to date; update its title/body only when requested. Return its URL after checking the remote head. Do not offer automatic closure/recreation as a normal retry. Recheck before retrying an ambiguous API result.

Inspect whether the local branch is ahead of the remote, including when a remote branch already exists. Push authorized commits normally (never force); create a PR with explicit base and head only when no matching PR exists. With gh use pr create --title <title> --body-file <file> --base <base> --head <head>, adding only known existing labels. An empty diff should be reported rather than published accidentally.

Use Closes only for verified completed GitHub issues; Refs for partial work and containers with incomplete children. Cite a local issue path for local-only demand. Preserve the body file on failure. Return the confirmed PR URL and any material publishing limitation. If called by the orchestrator, return PR number, URL, head branch and creation time for plan persistence.
