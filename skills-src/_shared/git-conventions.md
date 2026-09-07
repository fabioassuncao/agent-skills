# Git names and issue references

Read when creating a branch, commit or PR title. Read execution-options for the accepted branch/commit strategy and repository-policy for convention discovery. Follow explicit invocation choices and then project conventions. The bundled `scripts/conventions.mjs` computes Issue Flow defaults from the same implementation as the CLI. It reads JSON from stdin and prints JSON; it never runs Git.

Operations and input examples:

```json
{"operation":"changeType","input":{"labels":["bug"],"typeMap":null}}
{"operation":"branch","input":{"type":"fix","issueNumber":42,"title":"Login fails"}}
{"operation":"commit","input":{"type":"fix","subject":"Handle expired sessions","issueNumber":42}}
{"operation":"commit","input":{"format":"free","type":"fix","subject":"Handle expired sessions"}}
{"operation":"prTitle","input":{"type":"fix","subject":"Handle expired sessions"}}
{"operation":"parseBranch","input":"fix/42-login-fails"}
{"operation":"convention","input":{"declared":true,"commitConvention":"conventional","allowedTypes":["feat","fix"]}}
{"operation":"defaults","input":{}}
```

The change type comes from two rungs: a type the project declares — directly, or through a label in `typeMap` overlaying the default map — and otherwise `feat`. A project's own Issue Type name or a `[Bug]` title prefix is not translated into a type; when the project wants that mapping it declares it. Use `convention` to resolve `commit.format`, `commit.types` and the PR title format from the discovered project conventions: only a `declared` source replaces the Issue Flow fallback, and `types: "any"` means the project's own vocabulary governs. Commit messages carry no `Story:` trailer; story traceability lives in progress, not in the message.

For a declared branch convention pass convention with placeholders {type}, {N}, {slug}. Use issueNumber only for a verified numeric issue; nonnumeric local identifiers can be part of the subject/slug. GitHub issue footers require a real GitHub reference, not merely a numeric local directory. Never use a provider/model as a type or scope.

Issue Flow fallback commit footers use Refs rather than Closes; a completed GitHub demand may use Closes in the PR body. Incomplete work uses Refs. Containers close only when every child is complete. Local-only work cites its repository-relative file path.

Preserve an existing branchName except for an explicitly authorized pending-plan reassociation under execution-options. A legacy issue/N-slug branch or a repository-specific pattern is not an error. Warn on a naming divergence and continue unless a declared mandatory constraint prevents the operation. Validate a newly computed name with git check-ref-format --branch before using it.

Stage only files belonging to the change. Never force-push or discard unrelated work. Inspect status before switching branches. Obtain authorization for publication from the request/session; do not repeatedly ask for already-authorized actions.

## Branch checkout contract

Before implementation, inspect status, the current symbolic branch and any merge/rebase/cherry-pick or unresolved conflicts. An unresolved Git operation blocks execution. Preserve unrelated files and staged changes; stage only the requested work. A branch-name preference alone does not forbid an explicitly requested current branch, including the default branch. An actual mandatory project restriction must be reported.

- current: for a fresh plan capture the attached branch at invocation; persist branchName and noBranch=true. On resume compare the checkout with the recorded branchName before any reassociation; never overwrite it merely because the invocation started elsewhere. All phases, correction rounds and commits stay there. Never create, checkout, switch or use another worktree to move the run elsewhere. Detached HEAD or a later mismatch blocks; it never triggers a branch repair. No base is needed merely to implement locally. A missing branch cannot be created implicitly in this mode.
- new: preserve the dedicated planned branch on resume. If it exists and is not current, switch to it safely; if already current, retain it. If it does not exist, create it from the actual base resolved by repository-policy. Do not create a branch from unrelated issue commits. A planned branch equal to the default/base is not a dedicated branch: resolve a dedicated name or obtain an explicit current choice before implementation. Validate a new name with git check-ref-format --branch. Missing base, unrelated dirty work that would be carried across branches, or a failed switch blocks before edits. Do not force, stash, reset or pull as an automatic repair.

Manual planning and standalone conversion record the decision without switching/creating branches. Execution must verify the checkout matches branchName before its first implementation edit and recheck before every commit. Related planning artifacts may be retained during a safe switch, but unrelated work must not be silently carried to another branch. In current mode a PR is possible only with explicit publication authorization and a valid head distinct from base/default; never change branches to make delivery possible.

## Commit message strategy

- auto: follow the discovered project convention. Use the Issue Flow fallback when no convention is established; silence about optional message elements is not permission to add Issue Flow trailers to a custom project format.
- project: require a clear applicable project convention, including a consistently established one. If absent or materially ambiguous, preserve the work and ask for the rule before committing; do not silently fall back.
- issue-flow: explicitly use the bundled default commit operation. This choice affects commit formatting, not the project's branch or PR conventions.

An explicit concrete message rule or example in the invocation takes priority over these strategies. Apply the chosen convention to header, body, language, references and trailers. The bundled commit operation renders Issue Flow's Conventional Commit format, or passes a message through untouched with `format: "free"`; it is not a general renderer for project formats. Compose custom messages directly from the discovered rule and never impose a Conventional Commit header automatically. Keep story/source traceability in progress when the project's messages do not carry it. Only reference genuine GitHub issues remotely; local work cites its source path when references are appropriate.

Respect signing, signoff and commit hooks. A conflicting mandatory hook blocks the commit; never bypass it to force the selected format. Do not add a closure reference unless closure is authorized. Record the chosen strategy and its evidence with execution choices so later phases review commits against that choice rather than reimposing the fallback.
