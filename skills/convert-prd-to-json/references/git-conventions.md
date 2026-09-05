# Git names and issue references

Read when creating a branch, commit or PR title. Follow declared conventions first. The bundled `scripts/conventions.mjs` computes Issue Flow defaults from the same implementation as the CLI. It reads JSON from stdin and prints JSON; it never runs Git.

Operations and input examples:

```json
{"operation":"changeType","input":{"issueType":"Bug","labels":[],"title":"Login fails"}}
{"operation":"branch","input":{"type":"fix","issueNumber":42,"title":"Login fails"}}
{"operation":"commit","input":{"type":"fix","subject":"Handle expired sessions","issueNumber":42,"storyId":"US-001"}}
{"operation":"prTitle","input":{"type":"fix","subject":"Handle expired sessions"}}
{"operation":"parseBranch","input":"fix/42-login-fails"}
{"operation":"defaults","input":{}}
```

For a declared branch convention pass convention with placeholders {type}, {N}, {slug}. Use issueNumber only for a verified numeric issue; nonnumeric local identifiers can be part of the subject/slug. GitHub issue footers require a real GitHub reference, not merely a numeric local directory. Never use a provider/model as a type or scope.

Commit footers use Refs rather than Closes; a completed GitHub demand may use Closes in the PR body. Incomplete work uses Refs. Containers close only when every child is complete. Local-only work cites its repository-relative file path.

Preserve an existing branchName. A legacy issue/N-slug branch or a repository-specific pattern is not an error. Warn on a naming divergence and continue unless a declared mandatory constraint prevents the operation. Validate a newly computed name with git check-ref-format --branch before using it.

Stage only files belonging to the change. Never force-push or discard unrelated work. Inspect status before switching branches. Obtain authorization for publication from the request/session; do not repeatedly ask for already-authorized actions.
