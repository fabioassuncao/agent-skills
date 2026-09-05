# Optional CLI integration

Read only when an installed Issue Flow CLI can help resolve repository policy or scaffold planning. It is never a prerequisite and must never be downloaded by the Skill.

When Node is available, run the bundled `scripts/optional-cli.mjs` with `policy <scope>` or `init <scope>` from the consumer repository. Scope is the repository-relative current directory (empty at root). The script bounds the call to five seconds and returns JSON null on unavailable, failed, malformed or unsupported output. It does not write files or install anything.

Its read-only calls are `issue-flow policy --json --scope <scope>` and `issue-flow init --json`. A valid policy schemaVersion 1 may enrich issues.templates, issues.types, issues.labels, issues.allowLabelCreation, issues.titleConvention, pullRequests.template, pullRequests.baseBranch, git.branchConvention, git.commitConvention, git.pullRequestTitleConvention, git.issueReference, git.typeMap, git.allowedTypes, git.scopes, docs and codeowners. Unknown fields are ignored. Check required fields before consuming them. Preserve monorepo scope on every path.

If Node or the CLI is missing, the result is null, enabled is false, or an individual field is unavailable, follow the direct repository-discovery procedure. Never treat an unavailable query as proof that a convention does not exist.

The init payload's actions have path, kind (create/keep/review), tier and reason. Review them against the current filesystem. Prefer the Skill's non-destructive application of approved missing files. An explicitly requested `issue-flow init --apply` is an optional alternative; retain existing authorization and never use it to bypass reviewing a conflicting convention.

`issue-flow conventions` is also optional: bundled conventions scripts already execute the same pure naming code without the CLI. Do not launch another coding agent or use the CLI agent selection to replace the agent currently running the Skill.

Persistent run/resume, sessions, SQLite, locks, telemetry and lifecycle controls belong to the CLI. Skill artifacts under issues/ do not constitute a CLI session. Do not edit the CLI's database, projections or session files, and do not promise cross-surface resume. Use the CLI as a separately selected surface when its runtime is needed.
