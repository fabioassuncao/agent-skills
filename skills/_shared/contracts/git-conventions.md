# Git conventions: branches, commits and Pull Request titles

The naming below is the **default**. When the repository declares its own
convention — in `AGENTS.md`, in a commitlint or release-please config, or
resolved for you by `issue-flow policy --json` — that one wins.

These names are a function of the issue and the repository, never of which agent
ran the phase. A provider name (`claude`, `codex`, `cursor`, `antigravity`) may
appear in a commit **subject** when it is the topic of the change
(`feat(agents): add Cursor CLI runner`). It must never appear as the **type** or
the **scope**: that would record the executor, not the change.

## Branches

Default pattern: `{type}/{N}-{slug}`

| Situation | Result |
|---|---|
| Issue #63, feature | `feat/63-autonomous-resilient-execution` |
| Issue #72, bug | `fix/72-headless-timeout` |
| No associated issue | `{type}/{slug}` |
| Empty slug | `{type}/{N}` |

`style` and `revert` are valid commit types but are not used as branch prefixes.

Resolve the type with this ladder, stopping at the first that answers:

1. a declared branch convention (its format string);
2. the native Issue Type, when the repository has them;
3. the issue's labels;
4. a textual title prefix such as `[Bug]` or `[Enhancement]`;
5. `feat`, as an explicit fallback.

`issue/{N}-*` is still recognised when extracting a number from a branch, so
existing branches are never renamed and a resumed run keeps the `branchName`
already recorded in its plan.

When the Issue Flow CLI is available it computes this deterministically:

```bash
issue-flow conventions branch --issue 63
```

Use it when it is there; derive the name from the ladder above when it is not.
Both produce the same answer — the CLI just cannot get the slug wrong.

## Commits

```text
<type>(<scope>)[!]: <subject>

Refs #N
Story: US-010
```

- Vocabulary: `feat` `fix` `docs` `refactor` `perf` `test` `build` `ci` `chore`
  `style` `revert`
- One commit, one type.
- Footers use `Refs`, never `Closes` — a commit that closes an issue on merge
  takes that decision away from the Pull Request.

```bash
issue-flow conventions commit --type fix --scope runner --subject "recover created PR"
```

## Pull Request titles

Title: `<type>(<scope>): <subject>` — so that a GitHub squash-merge produces a
Conventional Commit.

A Pull Request consolidating several stories takes the highest-impact type
(`feat` > `fix` > everything else) and drops the scope when the set is mixed.

Reference lines are deterministic:

| Condition | Line |
|---|---|
| Every story passing and no outstanding review findings | `Closes #N` |
| Partial delivery | `Refs #N` |
| Container issue whose children all closed | `Closes #N` |
| Container issue with pending children | `Refs #N` |

A repository `PULL_REQUEST_TEMPLATE` still governs the **body**; this section
governs only the title and the reference line.

```bash
issue-flow conventions pr-title --issue 63
```

## When the repository declares something else

`commitlint`, `release-please`, `semantic-release`, Changesets,
`amannn/action-semantic-pull-request` and `.husky/commit-msg` are all evidence
that the repository already decided. Follow what they enforce rather than the
defaults above, and never execute a JavaScript config to find out — read it as
text.
